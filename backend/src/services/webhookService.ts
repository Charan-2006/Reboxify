import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { OrderRepository, MongooseOrderRepository } from '../repositories/phase2Repositories.js';
import {
  MongooseTransactionRepository,
  TransactionDto,
  TransactionRepository,
} from '../repositories/phase3Repositories.js';
import {
  MongooseRefundRepository,
  MongooseReturnRepository,
  MongooseWebhookEventRepository,
  RefundRepository,
  ReturnRepository,
  WebhookEventRepository,
} from '../repositories/phase5Repositories.js';
import { paymentStateMachine } from '../stateMachines/machines.js';
import { PaymentStatus } from '../types/domain.js';
import { AppError, badRequest, serviceUnavailable } from '../utils/errors.js';
import { AuditWriter, defaultAuditWriter } from './auditService.js';
import { TransactionRunner } from './businessService.js';
import { defaultTransactionRunner } from '../repositories/phase2Repositories.js';
import { PayPalClient, RestPayPalClient } from './paypalClient.js';

export interface PayPalWebhookHeaders {
  authAlgo?: string;
  certUrl?: string;
  transmissionId?: string;
  transmissionSig?: string;
  transmissionTime?: string;
}

export interface ProcessWebhookResult {
  received: boolean;
  duplicate: boolean;
  ignored: boolean;
  processingState: string;
  eventId: string;
  eventType: string;
  message: string;
}

export class WebhookService {
  constructor(
    private readonly webhooks: WebhookEventRepository = new MongooseWebhookEventRepository(),
    private readonly transactions: TransactionRepository = new MongooseTransactionRepository(),
    private readonly refunds: RefundRepository = new MongooseRefundRepository(),
    private readonly returns: ReturnRepository = new MongooseReturnRepository(),
    private readonly orders: OrderRepository = new MongooseOrderRepository(),
    private readonly paypal: PayPalClient = new RestPayPalClient(),
    private readonly audit: AuditWriter = defaultAuditWriter,
    private readonly runTx: TransactionRunner = defaultTransactionRunner,
    private readonly findTransactionByCaptureId?: (captureId: string) => Promise<TransactionDto | null>
  ) {}

  private async lookupTxByCaptureId(captureId: string): Promise<TransactionDto | null> {
    if (this.findTransactionByCaptureId) {
      return this.findTransactionByCaptureId(captureId);
    }
    const { TransactionModel } = await import('../models/Transaction.js');
    const doc = await TransactionModel.findOne({ captureId }).lean();
    if (!doc) return null;
    return {
      id: doc._id.toString(),
      orderId: doc.orderId.toString(),
      merchantId: doc.merchantId.toString(),
      customerId: doc.customerId.toString(),
      paypalOrderId: doc.paypalOrderId,
      captureId: doc.captureId,
      amount: doc.amount,
      currency: doc.currency,
      state: doc.state,
      depositAllocations: (doc.depositAllocations ?? []).map((a: any) => ({
        packageId: a.packageId,
        allocatedDeposit: a.allocatedDeposit,
        refundedAmount: a.refundedAmount ?? 0,
        pendingRefundAmount: a.pendingRefundAmount ?? 0,
      })),
      approvedAt: doc.approvedAt,
      capturedAt: doc.capturedAt,
      lastReconciledAt: doc.lastReconciledAt,
      providerStatus: doc.providerStatus,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  async processPayPalWebhook(
    headers: PayPalWebhookHeaders,
    eventBody: Record<string, unknown>,
    meta?: { ip?: string; correlationId?: string; webhookIdOverride?: string }
  ): Promise<ProcessWebhookResult> {
    const providerEventId =
      typeof eventBody.id === 'string' && eventBody.id.trim() ? eventBody.id.trim() : '';
    const eventType =
      typeof eventBody.event_type === 'string' && eventBody.event_type.trim()
        ? eventBody.event_type.trim()
        : '';

    if (!providerEventId || !eventType) {
      throw badRequest('Invalid PayPal webhook payload: missing id or event_type.');
    }

    if (
      !headers.authAlgo ||
      !headers.certUrl ||
      !headers.transmissionId ||
      !headers.transmissionSig ||
      !headers.transmissionTime
    ) {
      await this.audit.record({
        actor: { userId: 'paypal-webhook', role: 'PAYPAL_WEBHOOK', ip: meta?.ip },
        action: 'WEBHOOK_HEADERS_MISSING',
        entityType: 'WebhookEvent',
        entityId: providerEventId,
        afterSummary: { eventType },
        correlationId: meta?.correlationId,
      });
      throw new AppError(
        401,
        'WEBHOOK_SIGNATURE_HEADERS_MISSING',
        'Missing required PayPal cryptographic signature headers.'
      );
    }

    const webhookId = meta?.webhookIdOverride || config.paypalWebhookId || '';
    if (!this.paypal.isConfigured() || !this.paypal.verifyWebhookSignature || (!webhookId && !this.paypal.isWebhookConfigured?.())) {
      throw serviceUnavailable('PayPal webhook verification credentials are not configured.');
    }

    let verified = false;
    try {
      verified = await this.paypal.verifyWebhookSignature({
        headers: {
          authAlgo: headers.authAlgo,
          certUrl: headers.certUrl,
          transmissionId: headers.transmissionId,
          transmissionSig: headers.transmissionSig,
          transmissionTime: headers.transmissionTime,
        },
        webhookId,
        webhookEvent: eventBody,
      });
    } catch (err) {
      await this.audit.record({
        actor: { userId: 'paypal-webhook', role: 'PAYPAL_WEBHOOK', ip: meta?.ip },
        action: 'WEBHOOK_VERIFICATION_ERROR',
        entityType: 'WebhookEvent',
        entityId: providerEventId,
        afterSummary: { eventType, err: err instanceof Error ? err.message : 'verify error' },
        correlationId: meta?.correlationId,
      });
      throw new AppError(
        502,
        'WEBHOOK_VERIFICATION_UNAVAILABLE',
        'Failed to verify PayPal webhook signature with PayPal API.'
      );
    }

    if (!verified) {
      await this.audit.record({
        actor: { userId: 'paypal-webhook', role: 'PAYPAL_WEBHOOK', ip: meta?.ip },
        action: 'WEBHOOK_SIGNATURE_INVALID',
        entityType: 'WebhookEvent',
        entityId: providerEventId,
        afterSummary: { eventType },
        correlationId: meta?.correlationId,
      });
      throw new AppError(
        401,
        'INVALID_WEBHOOK_SIGNATURE',
        'PayPal webhook signature verification failed.'
      );
    }

    const resource = (eventBody.resource ?? {}) as Record<string, unknown>;
    const resourceId = typeof resource.id === 'string' ? resource.id : undefined;
    const resourceSnapshot: Record<string, unknown> = {
      ...(typeof resource.id === 'string' ? { id: resource.id } : {}),
      ...(typeof resource.status === 'string' ? { status: resource.status } : {}),
      ...(typeof resource.invoice_id === 'string' ? { invoice_id: resource.invoice_id } : {}),
      ...(resource.amount !== undefined ? { amount: resource.amount } : {}),
      ...(resource.supplementary_data !== undefined
        ? { supplementary_data: resource.supplementary_data }
        : {}),
      ...(Array.isArray(resource.disputed_transactions)
        ? { disputed_transactions: resource.disputed_transactions }
        : {}),
    };

    // Persist verified event atomically with deduplication by unique providerEventId
    const existing = await this.webhooks.findByProviderEventId(providerEventId);
    if (
      existing &&
      (existing.processingState === 'PROCESSED' || existing.processingState === 'IGNORED')
    ) {
      return {
        received: true,
        duplicate: true,
        ignored: existing.processingState === 'IGNORED',
        processingState: existing.processingState,
        eventId: providerEventId,
        eventType,
        message: 'Duplicate PayPal webhook event safely ignored.',
      };
    }

    if (!existing) {
      const insert = await this.webhooks.createUnique({
        provider: 'PAYPAL',
        providerEventId,
        eventType,
        resourceId,
        payloadSummary: {
          summary: eventBody.summary,
          status: resource.status,
          amount: resource.amount,
          relatedIds: (resource.supplementary_data as any)?.related_ids,
        },
        resourceSnapshot,
        verificationResult: 'VERIFIED',
        processingState: 'RECEIVED',
      });
      if (!insert.created && (insert.record.processingState === 'PROCESSED' || insert.record.processingState === 'IGNORED')) {
        return {
          received: true,
          duplicate: true,
          ignored: insert.record.processingState === 'IGNORED',
          processingState: insert.record.processingState,
          eventId: providerEventId,
          eventType,
          message: 'Concurrent duplicate webhook safely deduplicated.',
        };
      }
    }

    try {
      const outcome = await this.dispatchVerifiedEvent(
        providerEventId,
        eventType,
        resource,
        resourceId,
        meta?.correlationId
      );

      await this.webhooks.updateProcessingState(providerEventId, {
        processingState: outcome.ignored ? 'IGNORED' : 'PROCESSED',
        error: outcome.ignored ? outcome.message : undefined,
        processedAt: new Date(),
        nextRetryAt: null,
      });

      return {
        received: true,
        duplicate: false,
        ignored: outcome.ignored,
        processingState: outcome.ignored ? 'IGNORED' : 'PROCESSED',
        eventId: providerEventId,
        eventType,
        message: outcome.message,
      };
    } catch (err) {
      const nextRetryCount = (existing?.retryCount ?? 0) + 1;
      const delayMs = Math.min(3_600_000, 30_000 * Math.pow(2, Math.min(nextRetryCount - 1, 7)));
      await this.webhooks.updateProcessingState(providerEventId, {
        processingState: 'FAILED',
        error: err instanceof Error ? err.message : 'Webhook handler failure',
        retryCount: nextRetryCount,
        nextRetryAt: new Date(Date.now() + delayMs),
      });
      throw err;
    }
  }

  /**
   * Durably retries VERIFIED PayPal webhook events whose downstream processing failed.
   * Preserves idempotency and never re-trusts unverified events.
   */
  async retryFailedWebhooks(
    limit = 20,
    maxRetries = config.webhookMaxRetries
  ): Promise<{ checked: number; processed: number; ignored: number; failed: number }> {
    if (!this.webhooks.listRetryableFailed || !this.paypal.isConfigured()) {
      return { checked: 0, processed: 0, ignored: 0, failed: 0 };
    }

    const candidates = await this.webhooks.listRetryableFailed(new Date(), maxRetries, limit);
    let processed = 0;
    let ignored = 0;
    let failed = 0;

    for (const evt of candidates) {
      if (evt.verificationResult !== 'VERIFIED') continue;
      const resource =
        evt.resourceSnapshot ??
        ({
          ...(evt.resourceId ? { id: evt.resourceId } : {}),
          ...(evt.payloadSummary?.amount !== undefined ? { amount: evt.payloadSummary.amount } : {}),
          ...(evt.payloadSummary?.relatedIds
            ? { supplementary_data: { related_ids: evt.payloadSummary.relatedIds } }
            : {}),
        } as Record<string, unknown>);

      try {
        const outcome = await this.dispatchVerifiedEvent(
          evt.providerEventId,
          evt.eventType,
          resource,
          evt.resourceId,
          evt.providerEventId
        );
        await this.webhooks.updateProcessingState(evt.providerEventId, {
          processingState: outcome.ignored ? 'IGNORED' : 'PROCESSED',
          error: outcome.ignored ? outcome.message : undefined,
          processedAt: new Date(),
          nextRetryAt: null,
        });
        if (outcome.ignored) {
          ignored += 1;
        } else {
          processed += 1;
        }
      } catch (err) {
        failed += 1;
        const nextRetryCount = (evt.retryCount ?? 0) + 1;
        const delayMs = Math.min(3_600_000, 30_000 * Math.pow(2, Math.min(nextRetryCount - 1, 7)));
        await this.webhooks.updateProcessingState(evt.providerEventId, {
          processingState: 'FAILED',
          error: err instanceof Error ? err.message : 'Webhook retry failure',
          retryCount: nextRetryCount,
          nextRetryAt: new Date(Date.now() + delayMs),
        });
      }
    }

    return { checked: candidates.length, processed, ignored, failed };
  }

  private async dispatchVerifiedEvent(
    providerEventId: string,
    eventType: string,
    resource: Record<string, unknown>,
    resourceId: string | undefined,
    correlationId?: string
  ): Promise<{ ignored: boolean; message: string }> {
    const relatedIds = ((resource.supplementary_data as any)?.related_ids ?? {}) as {
      order_id?: string;
      capture_id?: string;
    };

    if (
      eventType === 'PAYMENT.CAPTURE.COMPLETED' ||
      eventType === 'PAYMENT.CAPTURE.PENDING' ||
      eventType === 'PAYMENT.CAPTURE.DENIED' ||
      eventType === 'PAYMENT.CAPTURE.REVERSED'
    ) {
      let tx = relatedIds.order_id
        ? await this.transactions.findByPayPalOrderId(relatedIds.order_id)
        : null;
      if (!tx && resourceId) {
        tx = await this.lookupTxByCaptureId(resourceId);
      }
      if (!tx) {
        return {
          ignored: true,
          message: `No matching transaction found for capture webhook ${resourceId ?? relatedIds.order_id ?? 'unknown'}.`,
        };
      }

      // Always reconcile against live PayPal order state rather than blindly trusting webhook resource!
      const liveOrder = await this.paypal.getOrder(tx.paypalOrderId);
      const liveCapture = liveOrder.purchase_units?.[0]?.payments?.captures?.[0];
      if (!liveCapture) {
        return {
          ignored: true,
          message: `PayPal order ${tx.paypalOrderId} reports no captures yet.`,
        };
      }

      const captureCurrency = liveCapture.amount?.currency_code?.toUpperCase();
      const captureVal = Number(liveCapture.amount?.value);
      if (captureCurrency && captureCurrency !== tx.currency) {
        return {
          ignored: true,
          message: `Currency mismatch during webhook reconciliation (${captureCurrency} vs ${tx.currency}).`,
        };
      }
      if (!Number.isNaN(captureVal) && Math.abs(captureVal - tx.amount) > 0.01) {
        return {
          ignored: true,
          message: `Amount mismatch during webhook reconciliation (${captureVal} vs ${tx.amount}).`,
        };
      }

      const liveStatus = liveCapture.status?.toUpperCase();
      if (eventType === 'PAYMENT.CAPTURE.COMPLETED' && liveStatus === 'COMPLETED') {
        if (['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(tx.state)) {
          return { ignored: false, message: 'Capture already reconciled as CAPTURED.' };
        }
        const check = paymentStateMachine.validateTransition(tx.state, 'CAPTURED');
        if (!check.allowed) {
          return { ignored: true, message: check.reason ?? 'Cannot transition to CAPTURED.' };
        }
        await this.runTx(async (session) => {
          await this.transactions.transitionState(
            tx!.id,
            ['CREATED', 'APPROVED', 'CAPTURE_PENDING', 'CAPTURE_FAILED'],
            {
              state: 'CAPTURED',
              captureId: liveCapture.id,
              capturedAt: new Date(),
              lastReconciledAt: new Date(),
              providerStatus: liveCapture.status,
            },
            session
          );
          const order = await this.orders.findById(tx!.orderId, session);
          if (order && (order.status === 'PAYMENT_PENDING' || order.status === 'ALLOCATED')) {
            await this.transactions.updateOrderPaymentStatus(tx!.orderId, 'PAID', session);
          }
        });
        return { ignored: false, message: `Capture ${liveCapture.id} reconciled to CAPTURED.` };
      }

      if (eventType === 'PAYMENT.CAPTURE.REVERSED' || liveStatus === 'REVERSED') {
        const nextCheck = paymentStateMachine.validateTransition(tx.state, 'REVERSED');
        if (nextCheck.allowed) {
          await this.transactions.transitionState(tx.id, [tx.state], {
            state: 'REVERSED',
            providerStatus: liveCapture.status,
            lastReconciledAt: new Date(),
          });
          await this.audit.record({
            actor: { userId: 'paypal-webhook', role: 'PAYPAL_WEBHOOK' },
            action: 'PAYMENT_CAPTURE_REVERSED',
            entityType: 'Transaction',
            entityId: tx.id,
            businessId: tx.merchantId,
            afterSummary: { providerEventId, captureId: liveCapture.id },
            correlationId,
          });
        }
        return { ignored: false, message: 'Capture reversal recorded.' };
      }

      const targetMap: Record<string, PaymentStatus> = {
        'PAYMENT.CAPTURE.PENDING': 'CAPTURE_PENDING',
        'PAYMENT.CAPTURE.DENIED': 'CAPTURE_FAILED',
      };
      const targetState = targetMap[eventType];
      if (targetState && paymentStateMachine.validateTransition(tx.state, targetState).allowed) {
        await this.transactions.transitionState(tx.id, [tx.state], {
          state: targetState,
          providerStatus: liveCapture.status,
          lastReconciledAt: new Date(),
        });
      }
      return { ignored: false, message: `Processed capture event ${eventType}.` };
    }

    if (
      eventType === 'PAYMENT.CAPTURE.REFUNDED' ||
      eventType === 'PAYMENT.CAPTURE.REFUND.FAILED' ||
      eventType === 'PAYMENT.CAPTURE.REFUND.DENIED' ||
      eventType === 'PAYMENT.CAPTURE.REFUND.CANCELLED'
    ) {
      if (!resourceId) {
        return { ignored: true, message: 'Refund webhook missing resource refund ID.' };
      }

      // 1. Find existing internally approved Refund (webhook must NEVER bypass inspection/approval!)
      let refund = await this.refunds.findByProviderRefundId(resourceId);
      if (!refund && typeof resource.invoice_id === 'string') {
        const matchedRet = await this.returns.findByReturnNumber(resource.invoice_id);
        if (matchedRet?.refundId) {
          refund = await this.refunds.findById(matchedRet.refundId);
        }
      }

      if (!refund) {
        await this.audit.record({
          actor: { userId: 'paypal-webhook', role: 'PAYPAL_WEBHOOK' },
          action: 'WEBHOOK_UNAPPROVED_REFUND_IGNORED',
          entityType: 'WebhookEvent',
          entityId: providerEventId,
          afterSummary: { resourceId, reason: 'No matching internally approved Refund record exists.' },
          correlationId,
        });
        return {
          ignored: true,
          message: 'No approved internal Refund record matches this PayPal refund webhook.',
        };
      }

      const ret = await this.returns.findById(refund.returnId);
      const tx = await this.transactions.findById(refund.transactionId);
      if (!ret || !tx || !ret.inspection || ret.decision?.outcome !== 'APPROVED') {
        return {
          ignored: true,
          message: 'Refund webhook rejected because return lacks authorized inspection & approval.',
        };
      }

      // Verify linked capture ID if present in webhook
      if (relatedIds.capture_id && tx.captureId && relatedIds.capture_id !== tx.captureId) {
        await this.audit.record({
          actor: { userId: 'paypal-webhook', role: 'PAYPAL_WEBHOOK' },
          action: 'WEBHOOK_CAPTURE_MISMATCH',
          entityType: 'Refund',
          entityId: refund.id,
          businessId: refund.merchantId,
          afterSummary: {
            webhookCaptureId: relatedIds.capture_id,
            expectedCaptureId: tx.captureId,
          },
          correlationId,
        });
        return {
          ignored: true,
          message: `Capture ID mismatch (${relatedIds.capture_id} vs ${tx.captureId}).`,
        };
      }

      // 2. Always reconcile actual refund state against PayPal GET /v2/payments/refunds/{id}
      if (!this.paypal.getRefund) {
        return { ignored: true, message: 'PayPal client cannot query refund status.' };
      }
      const liveRefund = await this.paypal.getRefund(resourceId);
      if (liveRefund.amount) {
        const cur = liveRefund.amount.currency_code?.toUpperCase();
        const amt = Number(liveRefund.amount.value);
        if ((cur && cur !== refund.currency) || (!Number.isNaN(amt) && Math.abs(amt - refund.amount) > 0.01)) {
          return {
            ignored: true,
            message: `Live PayPal refund details (${cur} ${amt}) do not match approved refund (${refund.currency} ${refund.amount}).`,
          };
        }
      }

      const liveStatus = liveRefund.status?.toUpperCase();
      if (liveStatus === 'COMPLETED') {
        if (refund.state === 'REFUNDED') {
          return { ignored: false, message: 'Refund already finalized cleanly.' };
        }
        await this.runTx((session) =>
          this.refunds.finalizeRefundCompletedAtomically(
            {
              refundId: refund!.id,
              providerRefundId: liveRefund.id,
              providerStatus: liveRefund.status,
              confirmedAt: new Date(),
              event: {
                eventId: `evt_${crypto.randomUUID()}`,
                packageId: refund!.packageId,
                merchantId: refund!.merchantId,
                type: 'REFUND_CONFIRMED_WEBHOOK',
                actor: { userId: 'paypal-webhook', role: 'PAYPAL_WEBHOOK' },
                occurredAt: new Date(),
                sourceSystem: 'PAYPAL_WEBHOOK',
                correlationId: correlationId ?? providerEventId,
                outcome: 'ACCEPTED',
                evidence: [
                  {
                    type: 'NOTE',
                    detail: `Webhook ${providerEventId} verified & reconciled refund ${liveRefund.id} COMPLETED`,
                  },
                ],
                metadata: { providerEventId, amount: refund!.amount, currency: refund!.currency },
              },
            },
            session
          )
        );
        return { ignored: false, message: `Refund ${liveRefund.id} confirmed via verified webhook.` };
      }

      if (liveStatus === 'FAILED' || liveStatus === 'CANCELLED') {
        await this.runTx((session) =>
          this.refunds.failRefundAndReleaseReservationAtomically(
            {
              refundId: refund!.id,
              failureReason:
                liveRefund.status_details?.reason || `PayPal refund ${liveStatus} via webhook`,
              providerStatus: liveRefund.status,
              event: {
                eventId: `evt_${crypto.randomUUID()}`,
                packageId: refund!.packageId,
                merchantId: refund!.merchantId,
                type: 'REFUND_FAILED_WEBHOOK',
                actor: { userId: 'paypal-webhook', role: 'PAYPAL_WEBHOOK' },
                occurredAt: new Date(),
                sourceSystem: 'PAYPAL_WEBHOOK',
                correlationId: correlationId ?? providerEventId,
                outcome: 'REJECTED',
                evidence: [{ type: 'NOTE', detail: `Webhook reported refund ${liveStatus}` }],
              },
            },
            session
          )
        );
        return { ignored: false, message: `Refund ${liveRefund.id} marked FAILED via webhook.` };
      }

      return { ignored: false, message: `Refund ${liveRefund.id} currently ${liveRefund.status}.` };
    }

    if (eventType === 'CUSTOMER.DISPUTE.CREATED') {
      const disputedCaptureId =
        (resource.disputed_transactions as Array<{ seller_transaction_id?: string }> | undefined)?.[0]
          ?.seller_transaction_id;
      if (disputedCaptureId) {
        const tx = await this.lookupTxByCaptureId(disputedCaptureId);
        if (tx && paymentStateMachine.validateTransition(tx.state, 'DISPUTED').allowed) {
          await this.transactions.transitionState(tx.id, [tx.state], {
            state: 'DISPUTED',
            providerStatus: 'DISPUTED',
            lastReconciledAt: new Date(),
          });
          await this.audit.record({
            actor: { userId: 'paypal-webhook', role: 'PAYPAL_WEBHOOK' },
            action: 'PAYMENT_DISPUTE_OPENED',
            entityType: 'Transaction',
            entityId: tx.id,
            businessId: tx.merchantId,
            afterSummary: { providerEventId, disputedCaptureId },
            correlationId,
          });
          return { ignored: false, message: 'Transaction marked DISPUTED for review.' };
        }
      }
      return { ignored: true, message: 'No matching transaction for dispute webhook.' };
    }

    return {
      ignored: true,
      message: `Unhandled PayPal webhook event type "${eventType}" recorded as IGNORED.`,
    };
  }
}
