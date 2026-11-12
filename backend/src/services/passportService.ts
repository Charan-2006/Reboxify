import crypto from 'node:crypto';
import {
  BusinessRepository,
  defaultTransactionRunner,
  MongooseBusinessRepository,
  MongooseOrderRepository,
  OrderDto,
  OrderRepository,
  PackageDto,
  PaginatedResult,
} from '../repositories/phase2Repositories.js';
import {
  MongooseTransactionRepository,
  TransactionRepository,
} from '../repositories/phase3Repositories.js';
import {
  AtomicScanTransitionParams,
  CreatePackageEventInput,
  MongoosePassportRepository,
  PackageEventDto,
  PartnerDirectoryEntry,
  PassportRepository,
} from '../repositories/phase4Repositories.js';
import { canDispatchOrder, shouldIncrementReuseCount } from '../stateMachines/gates.js';
import { orderStateMachine, packageStateMachine } from '../stateMachines/machines.js';
import { AuthPrincipal, PackageStatus, UserRole } from '../types/domain.js';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from '../utils/errors.js';
import { AuditWriter, defaultAuditWriter } from './auditService.js';
import { TransactionRunner } from './businessService.js';
import { defaultQrService, QrLabelData, QrService } from './qrService.js';

export const SCAN_ACTIONS = [
  'PACK',
  'DISPATCH',
  'DELIVER',
  'COLLECT_RETURN',
  'RECEIVE_CENTRE',
  'INSPECT_PASS',
  'QUARANTINE',
  'MARK_CLEANING',
  'RELEASE_AVAILABLE',
] as const;

export type ScanAction = (typeof SCAN_ACTIONS)[number];

export interface ScanRequestInput {
  action: ScanAction;
  scanMode?: 'QR_TOKEN' | 'MANUAL_SUPERVISED';
  qrToken?: string;
  scanId?: string;
  assignedPartnerUserId?: string;
  locationRef?: string;
  notes?: string;
  manualReason?: string;
}

export interface PassportEventSummary {
  eventId: string;
  type: string;
  actorRole: string;
  occurredAt: string;
  outcome: 'ACCEPTED' | 'REJECTED';
  locationRef?: string;
  summary: string;
}

export interface DigitalPassportView {
  packageId: string;
  packageClass: PackageDto['packageClass'];
  dimensionsCm: PackageDto['dimensionsCm'];
  maxWeightKg: number;
  protectionCategory: PackageDto['protectionCategory'];
  supportsLiquidContainment: boolean;
  material: string;
  ownership: {
    ownerType: PackageDto['ownerType'];
    ownerId?: string;
    ownerLabel: string;
  };
  status: PackageStatus;
  condition: PackageDto['condition'];
  reuseCount: number;
  maxLifecycleLimit: number;
  fulfilmentLocation: string;
  currentCustodian: {
    custodianType: PackageDto['currentCustodian']['custodianType'];
    custodianId?: string;
    label: string;
    assignedAt: string;
  };
  activeOrder?: {
    orderId: string;
    orderNumber: string;
    status: OrderDto['status'];
    paymentCaptured: boolean;
  };
  assignedPartner?: {
    userId: string;
    name: string;
  };
  qrSecurity: {
    tokenVersion: number;
    revoked: boolean;
    revokedAt?: string;
  };
  cleaningAndInspection: {
    lastInspectionAt?: string;
    lastInspectionOutcome?: 'PASS' | 'FAIL' | 'NEEDS_REVIEW';
    lastCleanedAt?: string;
  };
  sustainability: {
    verified: boolean;
    verifiedReuseCycles: number;
    remainingLifecycleCycles: number;
    singleUsePackagingAvoided: number;
    verificationNote: string;
  };
  lifecycleHistory: PassportEventSummary[];
}

export interface ExecuteScanResult {
  package: PackageDto;
  event: PackageEventDto;
  orderUpdated: boolean;
  scanMode: 'QR_TOKEN' | 'MANUAL_SUPERVISED';
  verifiedKeyId?: string;
  passport: DigitalPassportView;
}

const ACTION_TARGET_STATUS: Record<ScanAction, PackageStatus> = {
  PACK: 'PACKED',
  DISPATCH: 'DISPATCHED',
  DELIVER: 'WITH_CUSTOMER',
  COLLECT_RETURN: 'COLLECTED',
  RECEIVE_CENTRE: 'AT_CENTRE',
  INSPECT_PASS: 'INSPECTED',
  QUARANTINE: 'QUARANTINED',
  MARK_CLEANING: 'CLEANING',
  RELEASE_AVAILABLE: 'AVAILABLE',
};

const ACTION_EVENT_TYPE: Record<ScanAction, string> = {
  PACK: 'PACKAGE_PACKED',
  DISPATCH: 'PACKAGE_DISPATCHED',
  DELIVER: 'PACKAGE_DELIVERED',
  COLLECT_RETURN: 'PACKAGE_RETURN_COLLECTED',
  RECEIVE_CENTRE: 'PACKAGE_RECEIVED_AT_CENTRE',
  INSPECT_PASS: 'PACKAGE_INSPECTED_PASS',
  QUARANTINE: 'PACKAGE_QUARANTINED',
  MARK_CLEANING: 'PACKAGE_MARKED_CLEANING',
  RELEASE_AVAILABLE: 'PACKAGE_RELEASED_AVAILABLE',
};

const SENSITIVE_META_KEYS = new Set([
  'qrToken',
  'rawToken',
  'recipientEmail',
  'recipientAddress',
  'customerEmail',
  'customerAddress',
]);

function sanitizeEventMetadata(meta?: Record<string, unknown>): string {
  if (!meta) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE_META_KEYS.has(k) || v === undefined || v === null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}: ${v}`);
    }
  }
  return parts.join(' | ');
}

function summarizeEvent(evt: PackageEventDto, viewerRole: UserRole): PassportEventSummary {
  const details = sanitizeEventMetadata(evt.metadata);
  const label = evt.type.replace(/_/g, ' ');
  const summary = details ? `${label} (${details})` : label;
  return {
    eventId: evt.eventId,
    type: evt.type,
    actorRole: evt.actor.role,
    occurredAt: new Date(evt.occurredAt).toISOString(),
    outcome: evt.outcome,
    locationRef: viewerRole === 'CUSTOMER' ? undefined : evt.locationRef,
    summary,
  };
}

export class PassportService {
  constructor(
    private readonly passportRepo: PassportRepository = new MongoosePassportRepository(),
    private readonly businesses: BusinessRepository = new MongooseBusinessRepository(),
    private readonly orders: OrderRepository = new MongooseOrderRepository(),
    private readonly transactions: TransactionRepository = new MongooseTransactionRepository(),
    private readonly qr: QrService = defaultQrService,
    private readonly audit: AuditWriter = defaultAuditWriter,
    private readonly runTransaction: TransactionRunner = defaultTransactionRunner
  ) {}

  private assertReadAccess(
    caller: AuthPrincipal,
    pkg: PackageDto,
    order: OrderDto | null
  ): void {
    if (caller.role === 'ADMIN' || caller.role === 'COLLECTION_CENTRE') {
      return;
    }

    if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      if (!caller.businessId) {
        throw forbidden('Merchant account is not linked to an active business.');
      }
      const isOwner = pkg.ownerId === caller.businessId;
      const isOrderMerchant = order?.merchantId === caller.businessId;
      const isCustodian =
        pkg.currentCustodian.custodianType === 'MERCHANT' &&
        pkg.currentCustodian.custodianId === caller.businessId;

      if (isOwner || isOrderMerchant || isCustodian) {
        return;
      }
      if (pkg.ownerType === 'REBOXIFY_POOL' && pkg.status === 'AVAILABLE') {
        return;
      }
      throw forbidden('You are not authorized to access this package passport.');
    }

    if (caller.role === 'DELIVERY_PARTNER') {
      if (pkg.assignedPartnerUserId === caller.userId) {
        return;
      }
      throw forbidden('Package is not assigned to this delivery partner.');
    }

    if (caller.role === 'CUSTOMER') {
      if (order && order.customerId === caller.userId) {
        return;
      }
      throw forbidden('Customers may only inspect passports for their own orders.');
    }

    throw forbidden('Unauthorized role for passport lookup.');
  }

  private assertManageQrAccess(
    caller: AuthPrincipal,
    pkg: PackageDto,
    order: OrderDto | null
  ): void {
    if (caller.role === 'ADMIN') return;
    if (caller.role === 'COLLECTION_CENTRE') {
      if (
        pkg.ownerType === 'REBOXIFY_POOL' ||
        pkg.currentCustodian.custodianType === 'REBOXIFY_CENTRE'
      ) {
        return;
      }
      throw forbidden('Collection centre operators cannot manage QR labels owned off-site by a merchant.');
    }
    if (caller.role === 'MERCHANT_ADMIN') {
      if (!caller.businessId) {
        throw forbidden('Merchant admin must belong to a business.');
      }
      const isOwner = pkg.ownerId === caller.businessId;
      const isCustodian =
        pkg.currentCustodian.custodianType === 'MERCHANT' &&
        pkg.currentCustodian.custodianId === caller.businessId;
      const isOrderMerchant = order?.merchantId === caller.businessId;
      if (isOwner || isCustodian || isOrderMerchant) {
        return;
      }
      throw forbidden('You cannot manage QR credentials for another merchant package.');
    }
    throw forbidden('Only admins, collection centres, or owning merchant admins can manage QR labels.');
  }

  private async buildPassportView(
    pkg: PackageDto,
    order: OrderDto | null,
    caller: AuthPrincipal
  ): Promise<DigitalPassportView> {
    let ownerLabel = 'ReBoxify Shared Network Pool';
    if (pkg.ownerType === 'MERCHANT' && pkg.ownerId) {
      const biz = await this.businesses.findById(pkg.ownerId);
      ownerLabel = biz ? biz.name : 'Merchant Owned Fleet';
    }

    let paymentCaptured = false;
    if (order) {
      const activeTx =
        (await this.transactions.findActiveByOrderId(order.id)) ??
        (await this.transactions.findLatestByOrderId(order.id));
      paymentCaptured = activeTx?.state === 'CAPTURED';
    }

    const events = await this.passportRepo.findEventsByPackageId(pkg.packageId, 50);
    const visibleEvents =
      caller.role === 'CUSTOMER'
        ? events.filter((e) => e.outcome === 'ACCEPTED' && e.type !== 'QR_TOKEN_REVOKED')
        : events;

    const showInternalIds = caller.role !== 'CUSTOMER';
    const verified = pkg.reuseCount > 0;

    return {
      packageId: pkg.packageId,
      packageClass: pkg.packageClass,
      dimensionsCm: pkg.dimensionsCm,
      maxWeightKg: pkg.maxWeightKg,
      protectionCategory: pkg.protectionCategory,
      supportsLiquidContainment: pkg.supportsLiquidContainment,
      material: pkg.material,
      ownership: {
        ownerType: pkg.ownerType,
        ownerId: showInternalIds ? pkg.ownerId : undefined,
        ownerLabel,
      },
      status: pkg.status,
      condition: pkg.condition,
      reuseCount: pkg.reuseCount,
      maxLifecycleLimit: pkg.maxLifecycleLimit,
      fulfilmentLocation: pkg.fulfilmentLocation,
      currentCustodian: {
        custodianType: pkg.currentCustodian.custodianType,
        custodianId: showInternalIds ? pkg.currentCustodian.custodianId : undefined,
        label:
          pkg.currentCustodian.custodianType === 'CUSTOMER'
            ? 'Delivered to Recipient'
            : pkg.currentCustodian.label,
        assignedAt: new Date(pkg.currentCustodian.assignedAt).toISOString(),
      },
      activeOrder: order
        ? {
            orderId: order.id,
            orderNumber: order.orderNumber,
            status: order.status,
            paymentCaptured,
          }
        : undefined,
      assignedPartner:
        pkg.assignedPartnerUserId && showInternalIds
          ? {
              userId: pkg.assignedPartnerUserId,
              name: pkg.assignedPartnerName ?? 'Assigned Partner',
            }
          : undefined,
      qrSecurity: {
        tokenVersion: pkg.qrTokenVersion ?? 1,
        revoked: Boolean(pkg.qrRevoked),
        revokedAt: pkg.qrRevokedAt ? new Date(pkg.qrRevokedAt).toISOString() : undefined,
      },
      cleaningAndInspection: {
        lastInspectionAt: pkg.lastInspectionAt
          ? new Date(pkg.lastInspectionAt).toISOString()
          : undefined,
        lastInspectionOutcome: pkg.lastInspectionOutcome,
        lastCleanedAt: pkg.lastCleanedAt
          ? new Date(pkg.lastCleanedAt).toISOString()
          : undefined,
      },
      sustainability: {
        verified,
        verifiedReuseCycles: pkg.reuseCount,
        remainingLifecycleCycles: Math.max(0, pkg.maxLifecycleLimit - pkg.reuseCount),
        singleUsePackagingAvoided: verified ? pkg.reuseCount : 0,
        verificationNote: verified
          ? `Verified across ${pkg.reuseCount} completed return & passing inspection cycle(s).`
          : 'Sustainability metrics activate only after verified return and passing inspection.',
      },
      lifecycleHistory: visibleEvents.map((e) => summarizeEvent(e, caller.role)),
    };
  }

  async getPassport(packageId: string, caller: AuthPrincipal): Promise<DigitalPassportView> {
    const normalizedId = packageId.trim().toUpperCase();
    const pkg = await this.passportRepo.findPackageById(normalizedId);
    if (!pkg) {
      throw notFound(`Package "${normalizedId}" was not found.`);
    }

    const order = pkg.currentOrderId ? await this.orders.findById(pkg.currentOrderId) : null;
    this.assertReadAccess(caller, pkg, order);
    return this.buildPassportView(pkg, order, caller);
  }

  private async recordRejectedScan(params: {
    packageId: string;
    merchantId?: string;
    caller: AuthPrincipal;
    action: ScanAction;
    scanMode: string;
    code: string;
    reason: string;
    locationRef?: string;
    correlationId?: string;
  }): Promise<void> {
    try {
      await this.passportRepo.recordEvent({
        eventId: `evt_${crypto.randomUUID()}`,
        packageId: params.packageId,
        merchantId: params.merchantId,
        type: 'SCAN_REJECTED',
        actor: { userId: params.caller.userId, role: params.caller.role },
        occurredAt: new Date(),
        sourceSystem: 'REBOXIFY_API',
        correlationId: params.correlationId,
        locationRef: params.locationRef,
        outcome: 'REJECTED',
        evidence: [
          {
            type: 'QR_SCAN',
            detail: `${params.action} [${params.scanMode}] rejected (${params.code}): ${params.reason}`,
          },
        ],
        metadata: {
          attemptedAction: params.action,
          scanMode: params.scanMode,
          reasonCode: params.code,
          reason: params.reason,
        },
      });
    } catch {
      // Do not mask the primary security error if auxiliary rejected-event logging fails (e.g. non-existent pkg in mock).
    }

    await this.audit.record({
      actor: { userId: params.caller.userId, role: params.caller.role },
      action: 'PACKAGE_SCAN_REJECTED',
      entityType: 'Package',
      entityId: params.packageId,
      businessId: params.merchantId,
      afterSummary: {
        attemptedAction: params.action,
        scanMode: params.scanMode,
        code: params.code,
        reason: params.reason,
      },
      correlationId: params.correlationId,
    });
  }

  async executeScan(
    rawPackageId: string,
    input: ScanRequestInput,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<ExecuteScanResult> {
    const packageId = rawPackageId.trim().toUpperCase();
    const scanMode = input.scanMode ?? 'QR_TOKEN';

    const pkg = await this.passportRepo.findPackageById(packageId);
    if (!pkg) {
      await this.recordRejectedScan({
        packageId,
        caller,
        action: input.action,
        scanMode,
        code: 'PACKAGE_NOT_FOUND',
        reason: `Package ${packageId} does not exist.`,
        locationRef: input.locationRef,
        correlationId: meta?.correlationId,
      });
      throw new AppError(404, 'PACKAGE_NOT_FOUND', `Package "${packageId}" was not found.`);
    }

    const order = pkg.currentOrderId ? await this.orders.findById(pkg.currentOrderId) : null;
    const merchantIdForEvent = order?.merchantId ?? pkg.ownerId;

    const failWithLog = async (
      statusCode: 400 | 401 | 403 | 409,
      code: string,
      message: string
    ): Promise<never> => {
      await this.recordRejectedScan({
        packageId: pkg.packageId,
        merchantId: merchantIdForEvent,
        caller,
        action: input.action,
        scanMode,
        code,
        reason: message,
        locationRef: input.locationRef,
        correlationId: meta?.correlationId,
      });
      throw new AppError(statusCode, code, message);
    };

    // 1. Verify QR token security OR supervised manual fallback (customers cannot manually override).
    let verifiedKeyId: string | undefined;
    if (scanMode === 'QR_TOKEN') {
      if (!input.qrToken?.trim()) {
        return failWithLog(400, 'QR_TOKEN_REQUIRED', 'Signed QR token is required for QR scans.');
      }
      const qrResult = this.qr.verifyPackageToken(input.qrToken, pkg);
      if (!qrResult.valid) {
        const statusCode: 401 | 403 =
          qrResult.code === 'QR_REVOKED' || qrResult.code === 'QR_TOKEN_EXPIRED' ? 403 : 401;
        return failWithLog(
          statusCode,
          qrResult.code ?? 'INVALID_QR_TOKEN',
          qrResult.reason ?? 'QR token verification failed.'
        );
      }
      verifiedKeyId = qrResult.keyId;
    } else {
      if (caller.role === 'CUSTOMER') {
        return failWithLog(403, 'MANUAL_FALLBACK_FORBIDDEN', 'Customers cannot use manual scan fallback.');
      }
      if (!input.manualReason || input.manualReason.trim().length < 8) {
        return failWithLog(
          400,
          'MANUAL_REASON_REQUIRED',
          'Manual supervised fallback requires a clear operational reason (min 8 characters).'
        );
      }
      if (input.qrToken?.trim()) {
        const qrResult = this.qr.verifyPackageToken(input.qrToken, pkg);
        if (!qrResult.valid) {
          return failWithLog(
            401,
            qrResult.code ?? 'INVALID_QR_TOKEN',
            qrResult.reason ?? 'Supplied QR token is invalid.'
          );
        }
      }
    }

    // 2. Duplicate / replay scanId check
    if (input.scanId?.trim()) {
      const priorScan = await this.passportRepo.findEventByScanId(pkg.packageId, input.scanId.trim());
      if (priorScan) {
        return failWithLog(
          409,
          'DUPLICATE_SCAN_REPLAY',
          `Scan "${input.scanId.trim()}" has already been applied to ${pkg.packageId}.`
        );
      }
    }

    // 3. Enforce package state machine transition BEFORE executing side-effects
    const targetStatus = ACTION_TARGET_STATUS[input.action];
    const pkgTransition = packageStateMachine.validateTransition(pkg.status, targetStatus);
    if (!pkgTransition.allowed) {
      return failWithLog(
        409,
        'INVALID_STATE_TRANSITION',
        pkgTransition.reason ??
          `Cannot perform ${input.action} while package ${pkg.packageId} is in status ${pkg.status}.`
      );
    }

    // 4. Role, Tenant Ownership, Custody, Delivery Partner Assignment & Gate 1 checks
    const now = new Date();
    let newCustodian: PackageDto['currentCustodian'] | undefined;
    let resolvedPartner: PartnerDirectoryEntry | null = null;
    let clearOrderAndPartner = false;
    let lastInspectionAt: Date | undefined;
    let lastInspectionOutcome: 'PASS' | undefined;
    let lastCleanedAt: Date | undefined;
    let orderUpdate: AtomicScanTransitionParams['orderUpdate'];

    const assertMerchantOwnsContext = async (): Promise<void> => {
      if (!caller.businessId) {
        await failWithLog(403, 'MISSING_MERCHANT_SCOPE', 'Merchant scope missing.');
      }
      const ownsOrder = order?.merchantId === caller.businessId;
      const ownsPkg = pkg.ownerId === caller.businessId;
      const isCustodian =
        pkg.currentCustodian.custodianType === 'MERCHANT' &&
        pkg.currentCustodian.custodianId === caller.businessId;

      if (!ownsOrder && !ownsPkg && !isCustodian) {
        await failWithLog(
          403,
          'CROSS_TENANT_SCAN_DENIED',
          `Merchant is not authorized to scan package ${pkg.packageId}.`
        );
      }
      if (order && !ownsOrder) {
        await failWithLog(
          403,
          'CROSS_TENANT_ORDER_DENIED',
          `Package ${pkg.packageId} is allocated to another merchant's order.`
        );
      }
    };

    const resolvePartnerInput = async (partnerId: string): Promise<PartnerDirectoryEntry> => {
      const candidate = await this.passportRepo.findUserSummary(partnerId);
      if (!candidate || candidate.role !== 'DELIVERY_PARTNER' || candidate.status !== 'ACTIVE') {
        return failWithLog(
          400,
          'INVALID_DELIVERY_PARTNER',
          'Assigned partner must reference an ACTIVE user with DELIVERY_PARTNER role.'
        );
      }
      return candidate;
    };

    switch (input.action) {
      case 'PACK': {
        if (
          caller.role !== 'MERCHANT_ADMIN' &&
          caller.role !== 'MERCHANT_STAFF' &&
          caller.role !== 'ADMIN'
        ) {
          return failWithLog(
            403,
            'UNAUTHORIZED_SCAN_ROLE',
            `Role ${caller.role} cannot pack packages for fulfilment.`
          );
        }
        if (!order || order.status === 'CANCELLED') {
          return failWithLog(
            409,
            'NO_ACTIVE_ORDER',
            `Package ${pkg.packageId} has no active allocated order to pack.`
          );
        }
        if (caller.role !== 'ADMIN') {
          await assertMerchantOwnsContext();
        }
        if (input.assignedPartnerUserId) {
          resolvedPartner = await resolvePartnerInput(input.assignedPartnerUserId);
        }
        break;
      }

      case 'DISPATCH': {
        if (
          caller.role !== 'MERCHANT_ADMIN' &&
          caller.role !== 'MERCHANT_STAFF' &&
          caller.role !== 'DELIVERY_PARTNER' &&
          caller.role !== 'ADMIN'
        ) {
          return failWithLog(
            403,
            'UNAUTHORIZED_SCAN_ROLE',
            `Role ${caller.role} cannot dispatch packages.`
          );
        }
        if (!order || order.status === 'CANCELLED') {
          return failWithLog(
            409,
            'NO_ACTIVE_ORDER',
            `Package ${pkg.packageId} cannot be dispatched without an active order.`
          );
        }
        if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
          await assertMerchantOwnsContext();
        }

        if (input.assignedPartnerUserId) {
          if (caller.role === 'DELIVERY_PARTNER' && input.assignedPartnerUserId !== caller.userId) {
            return failWithLog(
              403,
              'PARTNER_REASSIGNMENT_DENIED',
              'Delivery partners cannot reassign packages to other partners.'
            );
          }
          resolvedPartner = await resolvePartnerInput(input.assignedPartnerUserId);
        } else if (pkg.assignedPartnerUserId) {
          resolvedPartner = {
            id: pkg.assignedPartnerUserId,
            name: pkg.assignedPartnerName ?? 'Assigned Partner',
            email: '',
            role: 'DELIVERY_PARTNER',
            status: 'ACTIVE',
          };
        }

        if (!resolvedPartner) {
          return failWithLog(
            409,
            'PARTNER_ASSIGNMENT_REQUIRED',
            'Assign an active delivery partner before dispatching this package.'
          );
        }

        if (caller.role === 'DELIVERY_PARTNER' && resolvedPartner.id !== caller.userId) {
          return failWithLog(
            403,
            'PARTNER_NOT_ASSIGNED',
            `Delivery partner ${caller.userId} is not assigned to ${pkg.packageId}.`
          );
        }

        // Blueprint Gate 1: Dispatch strictly requires a CAPTURED payment!
        const activeTx =
          (await this.transactions.findActiveByOrderId(order.id)) ??
          (await this.transactions.findLatestByOrderId(order.id));
        const paymentState = activeTx?.state ?? 'CREATED';
        const gate = canDispatchOrder(
          order.status,
          paymentState,
          order.allocatedPackages.length
        );
        if (!gate.allowed) {
          return failWithLog(
            409,
            'DISPATCH_PAYMENT_GATE_BLOCKED',
            gate.reason ?? 'Dispatch requires CAPTURED payment.'
          );
        }

        newCustodian = {
          custodianType: 'DELIVERY_PARTNER',
          custodianId: resolvedPartner.id,
          label: `${resolvedPartner.name} (In Transit)`,
          assignedAt: now,
        };

        const siblingIds = order.allocatedPackages.map((p) => p.packageId);
        const siblingPackages = await this.passportRepo.findPackagesByIds(siblingIds);
        const allOthersReady = siblingPackages
          .filter((s) => s.packageId !== pkg.packageId)
          .every((s) => s.status === 'DISPATCHED' || s.status === 'WITH_CUSTOMER');
        if (allOthersReady && (order.status === 'PAID' || order.status === 'ALLOCATED')) {
          const ordCheck = orderStateMachine.validateTransition(order.status, 'DISPATCHED');
          if (ordCheck.allowed) {
            orderUpdate = {
              orderId: order.id,
              expectedStatuses: ['PAID', 'ALLOCATED'],
              toStatus: 'DISPATCHED',
            };
          }
        }
        break;
      }

      case 'DELIVER': {
        if (caller.role !== 'DELIVERY_PARTNER' && caller.role !== 'ADMIN') {
          return failWithLog(
            403,
            'UNAUTHORIZED_SCAN_ROLE',
            `Only an assigned delivery partner or admin can complete delivery (${caller.role} denied).`
          );
        }
        if (caller.role === 'DELIVERY_PARTNER' && pkg.assignedPartnerUserId !== caller.userId) {
          return failWithLog(
            403,
            'PARTNER_NOT_ASSIGNED',
            `Delivery partner ${caller.userId} is not assigned to package ${pkg.packageId}.`
          );
        }
        if (!order) {
          return failWithLog(409, 'NO_ACTIVE_ORDER', 'Package has no linked order for delivery.');
        }

        const activeTx =
          (await this.transactions.findActiveByOrderId(order.id)) ??
          (await this.transactions.findLatestByOrderId(order.id));
        if (!activeTx || activeTx.state !== 'CAPTURED') {
          return failWithLog(
            409,
            'PAYMENT_NOT_CAPTURED',
            'Delivery confirmation blocked: captured payment record not found.'
          );
        }

        newCustodian = {
          custodianType: 'CUSTOMER',
          custodianId: order.customerId,
          label: `Delivered Ref ${order.orderNumber}`,
          assignedAt: now,
        };

        const siblingIds = order.allocatedPackages.map((p) => p.packageId);
        const siblingPackages = await this.passportRepo.findPackagesByIds(siblingIds);
        const allOthersDelivered = siblingPackages
          .filter((s) => s.packageId !== pkg.packageId)
          .every((s) => s.status === 'WITH_CUSTOMER');

        if (allOthersDelivered && order.status === 'DISPATCHED') {
          const biz = await this.businesses.findById(order.merchantId);
          const windowDays = biz?.policies.returnWindowDays ?? 14;
          const returnDeadlineAt = new Date(
            now.getTime() + windowDays * 24 * 60 * 60 * 1000
          );
          const ordCheck = orderStateMachine.validateTransition(order.status, 'DELIVERED');
          if (ordCheck.allowed) {
            orderUpdate = {
              orderId: order.id,
              expectedStatuses: ['DISPATCHED'],
              toStatus: 'DELIVERED',
              returnDeadlineAt,
            };
          }
        }
        break;
      }

      case 'COLLECT_RETURN': {
        if (caller.role !== 'DELIVERY_PARTNER' && caller.role !== 'ADMIN') {
          return failWithLog(
            403,
            'UNAUTHORIZED_SCAN_ROLE',
            'Only an assigned delivery partner or admin can scan return collection.'
          );
        }
        if (
          caller.role === 'DELIVERY_PARTNER' &&
          pkg.assignedPartnerUserId &&
          pkg.assignedPartnerUserId !== caller.userId
        ) {
          return failWithLog(
            403,
            'PARTNER_NOT_ASSIGNED',
            'Delivery partner is not assigned to collect this return package.'
          );
        }
        newCustodian = {
          custodianType: 'DELIVERY_PARTNER',
          custodianId: caller.userId,
          label: `${caller.name} (Return Transit)`,
          assignedAt: now,
        };
        break;
      }

      case 'RECEIVE_CENTRE': {
        if (caller.role !== 'COLLECTION_CENTRE' && caller.role !== 'ADMIN') {
          return failWithLog(
            403,
            'UNAUTHORIZED_SCAN_ROLE',
            'Only Collection Centre operators or Admins can intake packages at centre.'
          );
        }
        newCustodian = {
          custodianType: 'REBOXIFY_CENTRE',
          custodianId: caller.collectionCenterId ?? 'CENTRE-MAIN',
          label: input.locationRef?.trim() || 'ReBoxify Collection Centre',
          assignedAt: now,
        };
        break;
      }

      case 'INSPECT_PASS': {
        if (caller.role !== 'COLLECTION_CENTRE' && caller.role !== 'ADMIN') {
          return failWithLog(
            403,
            'UNAUTHORIZED_SCAN_ROLE',
            'Only Collection Centre operators or Admins can log passing inspection scans.'
          );
        }
        lastInspectionAt = now;
        lastInspectionOutcome = 'PASS';
        break;
      }

      case 'QUARANTINE': {
        if (
          caller.role !== 'COLLECTION_CENTRE' &&
          caller.role !== 'ADMIN' &&
          caller.role !== 'MERCHANT_ADMIN'
        ) {
          return failWithLog(
            403,
            'UNAUTHORIZED_SCAN_ROLE',
            'Role cannot place package into quarantine.'
          );
        }
        if (caller.role === 'MERCHANT_ADMIN') {
          await assertMerchantOwnsContext();
        }
        break;
      }

      case 'MARK_CLEANING': {
        if (caller.role !== 'COLLECTION_CENTRE' && caller.role !== 'ADMIN') {
          return failWithLog(
            403,
            'UNAUTHORIZED_SCAN_ROLE',
            'Only Collection Centre operators or Admins can route packages to cleaning.'
          );
        }
        break;
      }

      case 'RELEASE_AVAILABLE': {
        if (caller.role !== 'COLLECTION_CENTRE' && caller.role !== 'ADMIN') {
          return failWithLog(
            403,
            'UNAUTHORIZED_SCAN_ROLE',
            'Only Collection Centre operators or Admins can release cleaned packages to inventory.'
          );
        }
        clearOrderAndPartner = true;
        if (pkg.status === 'CLEANING') {
          lastCleanedAt = now;
        }
        if (pkg.ownerType === 'MERCHANT' && pkg.ownerId) {
          const ownerBiz = await this.businesses.findById(pkg.ownerId);
          newCustodian = {
            custodianType: 'MERCHANT',
            custodianId: pkg.ownerId,
            label: ownerBiz ? `${ownerBiz.name} (${pkg.fulfilmentLocation})` : 'Merchant Fleet',
            assignedAt: now,
          };
        } else {
          newCustodian = {
            custodianType: 'REBOXIFY_CENTRE',
            custodianId: caller.collectionCenterId ?? 'CENTRE-MAIN',
            label: `ReBoxify Hub (${pkg.fulfilmentLocation})`,
            assignedAt: now,
          };
        }
        break;
      }
    }

    const incrementReuseCount = shouldIncrementReuseCount(
      pkg.status,
      targetStatus,
      lastInspectionOutcome ?? pkg.lastInspectionOutcome
    );

    const eventInput: CreatePackageEventInput = {
      eventId: `evt_${crypto.randomUUID()}`,
      packageId: pkg.packageId,
      merchantId: merchantIdForEvent,
      scanId: input.scanId?.trim(),
      type: ACTION_EVENT_TYPE[input.action],
      actor: { userId: caller.userId, role: caller.role },
      occurredAt: now,
      sourceSystem: 'REBOXIFY_API',
      correlationId: meta?.correlationId ?? order?.id,
      locationRef: input.locationRef?.trim() || pkg.fulfilmentLocation,
      outcome: 'ACCEPTED',
      evidence: [
        {
          type: 'QR_SCAN',
          detail:
            scanMode === 'QR_TOKEN'
              ? `Verified HMAC QR scan (key=${verifiedKeyId ?? 'unknown'})`
              : `Manual supervised fallback: ${input.manualReason?.trim()}`,
        },
      ],
      metadata: {
        fromStatus: pkg.status,
        toStatus: targetStatus,
        action: input.action,
        scanMode,
        ...(verifiedKeyId ? { verifiedKeyId } : {}),
        ...(input.manualReason ? { manualReason: input.manualReason.trim() } : {}),
        ...(resolvedPartner ? { assignedPartnerUserId: resolvedPartner.id } : {}),
        ...(input.notes ? { notes: input.notes.trim() } : {}),
      },
    };

    const result = await this.runTransaction((session) =>
      this.passportRepo.applyScanTransitionAtomically(
        {
          packageId: pkg.packageId,
          expectedFromStatus: pkg.status,
          toStatus: targetStatus,
          newCustodian,
          clearOrderAndPartner,
          assignedPartnerUserId: resolvedPartner?.id,
          assignedPartnerName: resolvedPartner?.name,
          incrementReuseCount,
          lastInspectionAt,
          lastInspectionOutcome,
          lastCleanedAt,
          event: eventInput,
          orderUpdate,
        },
        session
      )
    );

    if (!result) {
      throw conflict(
        `Concurrent update detected for ${pkg.packageId}; package is no longer ${pkg.status}.`,
        'CONCURRENT_PACKAGE_TRANSITION'
      );
    }

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'PACKAGE_SCAN_ACCEPTED',
      entityType: 'Package',
      entityId: result.package.packageId,
      businessId: merchantIdForEvent,
      beforeSummary: {
        status: pkg.status,
        custodianType: pkg.currentCustodian.custodianType,
        reuseCount: pkg.reuseCount,
      },
      afterSummary: {
        action: input.action,
        scanMode,
        status: result.package.status,
        custodianType: result.package.currentCustodian.custodianType,
        reuseCount: result.package.reuseCount,
        orderUpdated: result.orderUpdated,
      },
      correlationId: meta?.correlationId,
    });

    const latestOrder = result.package.currentOrderId
      ? await this.orders.findById(result.package.currentOrderId)
      : order;
    const passport = await this.buildPassportView(result.package, latestOrder, caller);

    return {
      package: result.package,
      event: result.event,
      orderUpdated: result.orderUpdated,
      scanMode,
      verifiedKeyId,
      passport,
    };
  }

  async assignDeliveryPartner(
    rawPackageId: string,
    partnerUserId: string,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<{ package: PackageDto; partner: PartnerDirectoryEntry }> {
    if (
      caller.role !== 'MERCHANT_ADMIN' &&
      caller.role !== 'MERCHANT_STAFF' &&
      caller.role !== 'ADMIN'
    ) {
      throw forbidden('Only merchants or admins may assign delivery partners.');
    }

    const packageId = rawPackageId.trim().toUpperCase();
    const pkg = await this.passportRepo.findPackageById(packageId);
    if (!pkg) {
      throw notFound(`Package "${packageId}" not found.`);
    }
    if (pkg.status === 'RETIRED') {
      throw conflict('Cannot assign delivery partner to a RETIRED package.');
    }

    const order = pkg.currentOrderId ? await this.orders.findById(pkg.currentOrderId) : null;
    if (caller.role !== 'ADMIN') {
      const ownsOrder = order?.merchantId === caller.businessId;
      const ownsPkg = pkg.ownerId === caller.businessId;
      const isCustodian =
        pkg.currentCustodian.custodianType === 'MERCHANT' &&
        pkg.currentCustodian.custodianId === caller.businessId;
      if (!ownsOrder && !ownsPkg && !isCustodian) {
        throw forbidden('You cannot assign partners for another merchant package.');
      }
    }

    const partner = await this.passportRepo.findUserSummary(partnerUserId.trim());
    if (!partner || partner.role !== 'DELIVERY_PARTNER' || partner.status !== 'ACTIVE') {
      throw badRequest('Target user must be an ACTIVE DELIVERY_PARTNER.');
    }

    const updated = await this.runTransaction((session) =>
      this.passportRepo.assignDeliveryPartner(
        {
          packageId: pkg.packageId,
          partnerUserId: partner.id,
          partnerName: partner.name,
          event: {
            eventId: `evt_${crypto.randomUUID()}`,
            packageId: pkg.packageId,
            merchantId: order?.merchantId ?? pkg.ownerId,
            type: 'PARTNER_ASSIGNED',
            actor: { userId: caller.userId, role: caller.role },
            occurredAt: new Date(),
            sourceSystem: 'REBOXIFY_API',
            correlationId: meta?.correlationId ?? order?.id,
            outcome: 'ACCEPTED',
            evidence: [{ type: 'NOTE', detail: `Assigned partner ${partner.name}` }],
            metadata: { partnerUserId: partner.id, partnerName: partner.name },
          },
        },
        session
      )
    );

    if (!updated) {
      throw notFound(`Package "${packageId}" not found.`);
    }

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'DELIVERY_PARTNER_ASSIGNED',
      entityType: 'Package',
      entityId: updated.package.packageId,
      businessId: order?.merchantId ?? pkg.ownerId,
      afterSummary: {
        assignedPartnerUserId: partner.id,
        assignedPartnerName: partner.name,
      },
      correlationId: meta?.correlationId,
    });

    return { package: updated.package, partner };
  }

  async reprintQrLabel(
    rawPackageId: string,
    reason: string,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<{
    package: PackageDto;
    qrPayload: { packageId: string; token: string; tokenVersion: number; expiresAt: string };
    label: QrLabelData;
  }> {
    const packageId = rawPackageId.trim().toUpperCase();
    const pkg = await this.passportRepo.findPackageById(packageId);
    if (!pkg) {
      throw notFound(`Package "${packageId}" not found.`);
    }

    const order = pkg.currentOrderId ? await this.orders.findById(pkg.currentOrderId) : null;
    this.assertManageQrAccess(caller, pkg, order);

    if (pkg.status === 'RETIRED') {
      throw conflict('Cannot print active QR labels for a RETIRED package.');
    }

    const nextVersion = (pkg.qrTokenVersion ?? 1) + 1;
    const issued = this.qr.issuePackageToken(pkg.packageId, nextVersion);

    const updated = await this.runTransaction((session) =>
      this.passportRepo.updateQrCredentials(
        {
          packageId: pkg.packageId,
          qrTokenHash: issued.tokenHash,
          qrTokenVersion: issued.tokenVersion,
          qrRevoked: false,
          qrRevokedAt: null,
          qrRevokedReason: null,
          event: {
            eventId: `evt_${crypto.randomUUID()}`,
            packageId: pkg.packageId,
            merchantId: order?.merchantId ?? pkg.ownerId,
            type: 'LABEL_REPRINTED',
            actor: { userId: caller.userId, role: caller.role },
            occurredAt: new Date(),
            sourceSystem: 'REBOXIFY_API',
            correlationId: meta?.correlationId,
            outcome: 'ACCEPTED',
            evidence: [{ type: 'NOTE', detail: `QR label reprinted (v${nextVersion}): ${reason}` }],
            metadata: {
              previousVersion: pkg.qrTokenVersion ?? 1,
              newVersion: nextVersion,
              keyId: issued.keyId,
              reason: reason.trim(),
            },
          },
        },
        session
      )
    );

    if (!updated) {
      throw notFound(`Package "${packageId}" not found.`);
    }

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'QR_LABEL_REPRINTED',
      entityType: 'Package',
      entityId: updated.package.packageId,
      businessId: order?.merchantId ?? pkg.ownerId,
      beforeSummary: { tokenVersion: pkg.qrTokenVersion ?? 1, revoked: Boolean(pkg.qrRevoked) },
      afterSummary: { tokenVersion: nextVersion, keyId: issued.keyId, reason: reason.trim() },
      correlationId: meta?.correlationId,
    });

    return {
      package: updated.package,
      qrPayload: {
        packageId: updated.package.packageId,
        token: issued.token,
        tokenVersion: issued.tokenVersion,
        expiresAt: issued.expiresAt.toISOString(),
      },
      label: this.qr.buildLabelData(updated.package, issued),
    };
  }

  async revokeQrToken(
    rawPackageId: string,
    reason: string,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<{ package: PackageDto; event: PackageEventDto }> {
    const packageId = rawPackageId.trim().toUpperCase();
    const pkg = await this.passportRepo.findPackageById(packageId);
    if (!pkg) {
      throw notFound(`Package "${packageId}" not found.`);
    }

    const order = pkg.currentOrderId ? await this.orders.findById(pkg.currentOrderId) : null;
    this.assertManageQrAccess(caller, pkg, order);

    const now = new Date();
    const updated = await this.runTransaction((session) =>
      this.passportRepo.updateQrCredentials(
        {
          packageId: pkg.packageId,
          qrTokenHash: pkg.qrTokenHash,
          qrTokenVersion: pkg.qrTokenVersion ?? 1,
          qrRevoked: true,
          qrRevokedAt: now,
          qrRevokedReason: reason.trim(),
          event: {
            eventId: `evt_${crypto.randomUUID()}`,
            packageId: pkg.packageId,
            merchantId: order?.merchantId ?? pkg.ownerId,
            type: 'QR_TOKEN_REVOKED',
            actor: { userId: caller.userId, role: caller.role },
            occurredAt: now,
            sourceSystem: 'REBOXIFY_API',
            correlationId: meta?.correlationId,
            outcome: 'ACCEPTED',
            evidence: [{ type: 'NOTE', detail: `QR token revoked: ${reason.trim()}` }],
            metadata: {
              tokenVersion: pkg.qrTokenVersion ?? 1,
              reason: reason.trim(),
            },
          },
        },
        session
      )
    );

    if (!updated) {
      throw notFound(`Package "${packageId}" not found.`);
    }

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'QR_TOKEN_REVOKED',
      entityType: 'Package',
      entityId: updated.package.packageId,
      businessId: order?.merchantId ?? pkg.ownerId,
      afterSummary: {
        tokenVersion: updated.package.qrTokenVersion,
        qrRevoked: true,
        reason: reason.trim(),
      },
      correlationId: meta?.correlationId,
    });

    return updated;
  }

  async listDeliveryPartners(caller: AuthPrincipal): Promise<PartnerDirectoryEntry[]> {
    if (
      caller.role !== 'MERCHANT_ADMIN' &&
      caller.role !== 'MERCHANT_STAFF' &&
      caller.role !== 'COLLECTION_CENTRE' &&
      caller.role !== 'ADMIN'
    ) {
      throw forbidden('Not authorized to list delivery partners.');
    }
    return this.passportRepo.listActiveDeliveryPartners();
  }

  async listMyAssignedPackages(
    params: { status?: PackageStatus; page: number; pageSize: number },
    caller: AuthPrincipal
  ): Promise<PaginatedResult<PackageDto>> {
    if (caller.role !== 'DELIVERY_PARTNER' && caller.role !== 'ADMIN') {
      throw forbidden('Only delivery partners or admins may view partner package assignments.');
    }
    return this.passportRepo.findAssignedToPartner({
      partnerUserId: caller.userId,
      status: params.status,
      page: params.page,
      pageSize: params.pageSize,
    });
  }
}
