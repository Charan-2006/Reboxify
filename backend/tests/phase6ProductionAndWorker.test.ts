import crypto from 'node:crypto';
import mongoose, { ClientSession } from 'mongoose';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { connectDatabase, disconnectDatabase, runInTransaction, sanitizeDbErrorMessage } from '../src/config/db.js';
import { loadConfig } from '../src/config/env.js';
import { IdempotencyRecord, IdempotencyStore } from '../src/middleware/idempotency.js';
import { BusinessDto, BusinessRepository, OrderDto, OrderRepository, PackageDto, PackageRepository, ProductDto, ProductRepository } from '../src/repositories/phase2Repositories.js';
import { TransactionDto, TransactionRepository } from '../src/repositories/phase3Repositories.js';
import { CreatePackageEventInput, PackageEventDto, PassportRepository } from '../src/repositories/phase4Repositories.js';
import { RefundDto, RefundRepository, ReturnDto, ReturnRepository, WebhookEventDto, WebhookEventRepository } from '../src/repositories/phase5Repositories.js';
import { AuditWriter } from '../src/services/auditService.js';
import { AuthService, StoredUserRecord, UserRepository } from '../src/services/authService.js';
import { BusinessService, TransactionRunner } from '../src/services/businessService.js';
import { EvidenceStorage } from '../src/services/evidenceStorage.js';
import { OrderService } from '../src/services/orderService.js';
import { PackagingService } from '../src/services/packagingService.js';
import { PassportService } from '../src/services/passportService.js';
import { PaymentService } from '../src/services/paymentService.js';
import {
  PayPalClient,
  PayPalClientError,
  PayPalOrderResponse,
  PayPalRefundParams,
  PayPalRefundResponse,
} from '../src/services/paypalClient.js';
import { ProductService } from '../src/services/productService.js';
import { QrService } from '../src/services/qrService.js';
import { ReturnService } from '../src/services/returnService.js';
import { WebhookService } from '../src/services/webhookService.js';
import { WorkerLeaseStore, WorkerRunner } from '../src/services/workerRunner.js';
import { OrderStatus, PaymentStatus } from '../src/types/domain.js';

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

class InMemoryIdempotencyStore implements IdempotencyStore {
  private map = new Map<string, IdempotencyRecord>();
  async findByKey(key: string) {
    return this.map.get(key) ?? null;
  }
  async save(record: IdempotencyRecord) {
    this.map.set(record.key, record);
  }
}

function buildPhase6Harness(paypalOverrides: Partial<PayPalClient> = {}) {
  const users = new Map<string, StoredUserRecord>();
  const businesses = new Map<string, BusinessDto>();
  const products = new Map<string, ProductDto>();
  const packages = new Map<string, PackageDto>();
  const orders = new Map<string, OrderDto>();
  const transactions = new Map<string, TransactionDto>();
  const returns = new Map<string, ReturnDto>();
  const refunds = new Map<string, RefundDto>();
  const webhooks = new Map<string, WebhookEventDto>();
  const packageEvents: PackageEventDto[] = [];
  const auditEntries: Array<{ action: string; entityType: string; entityId: string }> = [];

  const qrService = new QrService({
    currentKeyId: 'k1',
    currentSecret: 'phase6-test-qr-secret-32-characters-long!',
    defaultTtlSeconds: 86400,
  });

  const runTx: TransactionRunner = async <T>(work: (s: ClientSession | null) => Promise<T>) =>
    work(null);

  const audit: AuditWriter = {
    async record(entry) {
      auditEntries.push({
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
      });
    },
  };

  const userRepo: UserRepository = {
    async findByEmail(email) {
      for (const u of users.values()) if (u.email === email.toLowerCase().trim()) return u;
      return null;
    },
    async findById(id) {
      return users.get(id) ?? null;
    },
    async create(input) {
      const id = newId();
      const rec: StoredUserRecord = { id, ...input };
      users.set(id, rec);
      return rec;
    },
  };

  const businessRepo: BusinessRepository = {
    async create(input) {
      const id = newId();
      const now = new Date();
      const dto: BusinessDto = { id, ...input, createdAt: now, updatedAt: now };
      businesses.set(id, dto);
      return dto;
    },
    async findById(id) {
      return businesses.get(id) ?? null;
    },
    async findBySlug(slug) {
      for (const b of businesses.values()) if (b.slug === slug) return b;
      return null;
    },
    async list(filters) {
      const items = Array.from(businesses.values());
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
    async updateStatus(id, status) {
      const b = businesses.get(id);
      if (!b) return null;
      b.status = status;
      return b;
    },
    async updatePolicies(id, update) {
      const b = businesses.get(id);
      if (!b) return null;
      if (update.packagingModel) b.packagingModel = update.packagingModel;
      if (update.policies) b.policies = { ...b.policies, ...update.policies };
      return b;
    },
    async linkOwnerUser(userId, businessId) {
      const u = users.get(userId);
      if (u) u.businessId = businessId;
    },
  };

  const productRepo: ProductRepository = {
    async upsert(input) {
      const now = new Date();
      const dto: ProductDto = { id: newId(), ...input, createdAt: now, updatedAt: now };
      products.set(dto.id, dto);
      return dto;
    },
    async findByIds(ids) {
      return ids.map((id) => products.get(id)).filter(Boolean) as ProductDto[];
    },
    async list(filters) {
      const items = Array.from(products.values());
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
  };

  const packageRepo: PackageRepository = {
    async create(input) {
      const now = new Date();
      const dto: PackageDto = {
        id: newId(),
        ...input,
        qrTokenVersion: input.qrTokenVersion ?? 1,
        qrRevoked: false,
        createdAt: now,
        updatedAt: now,
      };
      packages.set(dto.packageId, dto);
      return dto;
    },
    async findByPackageId(packageId) {
      return packages.get(packageId.toUpperCase()) ?? null;
    },
    async list(filters) {
      const items = Array.from(packages.values());
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
    async findCandidatesForAllocation(merchantId, allowSharedPool, allowCrossMerchantHybrid) {
      return Array.from(packages.values()).filter((p) => {
        if (p.status !== 'AVAILABLE' || p.reuseCount >= p.maxLifecycleLimit) return false;
        if (p.ownerType === 'MERCHANT' && p.ownerId === merchantId) return true;
        if (allowSharedPool && p.ownerType === 'REBOXIFY_POOL') return true;
        if (allowCrossMerchantHybrid && p.ownerType === 'HYBRID') return true;
        return false;
      });
    },
    async reservePackagesAtomically(pkgIds, orderId, custodian, event) {
      for (const pid of pkgIds) {
        const p = packages.get(pid);
        if (!p || p.status !== 'AVAILABLE') return [];
        p.status = 'RESERVED';
        p.currentOrderId = orderId;
        p.currentCustodian = custodian;
        packageEvents.push({
          id: newId(),
          eventId: event.eventId,
          packageId: pid,
          type: event.type,
          actor: event.actor,
          occurredAt: event.occurredAt,
          sourceSystem: event.sourceSystem,
          outcome: event.outcome,
          evidence: event.evidence,
        });
      }
      return pkgIds.map((pid) => packages.get(pid)!);
    },
  };

  const orderRepo: OrderRepository = {
    async create(input) {
      const now = new Date();
      const dto: OrderDto = { id: newId(), ...input, createdAt: now, updatedAt: now };
      orders.set(dto.id, dto);
      return dto;
    },
    async findById(id) {
      return orders.get(id) ?? null;
    },
    async findByOrderNumber(num) {
      for (const o of orders.values()) if (o.orderNumber === num) return o;
      return null;
    },
    async list(filters) {
      const items = Array.from(orders.values());
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
    async applyAllocationAtomically(orderId, update) {
      const o = orders.get(orderId);
      if (!o || o.allocatedPackages.length > 0) return null;
      o.allocatedPackages = update.allocatedPackages;
      o.allocationMetadata = update.allocationMetadata;
      o.totals.depositTotal = update.depositTotal;
      o.totals.grandTotal = update.grandTotal;
      o.status = update.status;
      return o;
    },
  };

  const txRepo: TransactionRepository = {
    async create(input) {
      const now = new Date();
      const dto: TransactionDto = { id: newId(), ...input, createdAt: now, updatedAt: now };
      transactions.set(dto.id, dto);
      return dto;
    },
    async findById(id) {
      return transactions.get(id) ?? null;
    },
    async findByPayPalOrderId(ppId) {
      for (const t of transactions.values()) if (t.paypalOrderId === ppId) return t;
      return null;
    },
    async findActiveByOrderId(orderId) {
      for (const t of transactions.values()) {
        if (t.orderId === orderId && ['CREATED', 'APPROVED', 'CAPTURE_PENDING', 'CAPTURED', 'PARTIALLY_REFUNDED', 'REFUND_REQUESTED', 'REFUND_PENDING'].includes(t.state)) {
          return t;
        }
      }
      return null;
    },
    async findLatestByOrderId(orderId) {
      return Array.from(transactions.values()).find((t) => t.orderId === orderId) ?? null;
    },
    async list(filters) {
      const items = Array.from(transactions.values());
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
    async transitionState(txId, fromStates, update) {
      const t = transactions.get(txId);
      if (!t || !fromStates.includes(t.state)) return null;
      Object.assign(t, update, { updatedAt: new Date() });
      return t;
    },
    async updateOrderPaymentStatus(orderId, nextStatus: OrderStatus) {
      const o = orders.get(orderId);
      if (o) o.status = nextStatus;
    },
    async listPendingCapturesOlderThan(cutoffDate, limit = 50) {
      return Array.from(transactions.values())
        .filter((t) => t.state === 'CAPTURE_PENDING' && t.updatedAt <= cutoffDate)
        .slice(0, limit);
    },
  };

  const passportRepo: PassportRepository = {
    async findPackageById(packageId) {
      return packages.get(packageId.toUpperCase()) ?? null;
    },
    async findPackagesByIds(packageIds) {
      return packageIds.map((id) => packages.get(id.toUpperCase())).filter(Boolean) as PackageDto[];
    },
    async findUserSummary(userId) {
      const u = users.get(userId);
      return u ? { id: u.id, name: u.name, email: u.email, role: u.role, status: u.status } : null;
    },
    async listActiveDeliveryPartners() {
      return Array.from(users.values())
        .filter((u) => u.role === 'DELIVERY_PARTNER' && u.status === 'ACTIVE')
        .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status }));
    },
    async findAssignedToPartner(params) {
      const items = Array.from(packages.values()).filter((p) => p.assignedPartnerUserId === params.partnerUserId);
      return { items, total: items.length, page: params.page, pageSize: params.pageSize };
    },
    async findEventsByPackageId(packageId, limit = 50) {
      return packageEvents.filter((e) => e.packageId === packageId).reverse().slice(0, limit);
    },
    async findEventByScanId(packageId, scanId) {
      return packageEvents.find((e) => e.packageId === packageId && e.scanId === scanId) ?? null;
    },
    async recordEvent(event: CreatePackageEventInput) {
      const dto: PackageEventDto = { id: newId(), ...event };
      packageEvents.push(dto);
      return dto;
    },
    async assignDeliveryPartner(params) {
      const p = packages.get(params.packageId);
      if (!p) return null;
      p.assignedPartnerUserId = params.partnerUserId;
      p.assignedPartnerName = params.partnerName;
      const event: PackageEventDto = { id: newId(), ...params.event };
      packageEvents.push(event);
      return { package: p, event };
    },
    async executeAtomicScanTransition(params) {
      const p = packages.get(params.packageId);
      if (!p || !params.expectedStatuses.includes(p.status)) return null;
      p.status = params.targetStatus;
      if (params.newCustodian) p.currentCustodian = params.newCustodian;
      if (params.lastInspectionAt) p.lastInspectionAt = params.lastInspectionAt;
      if (params.lastInspectionOutcome) p.lastInspectionOutcome = params.lastInspectionOutcome;
      if (params.lastCleanedAt) p.lastCleanedAt = params.lastCleanedAt;
      if (params.incrementReuseCount) p.reuseCount += 1;
      if (params.clearOrderAndPartner) {
        p.currentOrderId = undefined;
        p.assignedPartnerUserId = undefined;
        p.assignedPartnerName = undefined;
      }
      let orderUpdated = false;
      if (params.orderUpdate) {
        const o = orders.get(params.orderUpdate.orderId);
        if (o && params.orderUpdate.expectedStatuses.includes(o.status)) {
          o.status = params.orderUpdate.toStatus;
          if (params.orderUpdate.returnDeadlineAt) o.returnDeadlineAt = params.orderUpdate.returnDeadlineAt;
          orderUpdated = true;
        }
      }
      const event: PackageEventDto = { id: newId(), ...params.event };
      packageEvents.push(event);
      return { package: p, event, orderUpdated };
    },
    async updateQrCredentials(params) {
      const p = packages.get(params.packageId);
      if (!p) return null;
      p.qrTokenHash = params.qrTokenHash;
      p.qrTokenVersion = params.qrTokenVersion;
      p.qrRevoked = params.qrRevoked;
      const event: PackageEventDto = { id: newId(), ...params.event };
      packageEvents.push(event);
      return { package: p, event };
    },
  };

  const returnRepo: ReturnRepository = {
    async createReturnWithPackageAtomically(params) {
      const p = packages.get(params.returnDoc.packageId);
      if (!p || p.status !== params.expectedPackageStatus) return null;
      p.status = params.nextPackageStatus;
      const now = new Date();
      const dto: ReturnDto = {
        id: newId(),
        ...params.returnDoc,
        ...(params.pickupRequest ? { pickupId: newId() } : {}),
        createdAt: now,
        updatedAt: now,
      };
      returns.set(dto.id, dto);
      packageEvents.push({ id: newId(), ...params.event });
      return { returnRecord: dto, package: p };
    },
    async findById(id) {
      return returns.get(id) ?? null;
    },
    async findByReturnNumber(num) {
      for (const r of returns.values()) if (r.returnNumber === num) return r;
      return null;
    },
    async findByOrderAndPackage(orderId, packageId) {
      for (const r of returns.values()) {
        if (r.orderId === orderId && r.packageId === packageId) return r;
      }
      return null;
    },
    async list(filters) {
      const items = Array.from(returns.values());
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
    async transitionReturnAndPackageAtomically(params) {
      const r = returns.get(params.returnId);
      if (!r || !params.expectedReturnStatuses.includes(r.status)) return null;
      Object.assign(r, params.returnSet, { updatedAt: new Date() });
      let p: PackageDto | undefined;
      if (params.packageUpdate) {
        p = packages.get(params.packageUpdate.packageId);
        if (!p || !params.packageUpdate.expectedStatuses.includes(p.status)) return null;
        p.status = params.packageUpdate.nextStatus;
        if (params.packageUpdate.newCustodian) p.currentCustodian = params.packageUpdate.newCustodian;
        if (params.packageUpdate.lastInspectionAt) p.lastInspectionAt = params.packageUpdate.lastInspectionAt;
        if (params.packageUpdate.lastInspectionOutcome) p.lastInspectionOutcome = params.packageUpdate.lastInspectionOutcome;
      }
      if (params.event) packageEvents.push({ id: newId(), ...params.event });
      return { returnRecord: r, package: p };
    },
    async appendEvidenceFile(returnId, file) {
      const r = returns.get(returnId);
      if (!r) return null;
      r.evidenceFiles.push(file);
      return r;
    },
  };

  const refundRepo: RefundRepository = {
    async findById(id) {
      return refunds.get(id) ?? null;
    },
    async findByReturnId(returnId) {
      for (const rf of refunds.values()) if (rf.returnId === returnId) return rf;
      return null;
    },
    async findByProviderRefundId(pid) {
      for (const rf of refunds.values()) if (rf.providerRefundId === pid) return rf;
      return null;
    },
    async findByIdempotencyKey(k) {
      for (const rf of refunds.values()) if (rf.idempotencyKey === k) return rf;
      return null;
    },
    async listByTransactionId(txId) {
      return Array.from(refunds.values()).filter((rf) => rf.transactionId === txId);
    },
    async listPendingOlderThan(cutoffDate, limit = 50) {
      return Array.from(refunds.values())
        .filter((rf) => (rf.state === 'REFUND_REQUESTED' || rf.state === 'REFUND_PENDING') && rf.updatedAt <= cutoffDate)
        .slice(0, limit);
    },
    async reserveRefundAndApproveReturnAtomically(params) {
      const tx = transactions.get(params.transactionId);
      const r = returns.get(params.returnUpdate.returnId);
      if (!tx || !params.expectedTxStates.includes(tx.state) || !r || !params.returnUpdate.expectedReturnStatuses.includes(r.status)) {
        return null;
      }
      const alloc = tx.depositAllocations.find((a) => a.packageId === params.packageId);
      if (!alloc) return null;
      if (alloc.allocatedDeposit - alloc.refundedAmount - alloc.pendingRefundAmount < params.refundInput.amount - 0.001) {
        return null;
      }
      alloc.pendingRefundAmount += params.refundInput.amount;
      tx.state = 'REFUND_REQUESTED';
      const now = new Date();
      const rf: RefundDto = { id: newId(), ...params.refundInput, createdAt: now, updatedAt: now };
      refunds.set(rf.id, rf);
      r.status = 'APPROVED';
      r.decision = params.returnUpdate.decision;
      r.refundId = rf.id;
      if (params.event) packageEvents.push({ id: newId(), ...params.event });
      return { refund: rf, transaction: tx, returnRecord: r };
    },
    async markRefundPendingProvider(params) {
      const rf = refunds.get(params.refundId);
      if (!rf) return null;
      rf.state = 'REFUND_PENDING';
      if (params.providerRefundId) rf.providerRefundId = params.providerRefundId;
      if (params.providerStatus) rf.providerStatus = params.providerStatus;
      rf.lastReconciledAt = params.lastReconciledAt;
      rf.updatedAt = new Date();
      const tx = transactions.get(rf.transactionId);
      if (tx && params.txState) tx.state = params.txState;
      return rf;
    },
    async finalizeRefundCompletedAtomically(params) {
      const rf = refunds.get(params.refundId);
      if (!rf) return null;
      rf.state = 'REFUNDED';
      rf.providerRefundId = params.providerRefundId;
      rf.providerStatus = params.providerStatus;
      rf.confirmedAt = params.confirmedAt;
      rf.lastReconciledAt = params.confirmedAt;
      const tx = transactions.get(rf.transactionId);
      if (!tx) return null;
      const alloc = tx.depositAllocations.find((a) => a.packageId === rf.packageId);
      if (alloc) {
        alloc.pendingRefundAmount = Math.max(0, alloc.pendingRefundAmount - rf.amount);
        alloc.refundedAmount += rf.amount;
      }
      tx.state = 'PARTIALLY_REFUNDED';
      const r = returns.get(rf.returnId);
      if (r) r.status = 'CLOSED';
      if (params.event) packageEvents.push({ id: newId(), ...params.event });
      return { refund: rf, transaction: tx, returnRecord: r };
    },
    async failRefundAndReleaseReservationAtomically(params) {
      const rf = refunds.get(params.refundId);
      if (!rf) return null;
      rf.state = 'REFUND_FAILED';
      rf.failureReason = params.failureReason;
      rf.providerStatus = params.providerStatus;
      const tx = transactions.get(rf.transactionId);
      if (!tx) return null;
      const alloc = tx.depositAllocations.find((a) => a.packageId === rf.packageId);
      if (alloc) alloc.pendingRefundAmount = Math.max(0, alloc.pendingRefundAmount - rf.amount);
      tx.state = 'CAPTURED';
      if (params.event) packageEvents.push({ id: newId(), ...params.event });
      return { refund: rf, transaction: tx };
    },
    async retryFailedRefundReservationAtomically(params) {
      const rf = refunds.get(params.refundId);
      const tx = rf ? transactions.get(rf.transactionId) : undefined;
      if (!rf || !tx || rf.state !== 'REFUND_FAILED') return null;
      const alloc = tx.depositAllocations.find((a) => a.packageId === rf.packageId);
      if (!alloc) return null;
      alloc.pendingRefundAmount += rf.amount;
      tx.state = 'REFUND_REQUESTED';
      rf.state = 'REFUND_REQUESTED';
      rf.paypalRequestId = params.newPayPalRequestId;
      return { refund: rf, transaction: tx };
    },
  };

  const webhookRepo: WebhookEventRepository = {
    async findByProviderEventId(providerEventId) {
      return webhooks.get(providerEventId) ?? null;
    },
    async createUnique(input) {
      if (webhooks.has(input.providerEventId)) {
        return { created: false, record: webhooks.get(input.providerEventId)! };
      }
      const rec: WebhookEventDto = {
        id: newId(),
        ...input,
        retryCount: 0,
        receivedAt: new Date(),
      };
      webhooks.set(input.providerEventId, rec);
      return { created: true, record: rec };
    },
    async updateProcessingState(providerEventId, update) {
      const existing = webhooks.get(providerEventId);
      if (!existing) return null;
      Object.assign(existing, {
        ...update,
        ...(update.nextRetryAt === null ? { nextRetryAt: undefined } : {}),
      });
      return existing;
    },
    async listRetryableFailed(now, maxRetries, limit = 20) {
      return Array.from(webhooks.values())
        .filter(
          (w) =>
            w.verificationResult === 'VERIFIED' &&
            w.processingState === 'FAILED' &&
            (w.retryCount ?? 0) < maxRetries &&
            (!w.nextRetryAt || w.nextRetryAt <= now)
        )
        .slice(0, limit);
    },
  };

  const paypalClient: PayPalClient = {
    isConfigured: () => true,
    isWebhookConfigured: () => true,
    async createOrder(params) {
      return {
        id: `PP-ORD-${params.orderNumber}`,
        status: 'CREATED',
        purchase_units: [{ reference_id: params.internalOrderId }],
      };
    },
    async captureOrder(paypalOrderId) {
      return {
        id: paypalOrderId,
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [{ id: `CAP-${paypalOrderId}`, status: 'COMPLETED', amount: { currency_code: 'USD', value: '30.00' } }],
            },
          },
        ],
      };
    },
    async getOrder(paypalOrderId): Promise<PayPalOrderResponse> {
      return {
        id: paypalOrderId,
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [{ id: `CAP-${paypalOrderId}`, status: 'COMPLETED', amount: { currency_code: 'USD', value: '30.00' } }],
              refunds: [],
            },
          },
        ],
      };
    },
    async refundCapture(params: PayPalRefundParams): Promise<PayPalRefundResponse> {
      return {
        id: `REF-${params.requestId}`,
        status: 'COMPLETED',
        invoice_id: params.invoiceId,
        amount: { currency_code: params.currency, value: params.amount.toFixed(2) },
      };
    },
    async getRefund(refundId) {
      return { id: refundId, status: 'COMPLETED' };
    },
    async verifyWebhookSignature() {
      return true;
    },
    ...paypalOverrides,
  };

  const evidenceStorage: EvidenceStorage = {
    async saveEvidence(input) {
      return { fileId: newId(), filename: input.filename, mimeType: input.mimeType, sizeBytes: input.buffer.length };
    },
    async readEvidence() {
      return null;
    },
  };

  const authService = new AuthService(userRepo, audit);
  const businessService = new BusinessService(businessRepo, audit, runTx);
  const productService = new ProductService(productRepo, businessRepo, audit);
  const packagingService = new PackagingService(packageRepo, businessRepo, qrService, audit);
  const orderService = new OrderService(orderRepo, productRepo, packageRepo, businessRepo, audit, runTx);
  const paymentService = new PaymentService(txRepo, orderRepo, paypalClient, audit, runTx);
  const passportService = new PassportService(passportRepo, businessRepo, orderRepo, txRepo, qrService, audit, runTx);
  const returnService = new ReturnService(
    returnRepo,
    refundRepo,
    orderRepo,
    packageRepo,
    businessRepo,
    txRepo,
    passportRepo,
    paypalClient,
    evidenceStorage,
    qrService,
    audit,
    runTx
  );
  const webhookService = new WebhookService(
    webhookRepo,
    txRepo,
    refundRepo,
    returnRepo,
    orderRepo,
    paypalClient,
    audit,
    runTx,
    async (captureId) => {
      for (const t of transactions.values()) if (t.captureId === captureId) return t;
      return null;
    }
  );

  const app = createApp({
    authService,
    businessService,
    productService,
    packagingService,
    orderService,
    paymentService,
    passportService,
    returnService,
    webhookService,
    idempotencyStore: new InMemoryIdempotencyStore(),
  });

  return {
    app,
    users,
    businesses,
    products,
    packages,
    orders,
    transactions,
    returns,
    refunds,
    webhooks,
    auditEntries,
    authService,
    paymentService,
    returnService,
    webhookService,
    paypalClient,
    qrService,
  };
}

async function seedDeliveredReturnContext(
  h: ReturnType<typeof buildPhase6Harness>,
  options: { allocatedDeposit?: number } = {}
) {
  const adminCaller = { userId: 'seed', email: 'seed@reboxify.test', name: 'Seed', role: 'ADMIN' as const };
  const admin = await h.authService.register(
    { name: 'Admin', email: 'admin@reboxify.test', password: 'Password123!', role: 'ADMIN' },
    adminCaller
  );
  const centre = await h.authService.register(
    { name: 'Centre', email: 'centre@reboxify.test', password: 'Password123!', role: 'COLLECTION_CENTRE' },
    { userId: admin.user.userId, email: admin.user.email, name: admin.user.name, role: 'ADMIN' }
  );
  const cust = await h.authService.register({
    name: 'Customer',
    email: 'cust@example.com',
    password: 'Password123!',
  });

  const merchInitial = await h.authService.register(
    { name: 'Merch', email: 'merch@reboxify.test', password: 'Password123!', role: 'MERCHANT_ADMIN' },
    { userId: admin.user.userId, email: admin.user.email, name: admin.user.name, role: 'ADMIN' }
  );

  const bizRes = await request(h.app)
    .post('/api/businesses')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      name: 'EcoLoop',
      legalName: 'EcoLoop Pvt Ltd',
      slug: `ecoloop-${newId().slice(0, 6)}`,
      ownerUserId: merchInitial.user.userId,
      packagingModel: 'HYBRID',
      currency: 'USD',
      status: 'ACTIVE',
    });
  if (bizRes.status !== 201) {
    throw new Error(`Business setup failed: ${bizRes.status} ${JSON.stringify(bizRes.body)}`);
  }
  const merchantId = bizRes.body.business.id as string;
  const merchUser = h.users.get(merchInitial.user.userId)!;
  merchUser.businessId = merchantId;
  const merch = await h.authService.login('merch@reboxify.test', 'Password123!');

  const depositAmt = options.allocatedDeposit ?? 5;
  const pkgId = `RBX-P6-${newId().slice(0, 6).toUpperCase()}`;
  const issued = h.qrService.issuePackageToken(pkgId, 1);
  const pkg = await new PackagingService(
    {
      create: async (inp) => {
        const now = new Date();
        const dto = { id: newId(), ...inp, createdAt: now, updatedAt: now };
        h.packages.set(dto.packageId, dto);
        return dto;
      },
      findByPackageId: async (pid) => h.packages.get(pid) ?? null,
      list: async () => ({ items: [], total: 0, page: 1, pageSize: 25 }),
      findCandidatesForAllocation: async () => [],
      reservePackagesAtomically: async () => [],
    },
    {
      findById: async (id) => h.businesses.get(id) ?? null,
    } as unknown as BusinessRepository,
    h.qrService
  );
  void pkg;

  const pkgDto: PackageDto = {
    id: newId(),
    packageId: pkgId,
    qrTokenHash: issued.tokenHash,
    qrTokenVersion: 1,
    qrRevoked: false,
    ownerType: 'MERCHANT',
    ownerId: merchantId,
    packageClass: 'M',
    dimensionsCm: { length: 30, width: 25, height: 15 },
    maxWeightKg: 8,
    protectionCategory: 'REINFORCED',
    supportsLiquidContainment: true,
    material: 'REUSABLE_PP',
    replacementValue: 20,
    depositAmount: depositAmt,
    currency: 'USD',
    status: 'WITH_CUSTOMER',
    condition: 'NEW',
    reuseCount: 0,
    maxLifecycleLimit: 50,
    fulfilmentLocation: 'CHN-HUB-01',
    currentCustodian: {
      custodianType: 'CUSTOMER',
      custodianId: cust.user.userId,
      label: 'Delivered',
      assignedAt: new Date(),
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const orderId = newId();
  pkgDto.currentOrderId = orderId;
  h.packages.set(pkgId, pkgDto);

  const orderDto: OrderDto = {
    id: orderId,
    orderNumber: `ORD-P6-${newId().slice(0, 6).toUpperCase()}`,
    merchantId,
    customerId: cust.user.userId,
    items: [{ productId: newId(), sku: 'SKU-1', name: 'Item', quantity: 1, unitPrice: 25 }],
    shippingReference: {
      recipientName: 'Customer',
      zone: 'Zone-A',
      addressLine: '42 Green Ave',
      fulfilmentLocation: 'CHN-HUB-01',
    },
    allocatedPackages: [
      {
        packageRef: pkgDto.id,
        packageId: pkgId,
        packageClass: 'M',
        ownerType: 'MERCHANT',
        depositAmount: depositAmt,
      },
    ],
    totals: {
      productSubtotal: 25,
      depositTotal: depositAmt,
      shippingTotal: 0,
      taxTotal: 0,
      grandTotal: 25 + depositAmt,
    },
    currency: 'USD',
    status: 'DELIVERED',
    returnDeadlineAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  h.orders.set(orderId, orderDto);

  const txId = newId();
  const txDto: TransactionDto = {
    id: txId,
    orderId,
    merchantId,
    customerId: cust.user.userId,
    paypalOrderId: `PP-ORD-${orderDto.orderNumber}`,
    captureId: `CAP-${orderDto.orderNumber}`,
    amount: 25 + depositAmt,
    currency: 'USD',
    state: 'CAPTURED',
    depositAllocations: [
      {
        packageId: pkgId,
        allocatedDeposit: depositAmt,
        refundedAmount: 0,
        pendingRefundAmount: 0,
      },
    ],
    capturedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  h.transactions.set(txId, txDto);

  return {
    ...h,
    admin,
    centre,
    cust,
    merch,
    merchantId,
    orderId,
    txId,
    pkgId,
    qrToken: issued.token,
  };
}

describe('Phase 6 — Production Config, Replica-Set Enforcement, Zero-Refunds, Reconciliation, Webhooks & Worker', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.NODE_ENV;
    await disconnectDatabase().catch(() => undefined);
  });

  it('validates worker/API production secrets, rejects placeholder values, and validates PayPal credential pairing', () => {
    expect(() =>
      loadConfig(
        {
          NODE_ENV: 'production',
          MONGODB_URI: 'mongodb+srv://cluster.example/reboxify',
          JWT_SECRET: 'replace-with-a-64-char-random-secret',
          SESSION_SECRET: 'valid-session-secret-more-than-16-chars',
          QR_SIGNING_SECRET: 'valid-qr-signing-secret-more-than-16-chars',
        },
        { service: 'worker' }
      )
    ).toThrow(/placeholder/i);

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        MONGODB_URI: 'mongodb+srv://cluster.example/reboxify',
        JWT_SECRET: 'valid-jwt-secret-more-than-16-chars',
        SESSION_SECRET: 'valid-session-secret-more-than-16-chars',
        QR_SIGNING_SECRET: 'valid-qr-signing-secret-more-than-16-chars',
        PAYPAL_CLIENT_ID: 'client-only',
      })
    ).toThrow(/PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);

    const validWorkerCfg = loadConfig(
      {
        NODE_ENV: 'production',
        MONGODB_URI: 'mongodb+srv://cluster.example/reboxify',
        JWT_SECRET: 'valid-jwt-secret-more-than-16-chars',
        SESSION_SECRET: 'valid-session-secret-more-than-16-chars',
        QR_SIGNING_SECRET: 'valid-qr-signing-secret-more-than-16-chars',
        PAYPAL_CLIENT_ID: 'client-id',
        PAYPAL_CLIENT_SECRET: 'client-secret',
      },
      { service: 'worker' }
    );
    expect(validWorkerCfg.integrations.mongodbConfigured).toBe(true);
    expect(validWorkerCfg.integrations.paypalConfigured).toBe(true);
  });

  it('enforces MongoDB replica-set transactions in production (no silent fallback) and verifies commit/abort & error sanitization', async () => {
    expect(
      sanitizeDbErrorMessage('connect failed for mongodb+srv://alice:SuperSecret123@cluster0.mongodb.net/db')
    ).toBe('connect failed for mongodb+srv://***@cluster0.mongodb.net/db');

    // Simulate connected standalone MongoDB (hello returns no setName)
    vi.spyOn(mongoose, 'connect').mockResolvedValue(mongoose as never);
    Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
    Object.defineProperty(mongoose.connection, 'db', {
      value: {
        admin: () => ({
          command: async () => ({ ok: 1 }), // standalone, no setName
        }),
      },
      configurable: true,
    });

    const standaloneStatus = await connectDatabase('mongodb://localhost:27017/reboxify');
    expect(standaloneStatus.connected).toBe(true);
    expect(standaloneStatus.replicaSetSupported).toBe(false);

    // Production MUST reject non-replica-set transactions with 503 TRANSACTION_INFRASTRUCTURE_UNAVAILABLE
    process.env.NODE_ENV = 'production';
    await expect(runInTransaction(async () => 'ok')).rejects.toMatchObject({
      statusCode: 503,
      code: 'TRANSACTION_INFRASTRUCTURE_UNAVAILABLE',
    });

    // Simulate replica set connected (setName: 'rs0')
    Object.defineProperty(mongoose.connection, 'db', {
      value: {
        admin: () => ({
          command: async () => ({ ok: 1, setName: 'rs0' }),
        }),
      },
      configurable: true,
    });
    const rsStatus = await connectDatabase('mongodb://localhost:27017/reboxify?replicaSet=rs0');
    expect(rsStatus.replicaSetSupported).toBe(true);

    const endSession = vi.fn(async () => undefined);
    const withTransaction = vi.fn(async (cb: () => Promise<void>) => cb());
    vi.spyOn(mongoose, 'startSession').mockResolvedValue({
      withTransaction,
      endSession,
    } as never);

    const committed = await runInTransaction(async (session) => {
      expect(session).toBeDefined();
      return 'committed-ok';
    });
    expect(committed).toBe('committed-ok');
    expect(endSession).toHaveBeenCalledTimes(1);

    await expect(
      runInTransaction(async () => {
        throw new Error('Write failure mid-transaction');
      })
    ).rejects.toThrow('Write failure mid-transaction');
    expect(endSession).toHaveBeenCalledTimes(2);
  });

  it('handles zero-refund GOOD and MAJOR_DAMAGE returns via valid state-machine paths with 0 PayPal calls & idempotent replay', async () => {
    const refundSpy = vi.fn(async (p: PayPalRefundParams): Promise<PayPalRefundResponse> => ({
      id: `REF-${p.requestId}`,
      status: 'COMPLETED',
      amount: { currency_code: p.currency, value: p.amount.toFixed(2) },
    }));

    // 1. GOOD condition with $0 allocated deposit -> UNDER_INSPECTION -> APPROVED -> CLOSED
    const hZeroGood = buildPhase6Harness({ refundCapture: refundSpy });
    const s1 = await seedDeliveredReturnContext(hZeroGood, { allocatedDeposit: 0 });
    const ret1 = await request(s1.app)
      .post('/api/returns')
      .set('Authorization', `Bearer ${s1.cust.token}`)
      .send({ orderId: s1.orderId, packageId: s1.pkgId, mode: 'DROP_OFF', dropoffLocationLabel: 'Hub 1' });
    const ret1Id = ret1.body.returnRecord.id as string;

    await request(s1.app)
      .post(`/api/returns/${ret1Id}/receive`)
      .set('Authorization', `Bearer ${s1.centre.token}`)
      .send({ scanMode: 'QR_TOKEN', qrToken: s1.qrToken });

    await request(s1.app)
      .post(`/api/returns/${ret1Id}/inspect`)
      .set('Authorization', `Bearer ${s1.centre.token}`)
      .send({
        condition: 'GOOD',
        checklist: { identityVerified: true, structuralIntegrity: true, cleanlinessAcceptable: true, completeComponents: true },
      });

    const appZero1 = await request(s1.app)
      .post(`/api/returns/${ret1Id}/approve`)
      .set('Authorization', `Bearer ${s1.centre.token}`)
      .send({});
    expect(appZero1.status).toBe(200);
    expect(appZero1.body.zeroRefundApproved).toBe(true);
    expect(appZero1.body.refund).toBeNull();
    expect(appZero1.body.returnRecord.status).toBe('CLOSED');
    expect(appZero1.body.returnRecord.decision.outcome).toBe('APPROVED');
    expect(refundSpy).not.toHaveBeenCalled();
    expect(s1.refunds.size).toBe(0);

    // Duplicate call without Idempotency-Key remains idempotent
    const appZero1Dup = await request(s1.app)
      .post(`/api/returns/${ret1Id}/approve`)
      .set('Authorization', `Bearer ${s1.centre.token}`)
      .send({});
    expect(appZero1Dup.status).toBe(200);
    expect(appZero1Dup.body.zeroRefundApproved).toBe(true);
    expect(appZero1Dup.body.returnRecord.status).toBe('CLOSED');
    expect(refundSpy).not.toHaveBeenCalled();

    // 2. MAJOR_DAMAGE ($5 deposit forfeited -> $0 refund) -> UNDER_INSPECTION -> REJECTED
    const hDmg = buildPhase6Harness({ refundCapture: refundSpy });
    const s2 = await seedDeliveredReturnContext(hDmg, { allocatedDeposit: 5 });
    const ret2 = await request(s2.app)
      .post('/api/returns')
      .set('Authorization', `Bearer ${s2.cust.token}`)
      .send({ orderId: s2.orderId, packageId: s2.pkgId, mode: 'DROP_OFF', dropoffLocationLabel: 'Hub 2' });
    const ret2Id = ret2.body.returnRecord.id as string;

    await request(s2.app)
      .post(`/api/returns/${ret2Id}/receive`)
      .set('Authorization', `Bearer ${s2.centre.token}`)
      .send({ scanMode: 'QR_TOKEN', qrToken: s2.qrToken });

    await request(s2.app)
      .post(`/api/returns/${ret2Id}/inspect`)
      .set('Authorization', `Bearer ${s2.centre.token}`)
      .send({
        condition: 'MAJOR_DAMAGE',
        damageReason: 'Cracked hinge',
        checklist: { identityVerified: true, structuralIntegrity: false, cleanlinessAcceptable: true, completeComponents: true },
      });

    const appDmg = await request(s2.app)
      .post(`/api/returns/${ret2Id}/approve`)
      .set('Authorization', `Bearer ${s2.centre.token}`)
      .send({});
    expect(appDmg.status).toBe(200);
    expect(appDmg.body.zeroRefundApproved).toBe(true);
    expect(appDmg.body.refund).toBeNull();
    expect(appDmg.body.returnRecord.status).toBe('REJECTED');
    expect(appDmg.body.returnRecord.decision.outcome).toBe('REJECTED');
    expect(refundSpy).not.toHaveBeenCalled();
  });

  it('covers partial/full refund caps, client override rejection, duplicate protection, failed PayPal refund & interrupted timeout reconciliation', async () => {
    let failFirst = true;
    let timeoutSecond = true;
    const refundSpy = vi.fn(async (p: PayPalRefundParams): Promise<PayPalRefundResponse> => {
      if (failFirst) {
        failFirst = false;
        throw new PayPalClientError('PAYPAL_API_ERROR', 'Sandbox insufficient merchant balance', 422);
      }
      if (timeoutSecond) {
        timeoutSecond = false;
        throw new PayPalClientError('PAYPAL_TIMEOUT', 'Gateway read timeout');
      }
      return {
        id: `PP-REF-${p.requestId}`,
        status: 'COMPLETED',
        invoice_id: p.invoiceId,
        amount: { currency_code: p.currency, value: p.amount.toFixed(2) },
      };
    });

    const h = buildPhase6Harness({
      refundCapture: refundSpy,
      getOrder: async (ppOrdId) => ({
        id: ppOrdId,
        status: 'COMPLETED',
        purchase_units: [{ payments: { refunds: [] } }],
      }),
    });
    const s = await seedDeliveredReturnContext(h, { allocatedDeposit: 5 });

    const ret = await request(s.app)
      .post('/api/returns')
      .set('Authorization', `Bearer ${s.cust.token}`)
      .send({ orderId: s.orderId, packageId: s.pkgId, mode: 'DROP_OFF', dropoffLocationLabel: 'Hub 3' });
    const retId = ret.body.returnRecord.id as string;

    await request(s.app)
      .post(`/api/returns/${retId}/receive`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({ scanMode: 'QR_TOKEN', qrToken: s.qrToken });

    // Client override exceeding deposit rejected
    const overrideRes = await request(s.app)
      .post(`/api/returns/${retId}/inspect`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({
        condition: 'MINOR_DAMAGE',
        refundAmount: 99,
        checklist: { identityVerified: true, structuralIntegrity: false, cleanlinessAcceptable: true, completeComponents: true },
      });
    expect(overrideRes.status).toBe(400);
    expect(overrideRes.body.error.code).toBe('CLIENT_REFUND_AMOUNT_FORBIDDEN');

    // Partial refund: MINOR_DAMAGE -> 50% = $2.50 (<= $5 deposit)
    const inspectRes = await request(s.app)
      .post(`/api/returns/${retId}/inspect`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({
        condition: 'MINOR_DAMAGE',
        damageReason: 'Latch chipped',
        checklist: { identityVerified: true, structuralIntegrity: false, cleanlinessAcceptable: true, completeComponents: true },
      });
    expect(inspectRes.body.returnRecord.refundEligibility.calculatedAmount).toBe(2.5);

    // 1. Failed PayPal refund -> 502 + releases reservation
    const failRes = await request(s.app)
      .post(`/api/returns/${retId}/approve`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({});
    expect(failRes.status).toBe(502);
    expect(failRes.body.error.code).toBe('PAYPAL_REFUND_FAILED');
    expect(s.transactions.get(s.txId)!.depositAllocations[0].pendingRefundAmount).toBe(0);

    // 2. Retry interrupted by PAYPAL_TIMEOUT -> safely enters REFUND_PENDING (202)
    const timeoutRes = await request(s.app)
      .post(`/api/returns/${retId}/reconcile-refund`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({});
    expect(timeoutRes.status).toBe(202);
    expect(timeoutRes.body.pending).toBe(true);
    expect(timeoutRes.body.refund.state).toBe('REFUND_PENDING');

    // 3. Worker reconciles pending refund via getOrder when PayPal now reports COMPLETED
    h.paypalClient.getOrder = async (ppOrdId) => ({
      id: ppOrdId,
      status: 'COMPLETED',
      purchase_units: [
        {
          payments: {
            refunds: [
              {
                id: 'PP-REF-RECOVERED-1',
                status: 'COMPLETED',
                invoice_id: ret.body.returnRecord.returnNumber,
                amount: { currency_code: 'USD', value: '2.50' },
              },
            ],
          },
        },
      ],
    });
    const rec = await s.returnService.reconcileStuckPendingRefunds(0);
    expect(rec).toEqual({ checked: 1, resolved: 1, failed: 0 });
    expect(s.transactions.get(s.txId)!.state).toBe('PARTIALLY_REFUNDED');
    expect(s.transactions.get(s.txId)!.depositAllocations[0].refundedAmount).toBe(2.5);

    // 4. Duplicate approve after completion returns alreadyRefunded without new PayPal call
    const callsBeforeDup = refundSpy.mock.calls.length;
    const dupRes = await request(s.app)
      .post(`/api/returns/${retId}/approve`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({});
    expect(dupRes.status).toBe(200);
    expect(dupRes.body.alreadyRefunded).toBe(true);
    expect(refundSpy).toHaveBeenCalledTimes(callsBeforeDup);
  });

  it('reconciles stuck CAPTURE_PENDING transactions, retries failed verified webhooks, and enforces WorkerRunner lock/backoff/shutdown', async () => {
    let getOrderShouldFailOnce = true;
    const h = buildPhase6Harness({
      getOrder: async (ppOrdId) => {
        if (getOrderShouldFailOnce) {
          getOrderShouldFailOnce = false;
          throw new PayPalClientError('PAYPAL_NETWORK_ERROR', 'Temporary DNS failure');
        }
        return {
          id: ppOrdId,
          status: 'COMPLETED',
          purchase_units: [
            {
              reference_id: s.orderId,
              payments: {
                captures: [{ id: 'CAP-RECONCILED-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '30.00' } }],
              },
            },
          ],
        };
      },
    });
    const s = await seedDeliveredReturnContext(h, { allocatedDeposit: 5 });

    // Place order & transaction into PAYMENT_PENDING / CAPTURE_PENDING
    const ord = s.orders.get(s.orderId)!;
    ord.status = 'PAYMENT_PENDING';
    const tx = s.transactions.get(s.txId)!;
    tx.state = 'CAPTURE_PENDING';
    tx.captureId = undefined;
    tx.updatedAt = new Date(Date.now() - 10 * 60 * 1000);

    // Webhook fails downstream on first delivery -> saved FAILED with nextRetryAt
    const whRes = await request(s.app)
      .post('/api/webhooks/paypal')
      .set({
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
        'paypal-transmission-id': 'tx-p6-1',
        'paypal-transmission-sig': 'sig-p6-1',
        'paypal-transmission-time': new Date().toISOString(),
      })
      .send({
        id: 'WH-P6-RETRY-1',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAP-RECONCILED-1',
          status: 'COMPLETED',
          amount: { currency_code: 'USD', value: '30.00' },
          supplementary_data: { related_ids: { order_id: tx.paypalOrderId } },
        },
      });
    expect(whRes.status).toBe(500);
    const savedWh = s.webhooks.get('WH-P6-RETRY-1')!;
    expect(savedWh.processingState).toBe('FAILED');
    expect(savedWh.retryCount).toBe(1);
    savedWh.nextRetryAt = new Date(Date.now() - 1000);

    // First worker cycle reconciles capture AND retries failed webhook cleanly
    const leaseState = { holder: null as string | null };
    const leaseStore: WorkerLeaseStore = {
      async tryAcquire(_job, ownerId) {
        if (leaseState.holder && leaseState.holder !== ownerId) return false;
        leaseState.holder = ownerId;
        return true;
      },
      async recordOutcome() {},
      async release(_job, ownerId) {
        if (leaseState.holder === ownerId) leaseState.holder = null;
      },
    };

    const runner = new WorkerRunner({
      paymentService: s.paymentService,
      returnService: s.returnService,
      webhookService: s.webhookService,
      leaseStore,
      reconcileIntervalMs: 1000,
      pendingReconcileMinAgeMs: 0,
      maxBackoffMs: 16000,
    });

    const cycle1 = await runner.runOnce();
    expect(cycle1.skipped).toBe(false);
    expect(cycle1.captures).toEqual({ checked: 1, resolved: 1, failed: 0 });
    expect(cycle1.webhooks).toEqual({ checked: 1, processed: 1, ignored: 0, failed: 0 });
    expect(s.transactions.get(s.txId)!.state).toBe('CAPTURED');
    expect(s.orders.get(s.orderId)!.status).toBe('PAID');
    expect(s.webhooks.get('WH-P6-RETRY-1')!.processingState).toBe('PROCESSED');

    // Second worker instance cannot acquire while runner1 holds lease
    const runner2 = new WorkerRunner({
      paymentService: s.paymentService,
      returnService: s.returnService,
      webhookService: s.webhookService,
      leaseStore,
    });
    const skipped = await runner2.runOnce();
    expect(skipped).toEqual({
      skipped: true,
      skipReason: 'LEASE_HELD_BY_OTHER',
      nextDelayMs: 60000,
    });

    expect(runner.computeNextDelayMs(0)).toBe(1000);
    expect(runner.computeNextDelayMs(2)).toBe(4000);
    expect(runner.computeNextDelayMs(10)).toBe(16000);

    await runner.stop();
    expect(leaseState.holder).toBeNull();
  });

  it('reports truthful scheduler status (COMMUNITY_READY) and distinct worker health on /api/health', async () => {
    const h = buildPhase6Harness();
    const devRes = await request(h.app).get('/api/health');
    expect(devRes.status).toBe(200);
    expect(devRes.body.integrations.bryntumSchedulerMode).toBe('COMMUNITY_READY');
    expect(devRes.body.integrations.pickupSchedulerConfigured).toBe(true);
    expect(devRes.body.worker).toEqual({ status: 'NOT_DETECTED' });
  });

  it('parses ENABLE_EMBEDDED_WORKER and strips trailing slashes from APP_BASE_URL and CORS_ORIGIN', () => {
    const defaultCfg = loadConfig({ NODE_ENV: 'development' });
    expect(defaultCfg.enableEmbeddedWorker).toBe(false);

    const enabledCfg = loadConfig({
      NODE_ENV: 'development',
      APP_BASE_URL: 'https://reboxify-api.onrender.com/',
      CORS_ORIGIN: 'https://reboxify-web.onrender.com/, https://reboxify.vercel.app/',
      ENABLE_EMBEDDED_WORKER: 'true',
    });
    expect(enabledCfg.enableEmbeddedWorker).toBe(true);
    expect(enabledCfg.appBaseUrl).toBe('https://reboxify-api.onrender.com');
    expect(enabledCfg.corsOrigins).toEqual([
      'https://reboxify-web.onrender.com',
      'https://reboxify.vercel.app',
    ]);
  });
});
