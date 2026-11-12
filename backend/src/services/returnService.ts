import crypto from 'node:crypto';
import { config } from '../config/env.js';
import {
  BusinessRepository,
  defaultTransactionRunner,
  MongooseBusinessRepository,
  MongooseOrderRepository,
  MongoosePackageRepository,
  OrderRepository,
  PackageRepository,
  PaginatedResult,
} from '../repositories/phase2Repositories.js';
import {
  MongooseTransactionRepository,
  TransactionDto,
  TransactionRepository,
} from '../repositories/phase3Repositories.js';
import {
  MongoosePassportRepository,
  PassportRepository,
} from '../repositories/phase4Repositories.js';
import {
  MongooseRefundRepository,
  MongooseReturnRepository,
  RefundDto,
  RefundRepository,
  ReturnDto,
  ReturnRepository,
} from '../repositories/phase5Repositories.js';
import {
  canInitiateRefundFromReturn,
} from '../stateMachines/gates.js';
import {
  packageStateMachine,
  paymentStateMachine,
  returnStateMachine,
} from '../stateMachines/machines.js';
import {
  AuthPrincipal,
  InspectionCondition,
  PackageStatus,
  PaymentStatus,
  ReturnMode,
  ReturnStatus,
} from '../types/domain.js';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  serviceUnavailable,
  unauthorized,
} from '../utils/errors.js';
import { AuditWriter, defaultAuditWriter } from './auditService.js';
import { TransactionRunner } from './businessService.js';
import {
  EvidenceStorage,
  GridFsEvidenceStorage,
  RetrievedEvidenceFile,
} from './evidenceStorage.js';
import {
  PayPalClient,
  PayPalClientError,
  PayPalRefundResponse,
  RestPayPalClient,
} from './paypalClient.js';
import { defaultQrService, QrService } from './qrService.js';
import {
  calculateReturnRefund,
  InspectionChecklistInput,
} from './refundCalculation.js';

export interface InitiateReturnInput {
  orderId: string;
  packageId: string;
  mode: ReturnMode;
  reason?: string;
  dropoffLocationLabel?: string;
  pickupWindowStart?: string;
  pickupWindowEnd?: string;
  serviceZone?: string;
  addressSummary?: string;
  swapOrderNumber?: string;
}

export interface ReturnQrActionInput {
  scanMode?: 'QR_TOKEN' | 'MANUAL_SUPERVISED';
  qrToken?: string;
  scanId?: string;
  locationRef?: string;
  notes?: string;
  manualReason?: string;
}

export interface InspectReturnInput {
  condition: InspectionCondition;
  checklist: InspectionChecklistInput;
  damageReason?: string;
  notes?: string;
  disputed?: boolean;
  disputeReason?: string;
  // Forbidden client-supplied financial overrides (verified absent/rejected)
  refundAmount?: unknown;
  amount?: unknown;
  calculatedAmount?: unknown;
}

export interface ApproveReturnInput {
  reason?: string;
  // Forbidden client-supplied financial overrides (verified absent/rejected)
  refundAmount?: unknown;
  amount?: unknown;
  calculatedAmount?: unknown;
}

export interface ApproveReturnResult {
  returnRecord: ReturnDto;
  refund: RefundDto | null;
  transaction: TransactionDto | null;
  pending: boolean;
  alreadyRefunded: boolean;
  zeroRefundApproved: boolean;
  message: string;
}

function generateReturnNumber(): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `RET-${stamp}-${rand}`;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export class ReturnService {
  constructor(
    private readonly returns: ReturnRepository = new MongooseReturnRepository(),
    private readonly refunds: RefundRepository = new MongooseRefundRepository(),
    private readonly orders: OrderRepository = new MongooseOrderRepository(),
    private readonly packages: PackageRepository = new MongoosePackageRepository(),
    private readonly businesses: BusinessRepository = new MongooseBusinessRepository(),
    private readonly transactions: TransactionRepository = new MongooseTransactionRepository(),
    private readonly passportRepo: PassportRepository = new MongoosePassportRepository(),
    private readonly paypal: PayPalClient = new RestPayPalClient(),
    private readonly evidence: EvidenceStorage = new GridFsEvidenceStorage(),
    private readonly qr: QrService = defaultQrService,
    private readonly audit: AuditWriter = defaultAuditWriter,
    private readonly runTx: TransactionRunner = defaultTransactionRunner
  ) {}

  private assertReturnAccess(caller: AuthPrincipal, ret: ReturnDto): void {
    if (caller.role === 'ADMIN' || caller.role === 'COLLECTION_CENTRE') return;
    if (caller.role === 'CUSTOMER') {
      if (ret.customerId !== caller.userId) {
        throw forbidden('Customers can only access their own return records.');
      }
      return;
    }
    if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      if (!caller.businessId || ret.merchantId !== caller.businessId) {
        throw forbidden('Cross-tenant access to another merchant return is prohibited.');
      }
      return;
    }
    if (caller.role === 'DELIVERY_PARTNER') {
      if (ret.assignedPartnerUserId !== caller.userId) {
        throw forbidden('Delivery partner is not assigned to this return.');
      }
      return;
    }
    throw forbidden('Unauthorized role for return access.');
  }

  private assertNoClientRefundOverride(body: {
    refundAmount?: unknown;
    amount?: unknown;
    calculatedAmount?: unknown;
  }): void {
    if (
      body.refundAmount !== undefined ||
      body.amount !== undefined ||
      body.calculatedAmount !== undefined
    ) {
      throw new AppError(
        400,
        'CLIENT_REFUND_AMOUNT_FORBIDDEN',
        'Refund amounts are calculated exclusively on the backend and cannot be supplied by the client.'
      );
    }
  }

  async initiateReturn(
    input: InitiateReturnInput,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<ReturnDto> {
    if (
      caller.role !== 'CUSTOMER' &&
      caller.role !== 'MERCHANT_ADMIN' &&
      caller.role !== 'MERCHANT_STAFF' &&
      caller.role !== 'ADMIN'
    ) {
      throw forbidden('Only customers, merchants on behalf, or admins may initiate returns.');
    }

    const order = await this.orders.findById(input.orderId.trim());
    if (!order) {
      throw notFound('Order not found.');
    }

    if (caller.role === 'CUSTOMER' && order.customerId !== caller.userId) {
      throw forbidden('You can only request returns for your own orders.');
    }
    if (
      (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') &&
      order.merchantId !== caller.businessId
    ) {
      throw forbidden('Cannot initiate return for another merchant order.');
    }

    if (order.status !== 'DELIVERED') {
      throw conflict(
        `Returns can only be initiated for DELIVERED orders (current order status: ${order.status}).`,
        'ORDER_NOT_DELIVERED'
      );
    }

    const normalizedPkgId = input.packageId.trim().toUpperCase();
    const allocatedItem = order.allocatedPackages.find(
      (p) => p.packageId.toUpperCase() === normalizedPkgId
    );
    if (!allocatedItem) {
      throw badRequest(
        `Package ${normalizedPkgId} is not allocated to order ${order.orderNumber}.`
      );
    }

    const existingReturn = await this.returns.findByOrderAndPackage(order.id, normalizedPkgId);
    if (existingReturn) {
      throw conflict(
        `A return (${existingReturn.returnNumber}) already exists for package ${normalizedPkgId} on order ${order.orderNumber}.`,
        'DUPLICATE_RETURN_REQUEST'
      );
    }

    const pkg = await this.packages.findByPackageId(normalizedPkgId);
    if (!pkg) {
      throw notFound(`Package ${normalizedPkgId} not found.`);
    }

    const pkgTransition = packageStateMachine.validateTransition(pkg.status, 'RETURN_REQUESTED');
    if (!pkgTransition.allowed) {
      throw conflict(
        pkgTransition.reason ?? `Package ${pkg.packageId} in status ${pkg.status} is not eligible for return.`,
        'INVALID_PACKAGE_STATUS'
      );
    }

    const activeTx =
      (await this.transactions.findActiveByOrderId(order.id)) ??
      (await this.transactions.findLatestByOrderId(order.id));
    if (
      !activeTx ||
      !['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUND_REQUESTED', 'REFUND_PENDING'].includes(
        activeTx.state
      )
    ) {
      throw conflict(
        'Cannot initiate deposit return without a captured payment transaction.',
        'PAYMENT_NOT_CAPTURED'
      );
    }

    const depositAlloc = activeTx.depositAllocations.find(
      (a) => a.packageId.toUpperCase() === normalizedPkgId
    );
    const originalDeposit = depositAlloc?.allocatedDeposit ?? allocatedItem.depositAmount;

    const now = new Date();
    const deadline = order.returnDeadlineAt ? new Date(order.returnDeadlineAt) : undefined;
    const isLateReturn = Boolean(deadline && now.getTime() > deadline.getTime());
    const daysLate =
      isLateReturn && deadline
        ? Math.max(1, Math.ceil((now.getTime() - deadline.getTime()) / (24 * 60 * 60 * 1000)))
        : 0;

    let initialStatus: ReturnStatus;
    let pickupRequest:
      | { serviceZone: string; addressSummary: string; slotStart: Date; slotEnd: Date }
      | undefined;

    if (input.mode === 'DROP_OFF') {
      if (!input.dropoffLocationLabel?.trim()) {
        throw badRequest('Drop-off location or locker label is required for DROP_OFF returns.');
      }
      initialStatus = 'DROP_OFF_SELECTED';
    } else if (input.mode === 'PICKUP') {
      const start = input.pickupWindowStart ? new Date(input.pickupWindowStart) : new Date(now.getTime() + 24 * 3600 * 1000);
      const end = input.pickupWindowEnd ? new Date(input.pickupWindowEnd) : new Date(start.getTime() + 2 * 3600 * 1000);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
        throw badRequest('Valid pickupWindowStart and pickupWindowEnd are required for PICKUP.');
      }
      initialStatus = 'PICKUP_SCHEDULED';
      pickupRequest = {
        serviceZone: input.serviceZone?.trim() || order.shippingReference.zone,
        addressSummary: input.addressSummary?.trim() || order.shippingReference.addressLine,
        slotStart: start,
        slotEnd: end,
      };
    } else {
      // NEXT_DELIVERY_SWAP
      initialStatus = 'PICKUP_SCHEDULED';
      const slotStart = new Date(now.getTime() + 24 * 3600 * 1000);
      pickupRequest = {
        serviceZone: input.serviceZone?.trim() || order.shippingReference.zone,
        addressSummary: input.addressSummary?.trim() || order.shippingReference.addressLine,
        slotStart,
        slotEnd: new Date(slotStart.getTime() + 2 * 3600 * 1000),
      };
    }

    // Validate requested -> mode status through returnStateMachine
    const rInitCheck = returnStateMachine.validateTransition('REQUESTED', initialStatus);
    if (!rInitCheck.allowed) {
      throw conflict(rInitCheck.reason ?? 'Invalid initial return mode transition.');
    }

    const returnNumber = generateReturnNumber();
    const created = await this.runTx(async (session) => {
      const res = await this.returns.createReturnWithPackageAtomically(
        {
          returnDoc: {
            returnNumber,
            orderId: order.id,
            packageRef: pkg.id,
            packageId: pkg.packageId,
            merchantId: order.merchantId,
            customerId: order.customerId,
            mode: input.mode,
            returnMethodDetails: {
              dropoffLocationLabel: input.dropoffLocationLabel?.trim(),
              pickupWindowStart: pickupRequest?.slotStart,
              pickupWindowEnd: pickupRequest?.slotEnd,
              serviceZone: pickupRequest?.serviceZone,
              addressSummary: pickupRequest?.addressSummary,
              swapOrderNumber: input.swapOrderNumber?.trim(),
            },
            status: initialStatus,
            reason: input.reason?.trim() || 'Reusable packaging return initiated',
            returnDeadlineAt: deadline,
            isLateReturn,
            daysLate,
            disputed: false,
            evidenceFiles: [],
            refundEligibility: {
              eligible: true,
              reason: isLateReturn
                ? `Late return (${daysLate}d past deadline): subject to policy & inspection review.`
                : 'On-time return requested: refund determined after collection-centre inspection.',
              originalDeposit,
              totalDeductions: 0,
              calculatedAmount: round2(originalDeposit),
              currency: activeTx.currency,
              deductionBreakdown: [],
            },
          },
          expectedPackageStatus: 'WITH_CUSTOMER',
          nextPackageStatus: 'RETURN_REQUESTED',
          pickupRequest,
          event: {
            eventId: `evt_${crypto.randomUUID()}`,
            packageId: pkg.packageId,
            merchantId: order.merchantId,
            type: 'RETURN_REQUESTED',
            actor: { userId: caller.userId, role: caller.role },
            occurredAt: now,
            sourceSystem: 'REBOXIFY_API',
            correlationId: meta?.correlationId ?? order.id,
            locationRef: pkg.fulfilmentLocation,
            outcome: 'ACCEPTED',
            evidence: [],
            metadata: {
              returnNumber,
              mode: input.mode,
              isLateReturn,
              daysLate,
            },
          },
        },
        session
      );
      if (!res) {
        throw conflict('Package status changed concurrently; please refresh and retry.');
      }
      return res;
    });

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'RETURN_INITIATED',
      entityType: 'Return',
      entityId: created.returnRecord.id,
      businessId: created.returnRecord.merchantId,
      afterSummary: {
        returnNumber: created.returnRecord.returnNumber,
        packageId: created.returnRecord.packageId,
        mode: created.returnRecord.mode,
        status: created.returnRecord.status,
        isLateReturn,
      },
      correlationId: meta?.correlationId,
    });

    return created.returnRecord;
  }

  async listReturns(
    params: {
      status?: ReturnStatus;
      mode?: ReturnMode;
      condition?: InspectionCondition;
      refundStatus?: PaymentStatus;
      search?: string;
      merchantId?: string;
      page: number;
      pageSize: number;
      sortBy?: string;
      sortDir?: 'asc' | 'desc';
    },
    caller: AuthPrincipal
  ): Promise<PaginatedResult<ReturnDto>> {
    if (caller.role === 'CUSTOMER') {
      return this.returns.list({ ...params, merchantId: undefined, customerId: caller.userId });
    }
    if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      if (!caller.businessId) {
        throw forbidden('Merchant account is not linked to a business.');
      }
      return this.returns.list({ ...params, merchantId: caller.businessId });
    }
    if (caller.role === 'DELIVERY_PARTNER') {
      return this.returns.list({
        ...params,
        merchantId: undefined,
        assignedPartnerUserId: caller.userId,
      });
    }
    if (caller.role === 'COLLECTION_CENTRE' || caller.role === 'ADMIN') {
      return this.returns.list(params);
    }
    throw forbidden('Unauthorized role for listing returns.');
  }

  async getReturnById(returnId: string, caller: AuthPrincipal): Promise<ReturnDto> {
    const ret = await this.returns.findById(returnId);
    if (!ret) throw notFound('Return record not found.');
    this.assertReturnAccess(caller, ret);
    return ret;
  }

  async getReturnRefund(returnId: string, caller: AuthPrincipal): Promise<RefundDto | null> {
    const ret = await this.returns.findById(returnId);
    if (!ret) throw notFound('Return record not found.');
    this.assertReturnAccess(caller, ret);
    return this.refunds.findByReturnId(ret.id);
  }

  async assignReturnPartner(
    returnId: string,
    partnerUserId: string,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<ReturnDto> {
    if (
      caller.role !== 'MERCHANT_ADMIN' &&
      caller.role !== 'MERCHANT_STAFF' &&
      caller.role !== 'COLLECTION_CENTRE' &&
      caller.role !== 'ADMIN'
    ) {
      throw forbidden('Not authorized to assign delivery partners for returns.');
    }

    const ret = await this.returns.findById(returnId);
    if (!ret) throw notFound('Return record not found.');
    if (
      (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') &&
      ret.merchantId !== caller.businessId
    ) {
      throw forbidden('Cannot assign partner to another merchant return.');
    }

    if (ret.status === 'CLOSED' || ret.status === 'REJECTED') {
      throw conflict(`Cannot assign partner when return is ${ret.status}.`);
    }

    const partner = await this.passportRepo.findUserSummary(partnerUserId.trim());
    if (!partner || partner.role !== 'DELIVERY_PARTNER' || partner.status !== 'ACTIVE') {
      throw badRequest('Target partner must be an ACTIVE DELIVERY_PARTNER.');
    }

    const result = await this.runTx((session) =>
      this.returns.transitionReturnAndPackageAtomically(
        {
          returnId: ret.id,
          expectedReturnStatuses: [ret.status],
          returnSet: {
            assignedPartnerUserId: partner.id,
            assignedPartnerName: partner.name,
          },
          event: {
            eventId: `evt_${crypto.randomUUID()}`,
            packageId: ret.packageId,
            merchantId: ret.merchantId,
            type: 'RETURN_PARTNER_ASSIGNED',
            actor: { userId: caller.userId, role: caller.role },
            occurredAt: new Date(),
            sourceSystem: 'REBOXIFY_API',
            correlationId: meta?.correlationId ?? ret.id,
            outcome: 'ACCEPTED',
            evidence: [{ type: 'NOTE', detail: `Assigned return partner ${partner.name}` }],
            metadata: { returnNumber: ret.returnNumber, partnerUserId: partner.id },
          },
        },
        session
      )
    );

    if (!result) throw conflict('Failed to assign partner cleanly.');

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'RETURN_PARTNER_ASSIGNED',
      entityType: 'Return',
      entityId: ret.id,
      businessId: ret.merchantId,
      afterSummary: { assignedPartnerUserId: partner.id, partnerName: partner.name },
      correlationId: meta?.correlationId,
    });

    return result.returnRecord;
  }

  private async verifyScanAuthorization(
    pkgId: string,
    retMerchantId: string,
    input: ReturnQrActionInput,
    caller: AuthPrincipal,
    actionLabel: string,
    meta?: { correlationId?: string }
  ): Promise<void> {
    const pkg = await this.packages.findByPackageId(pkgId);
    if (!pkg) throw notFound(`Package ${pkgId} not found.`);

    const scanMode = input.scanMode ?? 'QR_TOKEN';
    const recordFailure = async (code: string, reason: string) => {
      await this.passportRepo.recordEvent({
        eventId: `evt_${crypto.randomUUID()}`,
        packageId: pkg.packageId,
        merchantId: retMerchantId,
        type: 'SCAN_REJECTED',
        actor: { userId: caller.userId, role: caller.role },
        occurredAt: new Date(),
        sourceSystem: 'REBOXIFY_API',
        correlationId: meta?.correlationId,
        locationRef: input.locationRef,
        outcome: 'REJECTED',
        evidence: [{ type: 'QR_SCAN', detail: `${actionLabel} rejected (${code}): ${reason}` }],
        metadata: { attemptedAction: actionLabel, reasonCode: code, reason },
      });
    };

    if (scanMode === 'QR_TOKEN') {
      if (!input.qrToken?.trim()) {
        await recordFailure('QR_TOKEN_REQUIRED', 'Signed QR token required.');
        throw badRequest('Signed QR token is required for QR verification.');
      }
      const qrCheck = this.qr.verifyPackageToken(input.qrToken, pkg);
      if (!qrCheck.valid) {
        await recordFailure(qrCheck.code ?? 'INVALID_QR_TOKEN', qrCheck.reason ?? 'Invalid QR.');
        if (qrCheck.code === 'QR_REVOKED' || qrCheck.code === 'QR_TOKEN_EXPIRED') {
          throw forbidden(qrCheck.reason ?? 'QR token revoked or expired.');
        }
        throw unauthorized(qrCheck.reason ?? 'Invalid QR signature.');
      }
    } else {
      if (caller.role === 'CUSTOMER') {
        await recordFailure('MANUAL_FALLBACK_FORBIDDEN', 'Customers cannot use manual override.');
        throw forbidden('Customers cannot perform manual scan overrides.');
      }
      if (!input.manualReason || input.manualReason.trim().length < 8) {
        await recordFailure('MANUAL_REASON_REQUIRED', 'Manual reason < 8 chars.');
        throw badRequest('Manual fallback requires an operational reason (min 8 chars).');
      }
    }

    if (input.scanId?.trim()) {
      const existing = await this.passportRepo.findEventByScanId(pkg.packageId, input.scanId.trim());
      if (existing) {
        await recordFailure('DUPLICATE_SCAN_REPLAY', `Duplicate scanId ${input.scanId.trim()}.`);
        throw conflict(
          `Scan "${input.scanId.trim()}" was already processed for ${pkg.packageId}.`,
          'DUPLICATE_SCAN_REPLAY'
        );
      }
    }
  }

  async collectReturn(
    returnId: string,
    input: ReturnQrActionInput,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<{ returnRecord: ReturnDto; package?: PackageStatus }> {
    if (caller.role !== 'DELIVERY_PARTNER' && caller.role !== 'ADMIN') {
      throw forbidden('Only an assigned delivery partner or admin can mark return collection.');
    }

    const ret = await this.returns.findById(returnId);
    if (!ret) throw notFound('Return record not found.');

    if (caller.role === 'DELIVERY_PARTNER' && ret.assignedPartnerUserId !== caller.userId) {
      throw forbidden('You are not assigned to collect this return package.');
    }

    const retCheck = returnStateMachine.validateTransition(ret.status, 'COLLECTED');
    if (!retCheck.allowed) {
      throw conflict(retCheck.reason ?? `Cannot collect return in status ${ret.status}.`);
    }

    const pkg = await this.packages.findByPackageId(ret.packageId);
    if (!pkg) throw notFound('Linked package not found.');

    if (pkg.status !== 'COLLECTED') {
      const pkgCheck = packageStateMachine.validateTransition(pkg.status, 'COLLECTED');
      if (!pkgCheck.allowed) {
        throw conflict(pkgCheck.reason ?? `Cannot transition package from ${pkg.status} to COLLECTED.`);
      }
    }

    await this.verifyScanAuthorization(
      ret.packageId,
      ret.merchantId,
      input,
      caller,
      'COLLECT_RETURN',
      meta
    );

    const now = new Date();
    const res = await this.runTx((session) =>
      this.returns.transitionReturnAndPackageAtomically(
        {
          returnId: ret.id,
          expectedReturnStatuses: [ret.status],
          returnSet: {
            status: 'COLLECTED',
            collectedAt: now,
          },
          ...(pkg.status !== 'COLLECTED'
            ? {
                packageUpdate: {
                  packageId: pkg.packageId,
                  expectedStatuses: [pkg.status],
                  nextStatus: 'COLLECTED',
                  newCustodian: {
                    custodianType: 'DELIVERY_PARTNER',
                    custodianId: caller.userId,
                    label: `${caller.name} (Return Transit)`,
                    assignedAt: now,
                  },
                },
              }
            : {}),
          event: {
            eventId: `evt_${crypto.randomUUID()}`,
            packageId: pkg.packageId,
            merchantId: ret.merchantId,
            scanId: input.scanId?.trim(),
            type: 'PACKAGE_RETURN_COLLECTED',
            actor: { userId: caller.userId, role: caller.role },
            occurredAt: now,
            sourceSystem: 'REBOXIFY_API',
            correlationId: meta?.correlationId ?? ret.id,
            locationRef: input.locationRef?.trim() || pkg.fulfilmentLocation,
            outcome: 'ACCEPTED',
            evidence: [
              {
                type: 'QR_SCAN',
                detail: input.manualReason
                  ? `Manual collection: ${input.manualReason}`
                  : `QR verified collection for ${ret.returnNumber}`,
              },
            ],
            metadata: { returnNumber: ret.returnNumber },
          },
        },
        session
      )
    );

    if (!res) throw conflict('Return or package state changed concurrently.');

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'RETURN_COLLECTED',
      entityType: 'Return',
      entityId: ret.id,
      businessId: ret.merchantId,
      afterSummary: { status: 'COLLECTED', packageStatus: 'COLLECTED' },
      correlationId: meta?.correlationId,
    });

    return { returnRecord: res.returnRecord, package: res.package?.status };
  }

  async receiveAtCentre(
    returnId: string,
    input: ReturnQrActionInput,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<{ returnRecord: ReturnDto; packageStatus?: PackageStatus }> {
    if (caller.role !== 'COLLECTION_CENTRE' && caller.role !== 'ADMIN') {
      throw forbidden('Only collection-centre operators or admins may receive returns at centre.');
    }

    const ret = await this.returns.findById(returnId);
    if (!ret) throw notFound('Return record not found.');

    const retCheck = returnStateMachine.validateTransition(ret.status, 'RECEIVED');
    if (!retCheck.allowed) {
      throw conflict(retCheck.reason ?? `Cannot receive return while in status ${ret.status}.`);
    }

    const pkg = await this.packages.findByPackageId(ret.packageId);
    if (!pkg) throw notFound('Linked package not found.');

    if (pkg.status !== 'AT_CENTRE') {
      const pkgCheck = packageStateMachine.validateTransition(pkg.status, 'AT_CENTRE');
      if (!pkgCheck.allowed) {
        throw conflict(pkgCheck.reason ?? `Package in ${pkg.status} cannot move directly to AT_CENTRE.`);
      }
    }

    await this.verifyScanAuthorization(
      ret.packageId,
      ret.merchantId,
      input,
      caller,
      'RECEIVE_CENTRE',
      meta
    );

    const now = new Date();
    const res = await this.runTx((session) =>
      this.returns.transitionReturnAndPackageAtomically(
        {
          returnId: ret.id,
          expectedReturnStatuses: [ret.status],
          returnSet: {
            status: 'RECEIVED',
            receivedAt: now,
            receivedBy: caller.userId,
          },
          ...(pkg.status !== 'AT_CENTRE'
            ? {
                packageUpdate: {
                  packageId: pkg.packageId,
                  expectedStatuses: [pkg.status],
                  nextStatus: 'AT_CENTRE',
                  newCustodian: {
                    custodianType: 'REBOXIFY_CENTRE',
                    custodianId: caller.collectionCenterId ?? 'CENTRE-MAIN',
                    label: input.locationRef?.trim() || 'ReBoxify Collection Centre',
                    assignedAt: now,
                  },
                },
              }
            : {}),
          event: {
            eventId: `evt_${crypto.randomUUID()}`,
            packageId: pkg.packageId,
            merchantId: ret.merchantId,
            scanId: input.scanId?.trim(),
            type: 'RETURN_RECEIVED_AT_CENTRE',
            actor: { userId: caller.userId, role: caller.role },
            occurredAt: now,
            sourceSystem: 'REBOXIFY_API',
            correlationId: meta?.correlationId ?? ret.id,
            locationRef: input.locationRef?.trim() || 'Collection Centre Intake',
            outcome: 'ACCEPTED',
            evidence: [{ type: 'QR_SCAN', detail: `Received ${ret.returnNumber} at centre` }],
            metadata: { returnNumber: ret.returnNumber },
          },
        },
        session
      )
    );

    if (!res) throw conflict('Return or package state changed concurrently.');

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'RETURN_RECEIVED_AT_CENTRE',
      entityType: 'Return',
      entityId: ret.id,
      businessId: ret.merchantId,
      afterSummary: { status: 'RECEIVED', packageStatus: 'AT_CENTRE' },
      correlationId: meta?.correlationId,
    });

    return { returnRecord: res.returnRecord, packageStatus: res.package?.status };
  }

  async uploadEvidence(
    returnId: string,
    file: { filename: string; mimeType: string; contentBase64: string },
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<ReturnDto> {
    const ret = await this.returns.findById(returnId);
    if (!ret) throw notFound('Return record not found.');

    const isOwnerCustomer = caller.role === 'CUSTOMER' && ret.customerId === caller.userId;
    const isAssignedPartner =
      caller.role === 'DELIVERY_PARTNER' && ret.assignedPartnerUserId === caller.userId;
    const isCentreOrAdmin = caller.role === 'COLLECTION_CENTRE' || caller.role === 'ADMIN';
    if (!isOwnerCustomer && !isAssignedPartner && !isCentreOrAdmin) {
      throw forbidden('You are not authorized to attach evidence to this return.');
    }

    if (ret.evidenceFiles.length >= 6) {
      throw conflict('Maximum of 6 evidence photos reached for a return.');
    }

    const buffer = Buffer.from(file.contentBase64, 'base64');
    const saved = await this.evidence.saveEvidence({
      filename: file.filename,
      mimeType: file.mimeType,
      buffer,
      metadata: {
        returnId: ret.id,
        returnNumber: ret.returnNumber,
        packageId: ret.packageId,
        uploadedBy: caller.userId,
      },
    });

    const updated = await this.returns.appendEvidenceFile(
      ret.id,
      {
        fileId: saved.fileId,
        filename: saved.filename,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
        uploadedAt: new Date(),
        uploadedBy: caller.userId,
      },
      {
        eventId: `evt_${crypto.randomUUID()}`,
        packageId: ret.packageId,
        merchantId: ret.merchantId,
        type: 'RETURN_EVIDENCE_UPLOADED',
        actor: { userId: caller.userId, role: caller.role },
        occurredAt: new Date(),
        sourceSystem: 'REBOXIFY_API',
        correlationId: meta?.correlationId ?? ret.id,
        outcome: 'ACCEPTED',
        evidence: [{ type: 'PHOTO', fileRef: saved.fileId, detail: saved.filename }],
        metadata: { returnNumber: ret.returnNumber, mimeType: saved.mimeType },
      }
    );

    if (!updated) throw notFound('Return not found.');

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'RETURN_EVIDENCE_UPLOADED',
      entityType: 'Return',
      entityId: ret.id,
      businessId: ret.merchantId,
      afterSummary: { fileId: saved.fileId, filename: saved.filename, mimeType: saved.mimeType },
      correlationId: meta?.correlationId,
    });

    return updated;
  }

  async downloadEvidence(
    returnId: string,
    fileId: string,
    caller: AuthPrincipal
  ): Promise<RetrievedEvidenceFile> {
    const ret = await this.returns.findById(returnId);
    if (!ret) throw notFound('Return record not found.');
    this.assertReturnAccess(caller, ret);

    const attached = ret.evidenceFiles.find((f) => f.fileId === fileId);
    if (!attached) {
      throw notFound('Evidence file is not attached to this return.');
    }

    const file = await this.evidence.readEvidence(fileId);
    if (!file) {
      throw notFound('Stored evidence blob not found.');
    }
    return file;
  }

  async inspectReturn(
    returnId: string,
    input: InspectReturnInput,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<ReturnDto> {
    this.assertNoClientRefundOverride(input);

    if (caller.role !== 'COLLECTION_CENTRE' && caller.role !== 'ADMIN') {
      throw forbidden('Only collection-centre operators or admins may record return inspections.');
    }

    const ret = await this.returns.findById(returnId);
    if (!ret) throw notFound('Return record not found.');

    // Blueprint Section 5 mandatory role separation
    if (ret.customerId === caller.userId) {
      throw new AppError(
        403,
        'SELF_INSPECTION_FORBIDDEN',
        'A customer must never inspect or approve their own return.'
      );
    }

    if (ret.status === 'APPROVED' || ret.status === 'REJECTED' || ret.status === 'CLOSED') {
      throw conflict(`Return ${ret.returnNumber} has already been finalized (${ret.status}).`);
    }

    const existingRefund = await this.refunds.findByReturnId(ret.id);
    if (existingRefund) {
      throw conflict('Cannot re-inspect return after a refund attempt already exists.');
    }

    if (ret.status !== 'RECEIVED' && ret.status !== 'UNDER_INSPECTION' && ret.status !== 'NEEDS_REVIEW') {
      throw conflict(
        `Return ${ret.returnNumber} must be RECEIVED at collection centre before inspection (currently ${ret.status}).`
      );
    }

    const pkg = await this.packages.findByPackageId(ret.packageId);
    if (!pkg) throw notFound('Linked package not found.');

    const activeTx =
      (await this.transactions.findActiveByOrderId(ret.orderId)) ??
      (await this.transactions.findLatestByOrderId(ret.orderId));
    if (!activeTx || !activeTx.captureId) {
      throw conflict('Cannot inspect for refund without a verified PayPal capture record.');
    }

    const alloc = activeTx.depositAllocations.find(
      (a) => a.packageId.toUpperCase() === ret.packageId.toUpperCase()
    );
    const allocatedDeposit = alloc?.allocatedDeposit ?? ret.refundEligibility.originalDeposit;
    const alreadyRefundedForPkg = alloc?.refundedAmount ?? 0;
    const alreadyPendingForPkg = alloc?.pendingRefundAmount ?? 0;
    const totalConfirmedOrder = activeTx.depositAllocations.reduce(
      (s, a) => s + a.refundedAmount,
      0
    );
    const totalPendingOrder = activeTx.depositAllocations.reduce(
      (s, a) => s + a.pendingRefundAmount,
      0
    );

    const calc = calculateReturnRefund({
      condition: input.condition,
      checklist: input.checklist,
      isLateReturn: ret.isLateReturn,
      daysLate: ret.daysLate,
      disputed: input.disputed,
      allocatedDeposit,
      alreadyRefundedForPackage: alreadyRefundedForPkg,
      alreadyPendingForPackage: alreadyPendingForPkg,
      totalCapturedTransactionAmount: activeTx.amount,
      totalConfirmedRefundsAcrossOrder: totalConfirmedOrder,
      totalPendingRefundsAcrossOrder: totalPendingOrder,
      currency: activeTx.currency,
    });

    const retNextStatus: ReturnStatus = calc.recommendedReturnStatus;
    if (ret.status !== retNextStatus) {
      const rTrans = returnStateMachine.validateTransition(ret.status, retNextStatus);
      if (!rTrans.allowed) {
        throw conflict(rTrans.reason ?? 'Invalid return inspection transition.');
      }
    }

    let nextPkgStatus = calc.recommendedPackageStatus;
    if (pkg.status !== nextPkgStatus) {
      const pTrans = packageStateMachine.validateTransition(pkg.status, nextPkgStatus);
      if (!pTrans.allowed) {
        // If package already moved to QUARANTINED / CLEANING per Gate 3 independence, preserve allowed status safely
        nextPkgStatus = pkg.status as typeof calc.recommendedPackageStatus;
      }
    }

    const now = new Date();
    const res = await this.runTx((session) =>
      this.returns.transitionReturnAndPackageAtomically(
        {
          returnId: ret.id,
          expectedReturnStatuses: [ret.status],
          returnSet: {
            status: retNextStatus,
            ...(input.disputed !== undefined ? { disputed: input.disputed } : {}),
            ...(input.disputeReason?.trim() ? { disputeReason: input.disputeReason.trim() } : {}),
            inspection: {
              inspectorId: caller.userId,
              inspectedAt: now,
              checklist: input.checklist,
              condition: input.condition,
              outcome: calc.inspectionOutcome,
              damageReason: input.damageReason?.trim(),
              notes: input.notes?.trim(),
            },
            refundEligibility: {
              eligible: calc.eligible,
              reason: calc.reason,
              originalDeposit: calc.originalDeposit,
              totalDeductions: calc.totalDeductions,
              calculatedAmount: calc.calculatedAmount,
              currency: calc.currency,
              ruleVersion: calc.ruleVersion,
              deductionBreakdown: calc.deductionBreakdown,
            },
          },
          ...(pkg.status !== nextPkgStatus
            ? {
                packageUpdate: {
                  packageId: pkg.packageId,
                  expectedStatuses: [pkg.status],
                  nextStatus: nextPkgStatus,
                  lastInspectionAt: now,
                  lastInspectionOutcome: calc.inspectionOutcome,
                },
              }
            : {}),
          event: {
            eventId: `evt_${crypto.randomUUID()}`,
            packageId: pkg.packageId,
            merchantId: ret.merchantId,
            type: 'RETURN_INSPECTED',
            actor: { userId: caller.userId, role: caller.role },
            occurredAt: now,
            sourceSystem: 'REBOXIFY_API',
            correlationId: meta?.correlationId ?? ret.id,
            outcome: 'ACCEPTED',
            evidence: [
              {
                type: 'NOTE',
                detail: `Condition=${input.condition}; Outcome=${calc.inspectionOutcome}; Refund=${calc.currency} ${calc.calculatedAmount.toFixed(2)}`,
              },
            ],
            metadata: {
              returnNumber: ret.returnNumber,
              condition: input.condition,
              outcome: calc.inspectionOutcome,
              calculatedAmount: calc.calculatedAmount,
              totalDeductions: calc.totalDeductions,
              ruleVersion: calc.ruleVersion,
            },
          },
        },
        session
      )
    );

    if (!res) throw conflict('Return state changed concurrently during inspection.');

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'RETURN_INSPECTED',
      entityType: 'Return',
      entityId: ret.id,
      businessId: ret.merchantId,
      afterSummary: {
        condition: input.condition,
        inspectionOutcome: calc.inspectionOutcome,
        calculatedAmount: calc.calculatedAmount,
        deductions: calc.deductionBreakdown,
        returnStatus: retNextStatus,
      },
      correlationId: meta?.correlationId,
    });

    return res.returnRecord;
  }

  async rejectReturn(
    returnId: string,
    reason: string,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<ReturnDto> {
    if (
      caller.role !== 'COLLECTION_CENTRE' &&
      caller.role !== 'MERCHANT_ADMIN' &&
      caller.role !== 'ADMIN'
    ) {
      throw forbidden('Not authorized to reject return refunds.');
    }

    const ret = await this.returns.findById(returnId);
    if (!ret) throw notFound('Return not found.');

    if (ret.customerId === caller.userId) {
      throw forbidden('Customers cannot decide their own return outcome.');
    }
    if (caller.role === 'MERCHANT_ADMIN' && ret.merchantId !== caller.businessId) {
      throw forbidden('Cannot reject return outside your merchant tenant.');
    }
    if (!ret.inspection) {
      throw conflict('Return must be inspected before a rejection decision can be recorded.');
    }

    const rTrans = returnStateMachine.validateTransition(ret.status, 'REJECTED');
    if (!rTrans.allowed) {
      throw conflict(rTrans.reason ?? `Cannot reject return in status ${ret.status}.`);
    }

    const now = new Date();
    const res = await this.runTx((session) =>
      this.returns.transitionReturnAndPackageAtomically(
        {
          returnId: ret.id,
          expectedReturnStatuses: [ret.status],
          returnSet: {
            status: 'REJECTED',
            decision: {
              decidedBy: caller.userId,
              decidedAt: now,
              outcome: 'REJECTED',
              reason: reason.trim(),
            },
            refundEligibility: {
              ...ret.refundEligibility,
              eligible: false,
              calculatedAmount: 0,
              reason: reason.trim(),
            },
          },
          event: {
            eventId: `evt_${crypto.randomUUID()}`,
            packageId: ret.packageId,
            merchantId: ret.merchantId,
            type: 'RETURN_REJECTED',
            actor: { userId: caller.userId, role: caller.role },
            occurredAt: now,
            sourceSystem: 'REBOXIFY_API',
            correlationId: meta?.correlationId ?? ret.id,
            outcome: 'ACCEPTED',
            evidence: [{ type: 'NOTE', detail: `Rejected: ${reason.trim()}` }],
            metadata: { returnNumber: ret.returnNumber },
          },
        },
        session
      )
    );

    if (!res) throw conflict('Return status changed concurrently.');

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'RETURN_REJECTED',
      entityType: 'Return',
      entityId: ret.id,
      businessId: ret.merchantId,
      afterSummary: { reason: reason.trim() },
      correlationId: meta?.correlationId,
    });

    return res.returnRecord;
  }

  private async executeProviderRefundAndSync(
    ret: ReturnDto,
    refund: RefundDto,
    tx: TransactionDto,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<ApproveReturnResult> {
    if (!this.paypal.isConfigured() || !this.paypal.refundCapture) {
      throw serviceUnavailable(
        'PayPal Sandbox refund capability is not configured on this backend.'
      );
    }

    let providerResp: PayPalRefundResponse;
    try {
      providerResp = await this.paypal.refundCapture({
        captureId: refund.captureId,
        amount: refund.amount,
        currency: refund.currency,
        requestId: refund.paypalRequestId,
        invoiceId: ret.returnNumber,
        noteToPayer: `ReBoxify deposit refund (${ret.returnNumber})`,
      });
    } catch (err) {
      if (
        err instanceof PayPalClientError &&
        (err.code === 'PAYPAL_TIMEOUT' ||
          err.code === 'PAYPAL_NETWORK_ERROR' ||
          (err.httpStatus !== undefined && err.httpStatus >= 500))
      ) {
        // Reconcile order capture/refund state BEFORE marking failed or allowing retries!
        return this.reconcilePendingRefundInternal(ret, refund, tx, caller, meta);
      }

      if (err instanceof PayPalClientError && err.code === 'PAYPAL_API_ERROR') {
        const failed = await this.runTx((session) =>
          this.refunds.failRefundAndReleaseReservationAtomically(
            {
              refundId: refund.id,
              failureReason: err.message,
              providerStatus: 'API_ERROR',
              event: {
                eventId: `evt_${crypto.randomUUID()}`,
                packageId: ret.packageId,
                merchantId: ret.merchantId,
                type: 'REFUND_FAILED',
                actor: { userId: caller.userId, role: caller.role },
                occurredAt: new Date(),
                sourceSystem: 'PAYPAL_REST_V2',
                correlationId: meta?.correlationId ?? refund.id,
                outcome: 'REJECTED',
                evidence: [{ type: 'NOTE', detail: `PayPal refund API error: ${err.message}` }],
              },
            },
            session
          )
        );
        throw new AppError(502, 'PAYPAL_REFUND_FAILED', err.message, {
          refundId: refund.id,
          refundState: failed?.refund.state ?? 'REFUND_FAILED',
        });
      }

      throw err;
    }

    return this.applyProviderRefundStatus(ret, refund, tx, providerResp, caller, meta);
  }

  private async applyProviderRefundStatus(
    ret: ReturnDto,
    refund: RefundDto,
    tx: TransactionDto,
    providerResp: PayPalRefundResponse,
    caller: AuthPrincipal,
    meta?: { correlationId?: string }
  ): Promise<ApproveReturnResult> {
    if (providerResp.amount) {
      const respCurrency = providerResp.amount.currency_code?.toUpperCase();
      const respValue = Number(providerResp.amount.value);
      if (respCurrency && respCurrency !== refund.currency.toUpperCase()) {
        throw new AppError(
          409,
          'REFUND_CURRENCY_MISMATCH',
          `PayPal refund currency ${respCurrency} does not match expected ${refund.currency}.`
        );
      }
      if (!Number.isNaN(respValue) && Math.abs(respValue - refund.amount) > 0.01) {
        throw new AppError(
          409,
          'REFUND_AMOUNT_MISMATCH',
          `PayPal refund amount ${respValue} does not match expected ${refund.amount}.`
        );
      }
    }

    const now = new Date();
    const status = providerResp.status?.toUpperCase();

    if (status === 'COMPLETED') {
      const finalized = await this.runTx((session) =>
        this.refunds.finalizeRefundCompletedAtomically(
          {
            refundId: refund.id,
            providerRefundId: providerResp.id,
            providerStatus: providerResp.status,
            confirmedAt: now,
            event: {
              eventId: `evt_${crypto.randomUUID()}`,
              packageId: ret.packageId,
              merchantId: ret.merchantId,
              type: 'REFUND_CONFIRMED',
              actor: { userId: caller.userId, role: caller.role },
              occurredAt: now,
              sourceSystem: 'PAYPAL_REST_V2',
              correlationId: meta?.correlationId ?? refund.id,
              outcome: 'ACCEPTED',
              evidence: [
                {
                  type: 'NOTE',
                  detail: `PayPal refund ${providerResp.id} COMPLETED (${refund.currency} ${refund.amount.toFixed(2)})`,
                },
              ],
              metadata: {
                returnNumber: ret.returnNumber,
                providerRefundId: providerResp.id,
                amount: refund.amount,
                currency: refund.currency,
              },
            },
          },
          session
        )
      );

      await this.audit.record({
        actor: { userId: caller.userId, role: caller.role },
        action: 'REFUND_CONFIRMED',
        entityType: 'Refund',
        entityId: refund.id,
        businessId: ret.merchantId,
        afterSummary: {
          providerRefundId: providerResp.id,
          amount: refund.amount,
          currency: refund.currency,
          state: 'REFUNDED',
        },
        correlationId: meta?.correlationId,
      });

      return {
        returnRecord: finalized?.returnRecord ?? ret,
        refund: finalized?.refund ?? { ...refund, state: 'REFUNDED', providerRefundId: providerResp.id },
        transaction: finalized?.transaction ?? tx,
        pending: false,
        alreadyRefunded: false,
        zeroRefundApproved: false,
        message: `PayPal refund ${providerResp.id} confirmed (${refund.currency} ${refund.amount.toFixed(2)}).`,
      };
    }

    if (status === 'FAILED' || status === 'CANCELLED' || status === 'DECLINED') {
      const reason =
        providerResp.status_details?.reason || `PayPal refund returned ${providerResp.status}.`;
      const failed = await this.runTx((session) =>
        this.refunds.failRefundAndReleaseReservationAtomically(
          {
            refundId: refund.id,
            failureReason: reason,
            providerStatus: providerResp.status,
            event: {
              eventId: `evt_${crypto.randomUUID()}`,
              packageId: ret.packageId,
              merchantId: ret.merchantId,
              type: 'REFUND_FAILED',
              actor: { userId: caller.userId, role: caller.role },
              occurredAt: now,
              sourceSystem: 'PAYPAL_REST_V2',
              correlationId: meta?.correlationId ?? refund.id,
              outcome: 'REJECTED',
              evidence: [{ type: 'NOTE', detail: reason }],
            },
          },
          session
        )
      );

      return {
        returnRecord: ret,
        refund: failed?.refund ?? { ...refund, state: 'REFUND_FAILED', failureReason: reason },
        transaction: failed?.transaction ?? tx,
        pending: false,
        alreadyRefunded: false,
        zeroRefundApproved: false,
        message: `Refund failed on PayPal (${providerResp.status}): ${reason}`,
      };
    }

    // PENDING / unknown non-final status -> persist REFUND_PENDING with balance reserved!
    const pendingRefund = await this.runTx((session) =>
      this.refunds.markRefundPendingProvider(
        {
          refundId: refund.id,
          providerRefundId: providerResp.id,
          providerStatus: providerResp.status,
          txState: 'REFUND_PENDING',
          lastReconciledAt: now,
        },
        session
      )
    );

    return {
      returnRecord: ret,
      refund: pendingRefund ?? { ...refund, state: 'REFUND_PENDING', providerRefundId: providerResp.id },
      transaction: tx,
      pending: true,
      alreadyRefunded: false,
      zeroRefundApproved: false,
      message: `PayPal refund ${providerResp.id} is PENDING provider confirmation.`,
    };
  }

  private async reconcilePendingRefundInternal(
    ret: ReturnDto,
    refund: RefundDto,
    tx: TransactionDto,
    caller: AuthPrincipal,
    meta?: { correlationId?: string }
  ): Promise<ApproveReturnResult> {
    const now = new Date();
    let providerResp: PayPalRefundResponse | null = null;

    try {
      if (refund.providerRefundId && this.paypal.getRefund) {
        providerResp = await this.paypal.getRefund(refund.providerRefundId);
      } else {
        const orderResp = await this.paypal.getOrder(tx.paypalOrderId);
        const refundsList = orderResp.purchase_units?.flatMap((u) => u.payments?.refunds ?? []) ?? [];
        let matched = refundsList.find((r) => r.invoice_id === ret.returnNumber);
        if (!matched) {
          for (const candidate of refundsList) {
            if (
              candidate.amount?.currency_code?.toUpperCase() === refund.currency &&
              Math.abs(Number(candidate.amount?.value) - refund.amount) <= 0.01
            ) {
              const claimedByOther = await this.refunds.findByProviderRefundId(candidate.id);
              if (!claimedByOther || claimedByOther.id === refund.id) {
                matched = candidate;
                break;
              }
            }
          }
        }
        if (matched) {
          providerResp = {
            id: matched.id,
            status: matched.status,
            amount: matched.amount,
            invoice_id: matched.invoice_id,
          };
        }
      }
    } catch {
      // Keep safely in REFUND_PENDING so background worker or operator can reconcile later without duplicate refund!
    }

    if (providerResp) {
      return this.applyProviderRefundStatus(ret, refund, tx, providerResp, caller, meta);
    }

    const pendingRefund = await this.runTx((session) =>
      this.refunds.markRefundPendingProvider(
        {
          refundId: refund.id,
          providerStatus: 'RECONCILIATION_PENDING',
          txState: 'REFUND_PENDING',
          lastReconciledAt: now,
        },
        session
      )
    );

    return {
      returnRecord: ret,
      refund: pendingRefund ?? { ...refund, state: 'REFUND_PENDING' },
      transaction: tx,
      pending: true,
      alreadyRefunded: false,
      zeroRefundApproved: false,
      message: 'Refund outcome is pending PayPal verification. Reconcile status instead of issuing another refund.',
    };
  }

  async approveAndInitiateRefund(
    returnId: string,
    input: ApproveReturnInput,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string; idempotencyKey?: string }
  ): Promise<ApproveReturnResult> {
    this.assertNoClientRefundOverride(input);

    if (
      caller.role !== 'COLLECTION_CENTRE' &&
      caller.role !== 'MERCHANT_ADMIN' &&
      caller.role !== 'ADMIN'
    ) {
      throw forbidden('Only authorized centre operators, merchant admins, or admins can approve return refunds.');
    }

    const ret = await this.returns.findById(returnId);
    if (!ret) throw notFound('Return record not found.');

    if (caller.role === 'MERCHANT_ADMIN' && ret.merchantId !== caller.businessId) {
      throw forbidden('Cannot approve returns belonging to another merchant.');
    }

    // Blueprint Section 5: customer can never approve their own return
    if (ret.customerId === caller.userId) {
      throw new AppError(
        403,
        'SELF_APPROVAL_FORBIDDEN',
        'A customer cannot approve their own return inspection or refund.'
      );
    }

    const business = await this.businesses.findById(ret.merchantId);
    if (
      caller.role !== 'ADMIN' &&
      business &&
      !business.policies.allowedReturnApprovers.includes(caller.role)
    ) {
      throw forbidden(
        `Merchant policy restricts return approval to: ${business.policies.allowedReturnApprovers.join(', ')}.`
      );
    }

    if (!ret.inspection) {
      throw conflict('Return must be inspected before approval and refund initiation.');
    }

    // Check existing refund for idempotency / duplicate protection BEFORE transitioning
    const existingRefund = await this.refunds.findByReturnId(ret.id);
    if (existingRefund) {
      const tx = await this.transactions.findById(existingRefund.transactionId);
      if (existingRefund.state === 'REFUNDED') {
        return {
          returnRecord: ret,
          refund: existingRefund,
          transaction: tx,
          pending: false,
          alreadyRefunded: true,
          zeroRefundApproved: false,
          message: `Refund ${existingRefund.providerRefundId ?? existingRefund.id} was already completed.`,
        };
      }
      if (existingRefund.state === 'REFUND_PENDING' || existingRefund.state === 'REFUND_REQUESTED') {
        if (!tx) throw conflict('Linked transaction missing for pending refund.');
        return this.reconcilePendingRefundInternal(ret, existingRefund, tx, caller, meta);
      }
      throw conflict(
        `A previous refund attempt (${existingRefund.state}) exists; use /reconcile-refund to recover or retry safely.`,
        'REFUND_ALREADY_EXISTS'
      );
    }

    // Idempotent replay for an already finalized zero-refund approval
    if (
      ret.status === 'CLOSED' &&
      ret.decision?.outcome === 'APPROVED' &&
      ret.refundEligibility.calculatedAmount <= 0
    ) {
      const tx =
        (await this.transactions.findActiveByOrderId(ret.orderId)) ??
        (await this.transactions.findLatestByOrderId(ret.orderId));
      return {
        returnRecord: ret,
        refund: null,
        transaction: tx,
        pending: false,
        alreadyRefunded: false,
        zeroRefundApproved: true,
        message: 'Zero-refund decision was already finalized; no PayPal refund issued.',
      };
    }

    // Gate 2 check (under review or passing inspection)
    const gate = canInitiateRefundFromReturn(
      ret.status,
      ret.inspection.outcome,
      'APPROVED'
    );
    if (!gate.allowed) {
      throw conflict(gate.reason ?? 'Return is not eligible for approval.');
    }

    // Block inventing positive refunds for strictly forfeited conditions
    const forfeitedConditions: InspectionCondition[] = [
      'MAJOR_DAMAGE',
      'CONTAMINATED',
      'MISSING_PACKAGING',
      'UNUSABLE',
      'WRONG_PACKAGE',
    ];
    if (forfeitedConditions.includes(ret.inspection.condition) && ret.refundEligibility.calculatedAmount > 0) {
      throw conflict('Invalid state: zero-refund condition cannot have positive refund balance.');
    }

    const activeTx =
      (await this.transactions.findActiveByOrderId(ret.orderId)) ??
      (await this.transactions.findLatestByOrderId(ret.orderId));
    if (!activeTx || !activeTx.captureId) {
      throw conflict('Cannot initiate refund without a verified PayPal capture ID.');
    }

    const totalConfirmed = activeTx.depositAllocations.reduce((s, a) => s + a.refundedAmount, 0);
    const totalPending = activeTx.depositAllocations.reduce((s, a) => s + a.pendingRefundAmount, 0);
    const alloc = activeTx.depositAllocations.find(
      (a) => a.packageId.toUpperCase() === ret.packageId.toUpperCase()
    );
    if (!alloc) {
      throw conflict(`Transaction is missing deposit allocation for package ${ret.packageId}.`);
    }

    const pkgRemaining = round2(
      Math.max(0, alloc.allocatedDeposit - alloc.refundedAmount - alloc.pendingRefundAmount)
    );
    const txRemaining = round2(Math.max(0, activeTx.amount - totalConfirmed - totalPending));
    const maxAllowed = round2(Math.min(pkgRemaining, txRemaining));
    const refundAmount = round2(Math.min(ret.refundEligibility.calculatedAmount, maxAllowed));

    const now = new Date();
    const approvalReason =
      input.reason?.trim() ||
      ret.refundEligibility.reason ||
      'Approved following collection-centre inspection.';

    // Zero-refund path (no PayPal refund call created and no Refund record inserted)
    if (refundAmount <= 0) {
      const approveZeroOutcome =
        ret.inspection.condition === 'GOOD' || ret.inspection.condition === 'MINOR_WEAR';

      if (approveZeroOutcome) {
        if (ret.status !== 'APPROVED') {
          const toApproved = returnStateMachine.validateTransition(ret.status, 'APPROVED');
          if (!toApproved.allowed) {
            throw conflict(
              toApproved.reason ?? `Cannot approve zero-refund return from status ${ret.status}.`
            );
          }
        }
        const toClosed = returnStateMachine.validateTransition('APPROVED', 'CLOSED');
        if (!toClosed.allowed) {
          throw conflict(toClosed.reason ?? 'Cannot close approved zero-refund return.');
        }

        const closedRes = await this.runTx(async (session) => {
          if (ret.status !== 'APPROVED') {
            const approvedStep = await this.returns.transitionReturnAndPackageAtomically(
              {
                returnId: ret.id,
                expectedReturnStatuses: [ret.status],
                returnSet: {
                  status: 'APPROVED',
                  decision: {
                    decidedBy: caller.userId,
                    decidedAt: now,
                    outcome: 'APPROVED',
                    reason: approvalReason,
                  },
                  refundEligibility: {
                    ...ret.refundEligibility,
                    eligible: false,
                    calculatedAmount: 0,
                  },
                },
              },
              session
            );
            if (!approvedStep) {
              throw conflict('Return changed concurrently during zero-refund approval.');
            }
          }

          const closedStep = await this.returns.transitionReturnAndPackageAtomically(
            {
              returnId: ret.id,
              expectedReturnStatuses: ['APPROVED'],
              returnSet: {
                status: 'CLOSED',
              },
              event: {
                eventId: `evt_${crypto.randomUUID()}`,
                packageId: ret.packageId,
                merchantId: ret.merchantId,
                type: 'REFUND_ZERO_ELIGIBLE',
                actor: { userId: caller.userId, role: caller.role },
                occurredAt: now,
                sourceSystem: 'REBOXIFY_API',
                correlationId: meta?.correlationId ?? ret.id,
                outcome: 'ACCEPTED',
                evidence: [{ type: 'NOTE', detail: `Zero refund approved & closed: ${approvalReason}` }],
              },
            },
            session
          );
          if (!closedStep) {
            throw conflict('Return changed concurrently during zero-refund closure.');
          }
          return closedStep;
        });

        await this.audit.record({
          actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
          action: 'REFUND_ZERO_ELIGIBLE',
          entityType: 'Return',
          entityId: ret.id,
          businessId: ret.merchantId,
          afterSummary: { status: 'CLOSED', outcome: 'APPROVED', refundAmount: 0 },
          correlationId: meta?.correlationId,
        });

        return {
          returnRecord: closedRes.returnRecord,
          refund: null,
          transaction: activeTx,
          pending: false,
          alreadyRefunded: false,
          zeroRefundApproved: true,
          message: 'Zero-refund decision approved and closed; no PayPal refund issued.',
        };
      }

      const toRejected = returnStateMachine.validateTransition(ret.status, 'REJECTED');
      if (!toRejected.allowed) {
        throw conflict(
          toRejected.reason ?? `Cannot finalize zero-refund return from status ${ret.status}.`
        );
      }

      const zeroRes = await this.runTx((session) =>
        this.returns.transitionReturnAndPackageAtomically(
          {
            returnId: ret.id,
            expectedReturnStatuses: [ret.status],
            returnSet: {
              status: 'REJECTED',
              decision: {
                decidedBy: caller.userId,
                decidedAt: now,
                outcome: 'REJECTED',
                reason: approvalReason,
              },
              refundEligibility: {
                ...ret.refundEligibility,
                eligible: false,
                calculatedAmount: 0,
              },
            },
            event: {
              eventId: `evt_${crypto.randomUUID()}`,
              packageId: ret.packageId,
              merchantId: ret.merchantId,
              type: 'REFUND_ZERO_ELIGIBLE',
              actor: { userId: caller.userId, role: caller.role },
              occurredAt: now,
              sourceSystem: 'REBOXIFY_API',
              correlationId: meta?.correlationId ?? ret.id,
              outcome: 'ACCEPTED',
              evidence: [{ type: 'NOTE', detail: `Zero refund: ${approvalReason}` }],
            },
          },
          session
        )
      );
      if (!zeroRes) throw conflict('Return changed concurrently.');

      await this.audit.record({
        actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
        action: 'REFUND_ZERO_ELIGIBLE',
        entityType: 'Return',
        entityId: ret.id,
        businessId: ret.merchantId,
        afterSummary: { status: 'REJECTED', outcome: 'REJECTED', refundAmount: 0 },
        correlationId: meta?.correlationId,
      });

      return {
        returnRecord: zeroRes.returnRecord,
        refund: null,
        transaction: activeTx,
        pending: false,
        alreadyRefunded: false,
        zeroRefundApproved: true,
        message: 'Return finalized with zero refundable balance; no PayPal refund issued.',
      };
    }

    // Positive partial/full refund path
    const txCheck = paymentStateMachine.validateTransition(activeTx.state, 'REFUND_REQUESTED');
    if (!txCheck.allowed) {
      throw conflict(
        txCheck.reason ?? `Transaction state ${activeTx.state} cannot accept a new refund.`
      );
    }

    const rApproveCheck = returnStateMachine.validateTransition(ret.status, 'APPROVED');
    if (!rApproveCheck.allowed) {
      throw conflict(rApproveCheck.reason ?? `Return in status ${ret.status} cannot be approved.`);
    }

    const idempotencyKey = meta?.idempotencyKey || `refund-${ret.id}-attempt1`;
    const paypalRequestId = `RBX-REF-${ret.id.slice(-10)}-${crypto
      .createHash('sha256')
      .update(idempotencyKey)
      .digest('hex')
      .slice(0, 10)}`;

    const reserved = await this.runTx((session) =>
      this.refunds.reserveRefundAndApproveReturnAtomically(
        {
          transactionId: activeTx.id,
          packageId: ret.packageId,
          expectedTxStates: ['CAPTURED', 'PARTIALLY_REFUNDED'],
          refundInput: {
            transactionId: activeTx.id,
            orderId: ret.orderId,
            returnId: ret.id,
            merchantId: ret.merchantId,
            packageId: ret.packageId,
            captureId: activeTx.captureId!,
            paypalRequestId,
            amount: refundAmount,
            currency: activeTx.currency,
            reason: approvalReason,
            state: 'REFUND_REQUESTED',
            idempotencyKey,
            initiatedBy: caller.userId,
          },
          returnUpdate: {
            returnId: ret.id,
            expectedReturnStatuses: ['UNDER_INSPECTION', 'NEEDS_REVIEW'],
            decision: {
              decidedBy: caller.userId,
              decidedAt: now,
              outcome: 'APPROVED',
              reason: approvalReason,
            },
          },
          event: {
            eventId: `evt_${crypto.randomUUID()}`,
            packageId: ret.packageId,
            merchantId: ret.merchantId,
            type: 'REFUND_REQUESTED',
            actor: { userId: caller.userId, role: caller.role },
            occurredAt: now,
            sourceSystem: 'REBOXIFY_API',
            correlationId: meta?.correlationId ?? ret.id,
            outcome: 'ACCEPTED',
            evidence: [
              {
                type: 'NOTE',
                detail: `Approved & requested partial refund ${activeTx.currency} ${refundAmount.toFixed(2)}`,
              },
            ],
            metadata: {
              returnNumber: ret.returnNumber,
              amount: refundAmount,
              currency: activeTx.currency,
            },
          },
        },
        session
      )
    );

    if (!reserved) {
      throw conflict(
        'Could not reserve refundable deposit balance (exceeds remaining deposit or concurrent update).'
      );
    }

    return this.executeProviderRefundAndSync(
      reserved.returnRecord,
      reserved.refund,
      reserved.transaction,
      caller,
      meta
    );
  }

  async reconcileReturnRefund(
    returnId: string,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<ApproveReturnResult> {
    if (
      caller.role !== 'COLLECTION_CENTRE' &&
      caller.role !== 'MERCHANT_ADMIN' &&
      caller.role !== 'ADMIN'
    ) {
      throw forbidden('Not authorized to reconcile return refunds.');
    }

    const ret = await this.returns.findById(returnId);
    if (!ret) throw notFound('Return not found.');
    if (caller.role === 'MERCHANT_ADMIN' && ret.merchantId !== caller.businessId) {
      throw forbidden('Cross-tenant reconciliation denied.');
    }

    const refund = await this.refunds.findByReturnId(ret.id);
    if (!refund) {
      throw notFound('No refund attempt found for this return.');
    }

    const tx = await this.transactions.findById(refund.transactionId);
    if (!tx) throw notFound('Linked payment transaction not found.');

    if (refund.state === 'REFUNDED') {
      return {
        returnRecord: ret,
        refund,
        transaction: tx,
        pending: false,
        alreadyRefunded: true,
        zeroRefundApproved: false,
        message: 'Refund is already confirmed as REFUNDED.',
      };
    }

    if (refund.state === 'REFUND_FAILED') {
      // First verify with PayPal in case providerRefundId was already completed asynchronously.
      if (refund.providerRefundId && this.paypal.getRefund) {
        try {
          const check = await this.paypal.getRefund(refund.providerRefundId);
          if (check.status?.toUpperCase() === 'COMPLETED') {
            return this.applyProviderRefundStatus(ret, refund, tx, check, caller, meta);
          }
        } catch {
          // Continue to retry reservation check
        }
      }

      const retryReqId = `RBX-REF-RETRY-${crypto.randomBytes(5).toString('hex')}`;
      const reservedRetry = await this.runTx((session) =>
        this.refunds.retryFailedRefundReservationAtomically(
          { refundId: refund.id, newPayPalRequestId: retryReqId },
          session
        )
      );
      if (!reservedRetry) {
        throw conflict(
          'Remaining captured deposit balance is insufficient or state changed concurrently before retry.'
        );
      }

      return this.executeProviderRefundAndSync(
        ret,
        reservedRetry.refund,
        reservedRetry.transaction,
        caller,
        meta
      );
    }

    return this.reconcilePendingRefundInternal(ret, refund, tx, caller, meta);
  }

  async reconcileStuckPendingRefunds(
    minAgeMs = config.pendingReconcileMinAgeMs
  ): Promise<{ checked: number; resolved: number; failed: number }> {
    if (!this.paypal.isConfigured()) {
      return { checked: 0, resolved: 0, failed: 0 };
    }
    const cutoff = new Date(Date.now() - minAgeMs);
    const pendingList = await this.refunds.listPendingOlderThan(cutoff, 50);
    let resolved = 0;
    let failed = 0;

    const systemCaller: AuthPrincipal = {
      userId: 'system-worker',
      email: 'worker@reboxify.internal',
      name: 'ReBoxify Worker',
      role: 'ADMIN',
    };

    for (const refund of pendingList) {
      try {
        const ret = await this.returns.findById(refund.returnId);
        const tx = await this.transactions.findById(refund.transactionId);
        if (!ret || !tx) continue;
        const result = await this.reconcilePendingRefundInternal(ret, refund, tx, systemCaller);
        await this.audit.record({
          actor: { userId: systemCaller.userId, role: systemCaller.role },
          action: result.pending
            ? 'REFUND_RECONCILIATION_STILL_PENDING'
            : 'REFUND_RECONCILIATION_RESOLVED',
          entityType: 'Refund',
          entityId: refund.id,
          businessId: refund.merchantId,
          afterSummary: {
            state: result.refund?.state ?? refund.state,
            pending: result.pending,
          },
        });
        if (!result.pending) {
          resolved += 1;
        }
      } catch (err) {
        failed += 1;
        console.warn('[reboxify-worker] Refund reconciliation item failed:', {
          refundId: refund.id,
          reason: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return { checked: pendingList.length, resolved, failed };
  }
}
