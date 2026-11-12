import crypto from 'node:crypto';
import {
  defaultTransactionRunner,
  MongooseOrderRepository,
  OrderDto,
  OrderRepository,
} from '../repositories/phase2Repositories.js';
import { PaginatedResult } from '../repositories/phase2Types.js';
import {
  DepositAllocationDto,
  MongooseTransactionRepository,
  TransactionDto,
  TransactionRepository,
} from '../repositories/phase3Repositories.js';
import { resolveMerchantScope } from '../middleware/rbac.js';
import { orderStateMachine, paymentStateMachine } from '../stateMachines/machines.js';
import { AuthPrincipal, PaymentStatus } from '../types/domain.js';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  serviceUnavailable,
} from '../utils/errors.js';
import { AuditWriter, defaultAuditWriter } from './auditService.js';
import { TransactionRunner } from './businessService.js';
import { PayPalClient, PayPalClientError, PayPalOrderResponse, RestPayPalClient } from './paypalClient.js';

export interface CreatePayPalOrderResult {
  transaction: TransactionDto;
  paypalOrderId: string;
  alreadyCreated: boolean;
  disclosure: {
    productSubtotal: number;
    depositTotal: number;
    shippingTotal: number;
    taxTotal: number;
    grandTotal: number;
    currency: string;
    depositAllocations: DepositAllocationDto[];
    returnDeadlineAt?: Date;
  };
}

export interface CapturePayPalOrderResult {
  transaction: TransactionDto;
  orderStatus: string;
  alreadyCaptured: boolean;
  pending: boolean;
  message: string;
}

export class PaymentService {
  constructor(
    private readonly transactions: TransactionRepository = new MongooseTransactionRepository(),
    private readonly orders: OrderRepository = new MongooseOrderRepository(),
    private readonly paypal: PayPalClient = new RestPayPalClient(),
    private readonly audit: AuditWriter = defaultAuditWriter,
    private readonly runTx: TransactionRunner = defaultTransactionRunner
  ) {}

  private assertOrderOrTxAccess(
    ownerIds: { customerId: string; merchantId: string },
    caller: AuthPrincipal
  ): void {
    if (caller.role === 'ADMIN') return;
    if (caller.role === 'CUSTOMER') {
      if (ownerIds.customerId !== caller.userId) {
        throw forbidden('Customers may only access their own payment records.');
      }
      return;
    }
    if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      if (ownerIds.merchantId !== caller.businessId) {
        throw forbidden('Cross-tenant access to another merchant payment record is prohibited.');
      }
      return;
    }
    throw forbidden('You are not authorized to access payment records.');
  }

  private buildDisclosure(order: OrderDto, depositAllocations: DepositAllocationDto[]) {
    return {
      productSubtotal: order.totals.productSubtotal,
      depositTotal: order.totals.depositTotal,
      shippingTotal: order.totals.shippingTotal,
      taxTotal: order.totals.taxTotal,
      grandTotal: order.totals.grandTotal,
      currency: order.currency,
      depositAllocations,
      returnDeadlineAt: order.returnDeadlineAt,
    };
  }

  async createPayPalOrder(
    orderId: string,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string; idempotencyKey?: string }
  ): Promise<CreatePayPalOrderResult> {
    const order = await this.orders.findById(orderId);
    if (!order) throw notFound('Order not found.');

    this.assertOrderOrTxAccess(
      { customerId: order.customerId, merchantId: order.merchantId },
      caller
    );

    if (order.allocatedPackages.length === 0) {
      throw badRequest(
        'Order must have allocated reusable packaging before creating a PayPal checkout order.'
      );
    }

    if (order.status === 'PAID' || order.status === 'DISPATCHED' || order.status === 'DELIVERED') {
      throw conflict(`Order ${order.orderNumber} is already paid (${order.status}).`, 'ALREADY_PAID');
    }

    if (order.status === 'CANCELLED') {
      throw conflict(`Cancelled order ${order.orderNumber} cannot be paid.`, 'ORDER_CANCELLED');
    }

    if (order.totals.grandTotal <= 0) {
      throw badRequest('Order total payable must be greater than zero.');
    }

    const depositAllocations: DepositAllocationDto[] = order.allocatedPackages.map((pkg) => ({
      packageId: pkg.packageId,
      allocatedDeposit: pkg.depositAmount,
      refundedAmount: 0,
      pendingRefundAmount: 0,
    }));

    const existingActive = await this.transactions.findActiveByOrderId(order.id);
    if (existingActive) {
      if (
        existingActive.state === 'CAPTURED' ||
        existingActive.state === 'PARTIALLY_REFUNDED' ||
        existingActive.state === 'REFUNDED'
      ) {
        throw conflict('Payment for this order has already been captured.', 'ALREADY_CAPTURED');
      }
      if (existingActive.state === 'CAPTURE_PENDING') {
        throw conflict(
          'A capture for this order is currently pending verification.',
          'CAPTURE_IN_PROGRESS'
        );
      }
      if (
        (existingActive.state === 'CREATED' || existingActive.state === 'APPROVED') &&
        existingActive.amount === order.totals.grandTotal &&
        existingActive.currency === order.currency
      ) {
        return {
          transaction: existingActive,
          paypalOrderId: existingActive.paypalOrderId,
          alreadyCreated: true,
          disclosure: this.buildDisclosure(order, existingActive.depositAllocations),
        };
      }
    }

    if (!this.paypal.isConfigured()) {
      throw serviceUnavailable(
        'PayPal Sandbox credentials are not configured on the backend.'
      );
    }

    const requestId =
      meta?.idempotencyKey || `create-${order.id}-${crypto.randomUUID().slice(0, 8)}`;

    let providerOrder: PayPalOrderResponse;
    try {
      providerOrder = await this.paypal.createOrder({
        internalOrderId: order.id,
        orderNumber: order.orderNumber,
        currency: order.currency,
        productSubtotal: order.totals.productSubtotal,
        depositTotal: order.totals.depositTotal,
        shippingTotal: order.totals.shippingTotal,
        taxTotal: order.totals.taxTotal,
        grandTotal: order.totals.grandTotal,
        requestId,
      });
    } catch (err) {
      if (err instanceof PayPalClientError) {
        throw new AppError(
          err.code === 'PAYPAL_UNCONFIGURED' ? 503 : 502,
          err.code,
          err.message,
          { providerDebugId: err.providerDebugId }
        );
      }
      throw err;
    }

    const createdTx = await this.runTx(async (session) => {
      const tx = await this.transactions.create(
        {
          orderId: order.id,
          merchantId: order.merchantId,
          customerId: order.customerId,
          paypalOrderId: providerOrder.id,
          amount: order.totals.grandTotal,
          currency: order.currency,
          state: 'CREATED',
          depositAllocations,
          providerStatus: providerOrder.status,
        },
        session
      );

      if (order.status !== 'PAYMENT_PENDING') {
        const check = orderStateMachine.validateTransition(order.status, 'PAYMENT_PENDING');
        if (!check.allowed) {
          throw conflict(check.reason ?? 'Cannot move order to PAYMENT_PENDING.');
        }
        await this.transactions.updateOrderPaymentStatus(order.id, 'PAYMENT_PENDING', session);
      }

      await this.audit.record({
        actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
        action: 'PAYPAL_ORDER_CREATED',
        entityType: 'Transaction',
        entityId: tx.id,
        businessId: order.merchantId,
        afterSummary: {
          orderId: order.id,
          paypalOrderId: tx.paypalOrderId,
          amount: tx.amount,
          currency: tx.currency,
          depositAllocations,
        },
        correlationId: meta?.correlationId,
      });

      return tx;
    });

    return {
      transaction: createdTx,
      paypalOrderId: createdTx.paypalOrderId,
      alreadyCreated: false,
      disclosure: this.buildDisclosure(order, depositAllocations),
    };
  }

  async capturePayPalOrder(
    paypalOrderId: string,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string; idempotencyKey?: string }
  ): Promise<CapturePayPalOrderResult> {
    const cleanId = paypalOrderId.trim();
    if (!cleanId) throw badRequest('PayPal order ID is required.');

    const existingTx = await this.transactions.findByPayPalOrderId(cleanId);
    if (!existingTx) {
      throw notFound(`No ReBoxify payment attempt matches PayPal order ID "${cleanId}".`);
    }

    this.assertOrderOrTxAccess(
      { customerId: existingTx.customerId, merchantId: existingTx.merchantId },
      caller
    );

    const order = await this.orders.findById(existingTx.orderId);
    if (!order) {
      throw notFound('Linked ReBoxify order not found.');
    }

    if (
      existingTx.state === 'CAPTURED' ||
      existingTx.state === 'PARTIALLY_REFUNDED' ||
      existingTx.state === 'REFUNDED'
    ) {
      return {
        transaction: existingTx,
        orderStatus: order.status,
        alreadyCaptured: true,
        pending: false,
        message: 'Payment capture already verified.',
      };
    }

    if (
      existingTx.state === 'CAPTURE_FAILED' ||
      existingTx.state === 'REVERSED' ||
      existingTx.state === 'DISPUTED'
    ) {
      throw conflict(
        `Payment attempt is in state ${existingTx.state} and cannot be captured.`,
        'PAYMENT_NOT_CAPTURABLE'
      );
    }

    if (!this.paypal.isConfigured()) {
      throw serviceUnavailable('PayPal Sandbox credentials are not configured on the backend.');
    }

    let workingTx = existingTx;
    let providerResponse: PayPalOrderResponse | null = null;

    // If previously stuck in CAPTURE_PENDING, reconcile provider state rather than re-capturing blindly.
    if (workingTx.state === 'CAPTURE_PENDING') {
      try {
        providerResponse = await this.paypal.getOrder(cleanId);
      } catch (err) {
        if (err instanceof PayPalClientError && (err.code === 'PAYPAL_TIMEOUT' || err.code === 'PAYPAL_NETWORK_ERROR')) {
          return {
            transaction: workingTx,
            orderStatus: order.status,
            alreadyCaptured: false,
            pending: true,
            message: 'PayPal capture status is still pending verification. Please reconcile shortly.',
          };
        }
        throw err;
      }
    } else {
      const check = paymentStateMachine.validateTransition(workingTx.state, 'CAPTURE_PENDING');
      if (!check.allowed) {
        throw conflict(check.reason ?? 'Invalid payment state transition.');
      }

      const locked = await this.transactions.transitionState(
        workingTx.id,
        ['CREATED', 'APPROVED'],
        {
          state: 'CAPTURE_PENDING',
          approvedAt: workingTx.approvedAt ?? new Date(),
        }
      );

      if (!locked) {
        // Concurrent capture request changed state; reload and handle safely.
        const reloaded = await this.transactions.findByPayPalOrderId(cleanId);
        if (reloaded?.state === 'CAPTURED') {
          return {
            transaction: reloaded,
            orderStatus: 'PAID',
            alreadyCaptured: true,
            pending: false,
            message: 'Payment capture already verified.',
          };
        }
        throw conflict('Concurrent capture request in progress; please reconcile.', 'CAPTURE_CONFLICT');
      }

      workingTx = locked;
      const requestId = meta?.idempotencyKey || `capture-${cleanId}`;

      try {
        providerResponse = await this.paypal.captureOrder(cleanId, requestId);
      } catch (err) {
        if (
          err instanceof PayPalClientError &&
          (err.code === 'PAYPAL_TIMEOUT' || err.code === 'PAYPAL_NETWORK_ERROR')
        ) {
          // Uncertain capture outcome: reconcile with GET /v2/checkout/orders/{id} before deciding.
          try {
            providerResponse = await this.paypal.getOrder(cleanId);
          } catch {
            await this.transactions.transitionState(workingTx.id, ['CAPTURE_PENDING'], {
              state: 'CAPTURE_PENDING',
              lastReconciledAt: new Date(),
              providerStatus: 'UNCERTAIN_TIMEOUT',
            });
            await this.audit.record({
              actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
              action: 'PAYMENT_CAPTURE_UNCERTAIN',
              entityType: 'Transaction',
              entityId: workingTx.id,
              businessId: workingTx.merchantId,
              afterSummary: { paypalOrderId: cleanId, state: 'CAPTURE_PENDING' },
              correlationId: meta?.correlationId,
            });
            return {
              transaction: workingTx,
              orderStatus: order.status,
              alreadyCaptured: false,
              pending: true,
              message:
                'Capture request timed out; payment remains in CAPTURE_PENDING pending PayPal reconciliation.',
            };
          }
        } else {
          await this.failCapture(
            workingTx,
            caller,
            err instanceof Error ? err.message : 'PROVIDER_CAPTURE_REJECTED',
            meta
          );
          throw new AppError(
            422,
            'PAYMENT_CAPTURE_FAILED',
            err instanceof Error ? err.message : 'PayPal rejected the payment capture.'
          );
        }
      }
    }

    // Validate provider capture payload against persisted ReBoxify order and transaction.
    const unit = providerResponse.purchase_units?.[0];
    if (unit?.reference_id && unit.reference_id !== order.id) {
      await this.failCapture(workingTx, caller, 'PAYPAL_ORDER_REFERENCE_MISMATCH', meta);
      throw new AppError(
        422,
        'PAYMENT_REFERENCE_MISMATCH',
        'PayPal order reference does not match the target ReBoxify order.'
      );
    }

    const capture = unit?.payments?.captures?.[0];
    if (!capture) {
      if (providerResponse.status === 'APPROVED' || providerResponse.status === 'PAYER_ACTION_REQUIRED') {
        await this.transactions.transitionState(workingTx.id, ['CAPTURE_PENDING'], {
          state: 'CAPTURE_PENDING',
          lastReconciledAt: new Date(),
          providerStatus: providerResponse.status,
        });
        return {
          transaction: workingTx,
          orderStatus: order.status,
          alreadyCaptured: false,
          pending: true,
          message: `PayPal order status is ${providerResponse.status}; capture confirmation is still pending.`,
        };
      }

      await this.failCapture(
        workingTx,
        caller,
        `NO_CAPTURE_IN_STATUS_${providerResponse.status}`,
        meta
      );
      throw new AppError(
        422,
        'PAYMENT_CAPTURE_FAILED',
        `PayPal order is in status ${providerResponse.status} with no verified capture.`
      );
    }

    if (capture.status === 'PENDING') {
      const updatedPending = await this.transactions.transitionState(
        workingTx.id,
        ['CAPTURE_PENDING'],
        {
          state: 'CAPTURE_PENDING',
          captureId: capture.id,
          lastReconciledAt: new Date(),
          providerStatus: 'PENDING',
        }
      );
      return {
        transaction: updatedPending ?? workingTx,
        orderStatus: order.status,
        alreadyCaptured: false,
        pending: true,
        message: 'PayPal capture is pending settlement; dispatch remains blocked until CAPTURED.',
      };
    }

    if (capture.status !== 'COMPLETED') {
      await this.failCapture(workingTx, caller, `CAPTURE_STATUS_${capture.status}`, meta);
      throw new AppError(
        422,
        'PAYMENT_CAPTURE_FAILED',
        `PayPal capture returned status ${capture.status}.`
      );
    }

    const capturedCurrency = capture.amount?.currency_code?.toUpperCase();
    const capturedValue = Number(capture.amount?.value);
    if (
      capturedCurrency !== workingTx.currency ||
      !Number.isFinite(capturedValue) ||
      Math.abs(capturedValue - workingTx.amount) >= 0.01
    ) {
      await this.failCapture(
        workingTx,
        caller,
        `AMOUNT_OR_CURRENCY_MISMATCH_${capturedCurrency}_${capturedValue}`,
        meta
      );
      throw new AppError(
        422,
        'PAYMENT_MISMATCH',
        `Captured amount (${capturedCurrency ?? 'UNKNOWN'} ${capture.amount?.value ?? '?'}) does not match expected order total (${workingTx.currency} ${workingTx.amount.toFixed(2)}).`
      );
    }

    const finalized = await this.runTx(async (session) => {
      const capturedTx = await this.transactions.transitionState(
        workingTx.id,
        ['CAPTURE_PENDING'],
        {
          state: 'CAPTURED',
          captureId: capture.id,
          capturedAt: new Date(),
          lastReconciledAt: new Date(),
          providerStatus: capture.status,
        },
        session
      );
      if (!capturedTx) {
        throw conflict('Payment state changed concurrently during capture confirmation.');
      }

      if (order.status !== 'PAID') {
        const orderCheck = orderStateMachine.validateTransition(order.status, 'PAID');
        if (orderCheck.allowed) {
          await this.transactions.updateOrderPaymentStatus(order.id, 'PAID', session);
        }
      }

      await this.audit.record({
        actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
        action: 'PAYMENT_CAPTURED',
        entityType: 'Transaction',
        entityId: capturedTx.id,
        businessId: workingTx.merchantId,
        afterSummary: {
          orderId: order.id,
          paypalOrderId: cleanId,
          captureId: capture.id,
          amount: capturedValue,
          currency: capturedCurrency,
        },
        correlationId: meta?.correlationId,
      });

      return capturedTx;
    });

    return {
      transaction: finalized,
      orderStatus: 'PAID',
      alreadyCaptured: false,
      pending: false,
      message: 'PayPal payment captured and verified.',
    };
  }

  private async failCapture(
    tx: TransactionDto,
    caller: AuthPrincipal,
    reason: string,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<void> {
    await this.transactions.transitionState(tx.id, ['CREATED', 'APPROVED', 'CAPTURE_PENDING'], {
      state: 'CAPTURE_FAILED',
      lastReconciledAt: new Date(),
      providerStatus: reason,
    });
    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'PAYMENT_CAPTURE_FAILED',
      entityType: 'Transaction',
      entityId: tx.id,
      businessId: tx.merchantId,
      afterSummary: { paypalOrderId: tx.paypalOrderId, reason },
      correlationId: meta?.correlationId,
    });
  }

  async cancelCheckout(
    paypalOrderId: string,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<{ transaction: TransactionDto; orderStatus: string }> {
    const cleanId = paypalOrderId.trim();
    const tx = await this.transactions.findByPayPalOrderId(cleanId);
    if (!tx) throw notFound('Payment attempt not found.');

    this.assertOrderOrTxAccess({ customerId: tx.customerId, merchantId: tx.merchantId }, caller);

    if (tx.state !== 'CREATED' && tx.state !== 'APPROVED') {
      throw conflict(`Cannot cancel payment in state ${tx.state}.`, 'CANNOT_CANCEL_PAYMENT');
    }

    const updated = await this.runTx(async (session) => {
      const cancelledTx = await this.transactions.transitionState(
        tx.id,
        ['CREATED', 'APPROVED'],
        {
          state: 'CAPTURE_FAILED',
          providerStatus: 'CANCELLED_BY_CUSTOMER',
        },
        session
      );
      if (!cancelledTx) throw conflict('Payment state changed concurrently.');

      const order = await this.orders.findById(tx.orderId, session);
      let nextOrderStatus = order?.status ?? 'ALLOCATED';
      if (order && order.status === 'PAYMENT_PENDING') {
        const check = orderStateMachine.validateTransition('PAYMENT_PENDING', 'ALLOCATED');
        if (check.allowed) {
          await this.transactions.updateOrderPaymentStatus(order.id, 'ALLOCATED', session);
          nextOrderStatus = 'ALLOCATED';
        }
      }

      await this.audit.record({
        actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
        action: 'PAYMENT_CHECKOUT_CANCELLED',
        entityType: 'Transaction',
        entityId: cancelledTx.id,
        businessId: tx.merchantId,
        afterSummary: { paypalOrderId: cleanId, orderStatus: nextOrderStatus },
        correlationId: meta?.correlationId,
      });

      return { transaction: cancelledTx, orderStatus: nextOrderStatus };
    });

    return updated;
  }

  async getPaymentById(identifier: string, caller: AuthPrincipal): Promise<TransactionDto> {
    const clean = identifier.trim();
    const tx =
      (await this.transactions.findById(clean)) ??
      (await this.transactions.findByPayPalOrderId(clean)) ??
      (await this.transactions.findLatestByOrderId(clean));

    if (!tx) throw notFound('Payment record not found.');

    this.assertOrderOrTxAccess({ customerId: tx.customerId, merchantId: tx.merchantId }, caller);
    return tx;
  }

  async listTransactions(
    params: {
      merchantId?: string;
      state?: PaymentStatus;
      page: number;
      pageSize: number;
      sortBy?: string;
      sortDir?: 'asc' | 'desc';
    },
    caller: AuthPrincipal
  ): Promise<PaginatedResult<TransactionDto>> {
    if (caller.role === 'ADMIN') {
      return this.transactions.list(params);
    }

    if (caller.role === 'CUSTOMER') {
      return this.transactions.list({
        ...params,
        merchantId: undefined,
        customerId: caller.userId,
      });
    }

    if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      const scopedMerchantId = resolveMerchantScope(caller, params.merchantId);
      return this.transactions.list({
        ...params,
        merchantId: scopedMerchantId,
      });
    }

    throw forbidden('Transactions view is restricted to customers, merchants, and admins.');
  }

  /**
   * Reconciles CAPTURE_PENDING transactions older than minAgeMs against PayPal Orders v2.
   * Never creates a new capture; reads PayPal state and commits/fails atomically.
   */
  async reconcileStuckPendingCaptures(
    minAgeMs = 120_000
  ): Promise<{ checked: number; resolved: number; failed: number }> {
    if (!this.paypal.isConfigured() || !this.transactions.listPendingCapturesOlderThan) {
      return { checked: 0, resolved: 0, failed: 0 };
    }

    const cutoff = new Date(Date.now() - minAgeMs);
    const pendingList = await this.transactions.listPendingCapturesOlderThan(cutoff, 50);
    let resolved = 0;
    let failed = 0;

    const systemCaller: AuthPrincipal = {
      userId: 'system-worker',
      email: 'worker@reboxify.internal',
      name: 'ReBoxify Worker',
      role: 'ADMIN',
    };

    for (const workingTx of pendingList) {
      try {
        const order = await this.orders.findById(workingTx.orderId);
        if (!order) continue;

        const providerResponse = await this.paypal.getOrder(workingTx.paypalOrderId);
        const unit = providerResponse.purchase_units?.[0];
        if (unit?.reference_id && unit.reference_id !== order.id) {
          await this.failCapture(workingTx, systemCaller, 'PAYPAL_ORDER_REFERENCE_MISMATCH');
          resolved += 1;
          continue;
        }

        const capture = unit?.payments?.captures?.[0];
        if (!capture) {
          if (providerResponse.status === 'VOIDED') {
            await this.failCapture(workingTx, systemCaller, 'PAYPAL_ORDER_VOIDED');
            resolved += 1;
          } else {
            await this.transactions.transitionState(workingTx.id, ['CAPTURE_PENDING'], {
              state: 'CAPTURE_PENDING',
              lastReconciledAt: new Date(),
              providerStatus: providerResponse.status,
            });
          }
          continue;
        }

        const capStatus = capture.status?.toUpperCase();
        if (capStatus === 'PENDING') {
          await this.transactions.transitionState(workingTx.id, ['CAPTURE_PENDING'], {
            state: 'CAPTURE_PENDING',
            captureId: capture.id,
            lastReconciledAt: new Date(),
            providerStatus: 'PENDING',
          });
          continue;
        }

        if (capStatus !== 'COMPLETED') {
          await this.failCapture(workingTx, systemCaller, `CAPTURE_STATUS_${capture.status}`);
          resolved += 1;
          continue;
        }

        const capturedCurrency = capture.amount?.currency_code?.toUpperCase();
        const capturedValue = Number(capture.amount?.value);
        if (
          capturedCurrency !== workingTx.currency ||
          !Number.isFinite(capturedValue) ||
          Math.abs(capturedValue - workingTx.amount) >= 0.01
        ) {
          await this.failCapture(
            workingTx,
            systemCaller,
            `AMOUNT_OR_CURRENCY_MISMATCH_${capturedCurrency}_${capturedValue}`
          );
          resolved += 1;
          continue;
        }

        await this.runTx(async (session) => {
          const capturedTx = await this.transactions.transitionState(
            workingTx.id,
            ['CAPTURE_PENDING'],
            {
              state: 'CAPTURED',
              captureId: capture.id,
              capturedAt: new Date(),
              lastReconciledAt: new Date(),
              providerStatus: capture.status,
            },
            session
          );
          if (!capturedTx) return;

          if (order.status !== 'PAID') {
            const orderCheck = orderStateMachine.validateTransition(order.status, 'PAID');
            if (orderCheck.allowed) {
              await this.transactions.updateOrderPaymentStatus(order.id, 'PAID', session);
            }
          }

          await this.audit.record({
            actor: { userId: systemCaller.userId, role: systemCaller.role },
            action: 'PAYMENT_CAPTURED_RECONCILED',
            entityType: 'Transaction',
            entityId: capturedTx.id,
            businessId: workingTx.merchantId,
            afterSummary: {
              orderId: order.id,
              paypalOrderId: workingTx.paypalOrderId,
              captureId: capture.id,
              amount: capturedValue,
              currency: capturedCurrency,
            },
          });
        });

        resolved += 1;
      } catch (err) {
        failed += 1;
        console.warn('[reboxify-worker] Capture reconciliation item failed:', {
          transactionId: workingTx.id,
          reason: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return { checked: pendingList.length, resolved, failed };
  }
}

