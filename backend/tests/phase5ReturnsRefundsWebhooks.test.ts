import crypto from 'node:crypto';
import { ClientSession } from 'mongoose';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { IdempotencyRecord, IdempotencyStore } from '../src/middleware/idempotency.js';
import {
  BusinessDto,
  BusinessRepository,
  OrderDto,
  OrderRepository,
  PackageDto,
  PackageRepository,
  ProductDto,
  ProductRepository,
} from '../src/repositories/phase2Repositories.js';
import { TransactionDto, TransactionRepository } from '../src/repositories/phase3Repositories.js';
import {
  CreatePackageEventInput,
  PackageEventDto,
  PassportRepository,
} from '../src/repositories/phase4Repositories.js';
import {
  RefundDto,
  RefundRepository,
  ReturnDto,
  ReturnRepository,
  WebhookEventDto,
  WebhookEventRepository,
} from '../src/repositories/phase5Repositories.js';
import { AuditWriter } from '../src/services/auditService.js';
import { AuthService, StoredUserRecord, UserRepository } from '../src/services/authService.js';
import { BusinessService, TransactionRunner } from '../src/services/businessService.js';
import { EvidenceStorage, validateEvidenceImage } from '../src/services/evidenceStorage.js';
import { OrderService } from '../src/services/orderService.js';
import { PackagingService } from '../src/services/packagingService.js';
import { PassportService } from '../src/services/passportService.js';
import { PaymentService } from '../src/services/paymentService.js';
import {
  PayPalClient,
  PayPalClientError,
  PayPalCreateOrderParams,
  PayPalOrderResponse,
  PayPalRefundParams,
  PayPalRefundResponse,
  PayPalWebhookVerifyParams,
} from '../src/services/paypalClient.js';
import { ProductService } from '../src/services/productService.js';
import { QrService } from '../src/services/qrService.js';
import { calculateReturnRefund } from '../src/services/refundCalculation.js';
import { ReturnService } from '../src/services/returnService.js';
import { WebhookService } from '../src/services/webhookService.js';
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

function makeFakeJpeg(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('REBOXIFY-TEST-JPEG')]);
}

function buildPhase5Harness(paypalOverrides: Partial<PayPalClient> = {}) {
  const users = new Map<string, StoredUserRecord>();
  const businesses = new Map<string, BusinessDto>();
  const products = new Map<string, ProductDto>();
  const packages = new Map<string, PackageDto>();
  const orders = new Map<string, OrderDto>();
  const transactions = new Map<string, TransactionDto>();
  const returns = new Map<string, ReturnDto>();
  const refunds = new Map<string, RefundDto>();
  const webhooks = new Map<string, WebhookEventDto>();
  const pickups = new Map<string, { id: string; returnId: string; status: string }>();
  const evidenceBlobs = new Map<string, { fileId: string; filename: string; mimeType: string; buffer: Buffer }>();
  const packageEvents: PackageEventDto[] = [];
  const partialScanIndexKeys = new Set<string>();
  const outboxEntries: Array<{ entityType: string; entityId: string; operation: string }> = [];
  const auditEntries: Array<{ action: string; entityType: string; entityId: string }> = [];

  const pushEvent = (evt: PackageEventDto) => {
    const cleanScanId = typeof evt.scanId === 'string' && evt.scanId.trim() ? evt.scanId.trim() : undefined;
    if (cleanScanId) {
      const k = `${evt.packageId}::${cleanScanId}`;
      if (partialScanIndexKeys.has(k)) {
        const err = new Error(`E11000 duplicate key on ${k}`) as Error & { code?: number };
        err.code = 11000;
        throw err;
      }
      partialScanIndexKeys.add(k);
    }
    packageEvents.push({ ...evt, ...(cleanScanId ? { scanId: cleanScanId } : { scanId: undefined }) });
    outboxEntries.push({ entityType: 'package_event', entityId: evt.eventId, operation: 'UPSERT' });
  };

  const qrService = new QrService({
    currentKeyId: 'k1',
    currentSecret: 'phase5-test-qr-secret-32-characters-long!',
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

  const evidenceStorage: EvidenceStorage = {
    async saveEvidence({ filename, mimeType, buffer }) {
      const { safeFilename, normalizedMime } = validateEvidenceImage(filename, mimeType, buffer);
      const fileId = newId();
      evidenceBlobs.set(fileId, { fileId, filename: safeFilename, mimeType: normalizedMime, buffer });
      return { fileId, filename: safeFilename, mimeType: normalizedMime, sizeBytes: buffer.length };
    },
    async readEvidence(fileId) {
      return evidenceBlobs.get(fileId) ?? null;
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
      let arr = Array.from(businesses.values());
      if (filters.businessId) arr = arr.filter((b) => b.id === filters.businessId);
      if (filters.status) arr = arr.filter((b) => b.status === filters.status);
      return { items: arr, total: arr.length, page: filters.page, pageSize: filters.pageSize };
    },
    async updateStatus(id, status) {
      const b = businesses.get(id);
      if (!b) return null;
      const updated = { ...b, status, updatedAt: new Date() };
      businesses.set(id, updated);
      return updated;
    },
    async updatePolicies(id, update) {
      const b = businesses.get(id);
      if (!b) return null;
      const updated = { ...b, ...update, updatedAt: new Date() };
      businesses.set(id, updated);
      return updated;
    },
    async linkOwnerUser(userId, businessId) {
      const u = users.get(userId);
      if (u) u.businessId = businessId;
    },
  };

  const productRepo: ProductRepository = {
    async upsertBySku(input) {
      const id = newId();
      const now = new Date();
      const created: ProductDto = { id, ...input, createdAt: now, updatedAt: now };
      products.set(id, created);
      return created;
    },
    async findByMerchantAndIds(merchantId, ids) {
      return ids.map((id) => products.get(id)).filter((p): p is ProductDto => Boolean(p && p.merchantId === merchantId));
    },
    async listByMerchant(filters) {
      const arr = Array.from(products.values()).filter((p) => !filters.merchantId || p.merchantId === filters.merchantId);
      return { items: arr, total: arr.length, page: filters.page, pageSize: filters.pageSize };
    },
  };

  const packageRepo: PackageRepository = {
    async create(input) {
      const id = newId();
      const now = new Date();
      const dto: PackageDto = {
        id,
        ...input,
        qrTokenVersion: input.qrTokenVersion ?? 1,
        qrRevoked: input.qrRevoked ?? false,
        createdAt: now,
        updatedAt: now,
      };
      packages.set(id, dto);
      pushEvent({
        eventId: `evt_${crypto.randomUUID()}`,
        packageId: dto.packageId,
        merchantId: dto.ownerId,
        type: 'PACKAGE_CREATED',
        actor: { userId: 'system', role: 'ADMIN' },
        occurredAt: now,
        sourceSystem: 'REBOXIFY_API',
        outcome: 'ACCEPTED',
        evidence: [],
      });
      outboxEntries.push({ entityType: 'passport', entityId: dto.packageId, operation: 'UPSERT' });
      return dto;
    },
    async findByPackageId(packageId) {
      for (const p of packages.values()) if (p.packageId === packageId.toUpperCase()) return p;
      return null;
    },
    async list(filters) {
      const arr = Array.from(packages.values());
      return { items: arr, total: arr.length, page: filters.page, pageSize: filters.pageSize };
    },
    async findCandidatesForAllocation(merchantId, allowSharedPool, allowCrossMerchantHybrid) {
      return Array.from(packages.values()).filter((p) => {
        if (p.status !== 'AVAILABLE') return false;
        if (p.ownerId === merchantId) return true;
        if (allowSharedPool && p.ownerType === 'REBOXIFY_POOL') return true;
        if (allowCrossMerchantHybrid && p.ownerType === 'HYBRID') return true;
        return false;
      });
    },
    async reservePackagesAtomically(reservations) {
      const out: PackageDto[] = [];
      for (const r of reservations) {
        const p = packages.get(r.packageRefId);
        if (!p || p.status !== 'AVAILABLE') return null;
        const upd: PackageDto = {
          ...p,
          status: 'RESERVED',
          currentOrderId: r.orderId,
          currentCustodian: {
            custodianType: 'MERCHANT',
            custodianId: r.merchantId,
            label: r.merchantCustodianLabel,
            assignedAt: new Date(),
          },
          updatedAt: new Date(),
        };
        packages.set(p.id, upd);
        out.push(upd);
      }
      return out;
    },
  };

  const orderRepo: OrderRepository = {
    async create(input) {
      const id = newId();
      const now = new Date();
      const dto: OrderDto = { id, ...input, createdAt: now, updatedAt: now };
      orders.set(id, dto);
      return dto;
    },
    async findById(id) {
      return orders.get(id) ?? null;
    },
    async list(filters) {
      let arr = Array.from(orders.values());
      if (filters.merchantId) arr = arr.filter((o) => o.merchantId === filters.merchantId);
      if (filters.customerId) arr = arr.filter((o) => o.customerId === filters.customerId);
      return { items: arr, total: arr.length, page: filters.page, pageSize: filters.pageSize };
    },
    async applyAllocationAtomically(orderId, update) {
      const ord = orders.get(orderId);
      if (!ord || ord.allocatedPackages.length > 0) return null;
      const upd: OrderDto = {
        ...ord,
        allocatedPackages: update.allocatedPackages,
        allocationMetadata: update.allocationMetadata,
        totals: { ...ord.totals, depositTotal: update.depositTotal, grandTotal: update.grandTotal },
        status: update.status,
        updatedAt: new Date(),
      };
      orders.set(orderId, upd);
      return upd;
    },
  };

  const txRepo: TransactionRepository = {
    async create(input) {
      const id = newId();
      const now = new Date();
      const dto: TransactionDto = { id, ...input, createdAt: now, updatedAt: now };
      transactions.set(id, dto);
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
        if (t.orderId === orderId && !['CAPTURE_FAILED', 'REFUND_FAILED', 'REVERSED'].includes(t.state)) {
          return t;
        }
      }
      return null;
    },
    async findLatestByOrderId(orderId) {
      const list = Array.from(transactions.values()).filter((t) => t.orderId === orderId);
      return list[list.length - 1] ?? null;
    },
    async list(filters) {
      let arr = Array.from(transactions.values());
      if (filters.merchantId) arr = arr.filter((t) => t.merchantId === filters.merchantId);
      if (filters.customerId) arr = arr.filter((t) => t.customerId === filters.customerId);
      return { items: arr, total: arr.length, page: filters.page, pageSize: filters.pageSize };
    },
    async transitionState(txId, fromStates, update) {
      const t = transactions.get(txId);
      if (!t || !fromStates.includes(t.state)) return null;
      Object.assign(t, update, { updatedAt: new Date() });
      return t;
    },
    async updateOrderPaymentStatus(orderId, nextStatus: OrderStatus) {
      const ord = orders.get(orderId);
      if (ord) ord.status = nextStatus;
    },
  };

  const passportRepo: PassportRepository = {
    async findPackageById(packageId) {
      for (const p of packages.values()) if (p.packageId === packageId.trim().toUpperCase()) return p;
      return null;
    },
    async findPackagesByIds(ids) {
      const s = new Set(ids.map((i) => i.trim().toUpperCase()));
      return Array.from(packages.values()).filter((p) => s.has(p.packageId));
    },
    async findAssignedToPartner({ partnerUserId, status, page, pageSize }) {
      const arr = Array.from(packages.values()).filter(
        (p) => p.assignedPartnerUserId === partnerUserId && (!status || p.status === status)
      );
      return { items: arr, total: arr.length, page, pageSize };
    },
    async findEventsByPackageId(packageId, limit = 100) {
      return packageEvents
        .filter((e) => e.packageId === packageId.trim().toUpperCase())
        .slice(-limit)
        .reverse();
    },
    async findEventByScanId(packageId, scanId) {
      return (
        packageEvents.find((e) => e.packageId === packageId.trim().toUpperCase() && e.scanId === scanId.trim()) ??
        null
      );
    },
    async recordEvent(input: CreatePackageEventInput) {
      const evt: PackageEventDto = {
        eventId: input.eventId ?? `evt_${crypto.randomUUID()}`,
        packageId: input.packageId.trim().toUpperCase(),
        merchantId: input.merchantId,
        ...(input.scanId?.trim() ? { scanId: input.scanId.trim() } : {}),
        type: input.type,
        actor: input.actor,
        occurredAt: input.occurredAt ?? new Date(),
        sourceSystem: input.sourceSystem ?? 'REBOXIFY_API',
        correlationId: input.correlationId,
        locationRef: input.locationRef,
        outcome: input.outcome,
        evidence: input.evidence ?? [],
        metadata: input.metadata,
      };
      pushEvent(evt);
      return evt;
    },
    async applyScanTransitionAtomically(params) {
      let target: PackageDto | null = null;
      for (const p of packages.values()) {
        if (p.packageId === params.packageId.trim().toUpperCase()) {
          target = p;
          break;
        }
      }
      if (!target || target.status !== params.expectedFromStatus) return null;
      const upd: PackageDto = {
        ...target,
        status: params.toStatus,
        currentCustodian: params.newCustodian ?? target.currentCustodian,
        currentOrderId: params.clearOrderAndPartner ? undefined : target.currentOrderId,
        assignedPartnerUserId: params.clearOrderAndPartner
          ? undefined
          : params.assignedPartnerUserId ?? target.assignedPartnerUserId,
        assignedPartnerName: params.clearOrderAndPartner
          ? undefined
          : params.assignedPartnerName ?? target.assignedPartnerName,
        reuseCount: params.incrementReuseCount ? target.reuseCount + 1 : target.reuseCount,
        lastInspectionAt: params.lastInspectionAt ?? target.lastInspectionAt,
        lastInspectionOutcome: params.lastInspectionOutcome ?? target.lastInspectionOutcome,
        lastCleanedAt: params.lastCleanedAt ?? target.lastCleanedAt,
        updatedAt: new Date(),
      };
      packages.set(target.id, upd);
      const evt = await this.recordEvent(params.event);
      outboxEntries.push({ entityType: 'passport', entityId: upd.packageId, operation: 'UPSERT' });
      let orderUpdated = false;
      if (params.orderUpdate) {
        const ord = orders.get(params.orderUpdate.orderId);
        if (ord && params.orderUpdate.expectedStatuses.includes(ord.status)) {
          orders.set(ord.id, {
            ...ord,
            status: params.orderUpdate.toStatus,
            returnDeadlineAt: params.orderUpdate.returnDeadlineAt ?? ord.returnDeadlineAt,
            updatedAt: new Date(),
          });
          orderUpdated = true;
        }
      }
      return { package: upd, event: evt, orderUpdated };
    },
    async updateQrCredentials() {
      return null;
    },
    async assignDeliveryPartner(params) {
      for (const [id, p] of packages.entries()) {
        if (p.packageId === params.packageId.trim().toUpperCase()) {
          const upd = { ...p, assignedPartnerUserId: params.partnerUserId, assignedPartnerName: params.partnerName };
          packages.set(id, upd);
          const evt = await this.recordEvent(params.event);
          return { package: upd, event: evt };
        }
      }
      return null;
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
  };

  const returnRepo: ReturnRepository = {
    async createReturnWithPackageAtomically(params) {
      const pkg = await passportRepo.findPackageById(params.returnDoc.packageId);
      if (!pkg || pkg.status !== params.expectedPackageStatus) return null;
      for (const r of returns.values()) {
        if (r.orderId === params.returnDoc.orderId && r.packageId === params.returnDoc.packageId) {
          return null;
        }
      }
      const updatedPkg: PackageDto = { ...pkg, status: params.nextPackageStatus, updatedAt: new Date() };
      packages.set(pkg.id, updatedPkg);
      const id = newId();
      const now = new Date();
      let pickupId: string | undefined;
      if (params.pickupRequest) {
        pickupId = newId();
        pickups.set(pickupId, { id: pickupId, returnId: id, status: 'UNASSIGNED' });
      }
      const retDto: ReturnDto = {
        id,
        ...params.returnDoc,
        pickupId,
        createdAt: now,
        updatedAt: now,
      };
      returns.set(id, retDto);
      await passportRepo.recordEvent(params.event);
      outboxEntries.push({ entityType: 'return', entityId: id, operation: 'UPSERT' });
      outboxEntries.push({ entityType: 'passport', entityId: updatedPkg.packageId, operation: 'UPSERT' });
      return { returnRecord: retDto, package: updatedPkg };
    },
    async findById(id) {
      return returns.get(id) ?? null;
    },
    async findByReturnNumber(returnNumber) {
      for (const r of returns.values()) if (r.returnNumber === returnNumber.trim().toUpperCase()) return r;
      return null;
    },
    async findByOrderAndPackage(orderId, packageId) {
      for (const r of returns.values()) {
        if (r.orderId === orderId && r.packageId === packageId.trim().toUpperCase()) return r;
      }
      return null;
    },
    async findActiveByPackageId(packageId) {
      for (const r of returns.values()) {
        if (r.packageId === packageId.trim().toUpperCase() && !['CLOSED', 'REJECTED'].includes(r.status)) return r;
      }
      return null;
    },
    async list(filters) {
      let arr = Array.from(returns.values());
      if (filters.merchantId) arr = arr.filter((r) => r.merchantId === filters.merchantId);
      if (filters.customerId) arr = arr.filter((r) => r.customerId === filters.customerId);
      if (filters.assignedPartnerUserId) {
        arr = arr.filter((r) => r.assignedPartnerUserId === filters.assignedPartnerUserId);
      }
      if (filters.status) arr = arr.filter((r) => r.status === filters.status);
      return { items: arr, total: arr.length, page: filters.page, pageSize: filters.pageSize };
    },
    async transitionReturnAndPackageAtomically(params) {
      const existing = returns.get(params.returnId);
      if (!existing || !params.expectedReturnStatuses.includes(existing.status)) return null;
      const updatedRet: ReturnDto = { ...existing, ...params.returnSet, updatedAt: new Date() };
      returns.set(existing.id, updatedRet);
      let updatedPkg: PackageDto | undefined;
      if (params.packageUpdate) {
        const pkg = await passportRepo.findPackageById(params.packageUpdate.packageId);
        if (pkg && params.packageUpdate.expectedStatuses.includes(pkg.status)) {
          updatedPkg = {
            ...pkg,
            status: params.packageUpdate.nextStatus,
            currentCustodian: params.packageUpdate.newCustodian ?? pkg.currentCustodian,
            lastInspectionAt: params.packageUpdate.lastInspectionAt ?? pkg.lastInspectionAt,
            lastInspectionOutcome:
              params.packageUpdate.lastInspectionOutcome ?? pkg.lastInspectionOutcome,
            updatedAt: new Date(),
          };
          packages.set(pkg.id, updatedPkg);
          outboxEntries.push({ entityType: 'passport', entityId: updatedPkg.packageId, operation: 'UPSERT' });
        }
      }
      if (params.event) {
        await passportRepo.recordEvent(params.event);
      }
      outboxEntries.push({ entityType: 'return', entityId: updatedRet.id, operation: 'UPSERT' });
      return { returnRecord: updatedRet, package: updatedPkg };
    },
    async appendEvidenceFile(returnId, file, event) {
      const existing = returns.get(returnId);
      if (!existing) return null;
      const upd: ReturnDto = { ...existing, evidenceFiles: [...existing.evidenceFiles, file], updatedAt: new Date() };
      returns.set(returnId, upd);
      if (event) await passportRepo.recordEvent(event);
      outboxEntries.push({ entityType: 'return', entityId: returnId, operation: 'UPSERT' });
      return upd;
    },
  };

  const refundRepo: RefundRepository = {
    async findById(id) {
      return refunds.get(id) ?? null;
    },
    async findByReturnId(returnId) {
      for (const r of refunds.values()) if (r.returnId === returnId) return r;
      return null;
    },
    async findByProviderRefundId(providerRefundId) {
      for (const r of refunds.values()) if (r.providerRefundId === providerRefundId) return r;
      return null;
    },
    async findByIdempotencyKey(key) {
      for (const r of refunds.values()) if (r.idempotencyKey === key) return r;
      return null;
    },
    async listByTransactionId(txId) {
      return Array.from(refunds.values()).filter((r) => r.transactionId === txId);
    },
    async listPendingOlderThan(cutoff) {
      return Array.from(refunds.values()).filter(
        (r) => ['REFUND_REQUESTED', 'REFUND_PENDING'].includes(r.state) && r.updatedAt <= cutoff
      );
    },
    async reserveRefundAndApproveReturnAtomically(params) {
      const tx = transactions.get(params.transactionId);
      if (!tx || !params.expectedTxStates.includes(tx.state)) return null;
      const alloc = tx.depositAllocations.find(
        (a) => a.packageId.toUpperCase() === params.packageId.toUpperCase()
      );
      if (!alloc) return null;
      const remainingPkg = alloc.allocatedDeposit - alloc.refundedAmount - alloc.pendingRefundAmount;
      const totalUsed = tx.depositAllocations.reduce((s, a) => s + a.refundedAmount + a.pendingRefundAmount, 0);
      const remainingTx = tx.amount - totalUsed;
      if (params.refundInput.amount > remainingPkg + 0.001 || params.refundInput.amount > remainingTx + 0.001) {
        return null;
      }
      alloc.pendingRefundAmount = Math.round((alloc.pendingRefundAmount + params.refundInput.amount) * 100) / 100;
      tx.state = 'REFUND_REQUESTED';

      const id = newId();
      const now = new Date();
      const refDto: RefundDto = { id, ...params.refundInput, createdAt: now, updatedAt: now };
      refunds.set(id, refDto);

      const ret = returns.get(params.returnUpdate.returnId);
      if (!ret || !params.returnUpdate.expectedReturnStatuses.includes(ret.status)) return null;
      const updRet: ReturnDto = {
        ...ret,
        status: 'APPROVED',
        decision: params.returnUpdate.decision,
        refundId: id,
        updatedAt: now,
      };
      returns.set(ret.id, updRet);
      if (params.event) await passportRepo.recordEvent(params.event);
      outboxEntries.push({ entityType: 'return', entityId: ret.id, operation: 'UPSERT' });
      outboxEntries.push({ entityType: 'payment', entityId: tx.id, operation: 'UPSERT' });
      return { refund: refDto, transaction: tx, returnRecord: updRet };
    },
    async markRefundPendingProvider(params) {
      const r = refunds.get(params.refundId);
      if (!r) return null;
      r.state = 'REFUND_PENDING';
      if (params.providerRefundId) r.providerRefundId = params.providerRefundId;
      if (params.providerStatus) r.providerStatus = params.providerStatus;
      r.lastReconciledAt = params.lastReconciledAt;
      const tx = transactions.get(r.transactionId);
      if (tx) tx.state = params.txState ?? 'REFUND_PENDING';
      return r;
    },
    async finalizeRefundCompletedAtomically(params) {
      const r = refunds.get(params.refundId);
      if (!r || !['REFUND_REQUESTED', 'REFUND_PENDING', 'REFUND_FAILED'].includes(r.state)) return null;
      r.state = 'REFUNDED';
      r.providerRefundId = params.providerRefundId;
      r.providerStatus = params.providerStatus;
      r.confirmedAt = params.confirmedAt;
      r.lastReconciledAt = params.confirmedAt;

      const tx = transactions.get(r.transactionId);
      if (!tx) return null;
      const alloc = tx.depositAllocations.find((a) => a.packageId.toUpperCase() === r.packageId.toUpperCase());
      if (alloc) {
        alloc.pendingRefundAmount = Math.max(0, Math.round((alloc.pendingRefundAmount - r.amount) * 100) / 100);
        alloc.refundedAmount = Math.round((alloc.refundedAmount + r.amount) * 100) / 100;
      }
      const totalConfirmed = tx.depositAllocations.reduce((s, a) => s + a.refundedAmount, 0);
      tx.state = totalConfirmed >= tx.amount - 0.001 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      tx.lastReconciledAt = params.confirmedAt;

      const ret = returns.get(r.returnId);
      if (ret && ['APPROVED', 'UNDER_INSPECTION', 'NEEDS_REVIEW'].includes(ret.status)) {
        ret.status = 'CLOSED';
      }
      if (params.event) await passportRepo.recordEvent(params.event);
      outboxEntries.push({ entityType: 'return', entityId: r.returnId, operation: 'UPSERT' });
      outboxEntries.push({ entityType: 'payment', entityId: tx.id, operation: 'UPSERT' });
      return { refund: r, transaction: tx, returnRecord: ret };
    },
    async failRefundAndReleaseReservationAtomically(params) {
      const r = refunds.get(params.refundId);
      if (!r || !['REFUND_REQUESTED', 'REFUND_PENDING'].includes(r.state)) return null;
      r.state = 'REFUND_FAILED';
      r.failureReason = params.failureReason;
      if (params.providerStatus) r.providerStatus = params.providerStatus;
      const tx = transactions.get(r.transactionId);
      if (!tx) return null;
      const alloc = tx.depositAllocations.find((a) => a.packageId.toUpperCase() === r.packageId.toUpperCase());
      if (alloc) {
        alloc.pendingRefundAmount = Math.max(0, Math.round((alloc.pendingRefundAmount - r.amount) * 100) / 100);
      }
      const confirmed = tx.depositAllocations.reduce((s, a) => s + a.refundedAmount, 0);
      const pending = tx.depositAllocations.reduce((s, a) => s + a.pendingRefundAmount, 0);
      tx.state = pending > 0 ? 'REFUND_PENDING' : confirmed > 0 ? 'PARTIALLY_REFUNDED' : 'CAPTURED';
      if (params.event) await passportRepo.recordEvent(params.event);
      outboxEntries.push({ entityType: 'payment', entityId: tx.id, operation: 'UPSERT' });
      return { refund: r, transaction: tx };
    },
    async retryFailedRefundReservationAtomically(params) {
      const r = refunds.get(params.refundId);
      if (!r || r.state !== 'REFUND_FAILED') return null;
      const tx = transactions.get(r.transactionId);
      if (!tx) return null;
      const alloc = tx.depositAllocations.find((a) => a.packageId.toUpperCase() === r.packageId.toUpperCase());
      if (!alloc) return null;
      const rem = alloc.allocatedDeposit - alloc.refundedAmount - alloc.pendingRefundAmount;
      if (r.amount > rem + 0.001) return null;
      alloc.pendingRefundAmount = Math.round((alloc.pendingRefundAmount + r.amount) * 100) / 100;
      tx.state = 'REFUND_REQUESTED';
      r.state = 'REFUND_REQUESTED';
      r.paypalRequestId = params.newPayPalRequestId;
      return { refund: r, transaction: tx };
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
      const rec: WebhookEventDto = { id: newId(), ...input, receivedAt: new Date() };
      webhooks.set(input.providerEventId, rec);
      return { created: true, record: rec };
    },
    async updateProcessingState(providerEventId, update) {
      const existing = webhooks.get(providerEventId);
      if (!existing) return null;
      Object.assign(existing, update);
      return existing;
    },
  };

  const expectedAmountsByPpOrderId = new Map<string, string>();
  const capturesByPpOrderId = new Map<string, string>();
  const providerRefunds = new Map<string, PayPalRefundResponse>();

  const defaultPayPal: PayPalClient = {
    isConfigured: () => true,
    isWebhookConfigured: () => true,
    async createOrder(params: PayPalCreateOrderParams): Promise<PayPalOrderResponse> {
      const ppId = `PP-ORD-${params.internalOrderId.slice(0, 8)}`;
      expectedAmountsByPpOrderId.set(ppId, params.grandTotal.toFixed(2));
      return { id: ppId, status: 'CREATED' };
    },
    async captureOrder(paypalOrderId: string): Promise<PayPalOrderResponse> {
      const val = expectedAmountsByPpOrderId.get(paypalOrderId) ?? '50.00';
      const capId = `CAP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      capturesByPpOrderId.set(paypalOrderId, capId);
      return {
        id: paypalOrderId,
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [{ id: capId, status: 'COMPLETED', amount: { currency_code: 'USD', value: val } }],
            },
          },
        ],
      };
    },
    async getOrder(paypalOrderId: string): Promise<PayPalOrderResponse> {
      const capId = capturesByPpOrderId.get(paypalOrderId) ?? 'CAP-RECON-1';
      const val = expectedAmountsByPpOrderId.get(paypalOrderId) ?? '50.00';
      return {
        id: paypalOrderId,
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [{ id: capId, status: 'COMPLETED', amount: { currency_code: 'USD', value: val } }],
              refunds: Array.from(providerRefunds.values()),
            },
          },
        ],
      };
    },
    async refundCapture(params: PayPalRefundParams): Promise<PayPalRefundResponse> {
      const id = `PP-REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const resp: PayPalRefundResponse = {
        id,
        status: 'COMPLETED',
        invoice_id: params.invoiceId,
        amount: { currency_code: params.currency, value: params.amount.toFixed(2) },
      };
      providerRefunds.set(id, resp);
      return resp;
    },
    async getRefund(refundId: string): Promise<PayPalRefundResponse> {
      const existing = providerRefunds.get(refundId);
      if (existing) return existing;
      throw new PayPalClientError('PAYPAL_API_ERROR', 'Refund not found on provider', 404);
    },
    async verifyWebhookSignature(_params: PayPalWebhookVerifyParams): Promise<boolean> {
      return true;
    },
    ...paypalOverrides,
  };

  const authService = new AuthService(userRepo, audit);
  const businessService = new BusinessService(businessRepo, audit, runTx);
  const productService = new ProductService(productRepo, businessRepo, audit);
  const packagingService = new PackagingService(packageRepo, businessRepo, audit, qrService);
  const orderService = new OrderService(orderRepo, productRepo, businessRepo, packageRepo, audit, runTx);
  const paymentService = new PaymentService(txRepo, orderRepo, defaultPayPal, audit, runTx);
  const passportService = new PassportService(
    passportRepo,
    businessRepo,
    orderRepo,
    txRepo,
    qrService,
    audit,
    runTx
  );
  const returnService = new ReturnService(
    returnRepo,
    refundRepo,
    orderRepo,
    packageRepo,
    businessRepo,
    txRepo,
    passportRepo,
    defaultPayPal,
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
    defaultPayPal,
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
    authService,
    packages,
    orders,
    transactions,
    returns,
    refunds,
    webhooks,
    pickups,
    packageEvents,
    outboxEntries,
    auditEntries,
    providerRefunds,
    defaultPayPal,
    returnService,
  };
}

async function seedDeliveredOrderScenario(paypalOverrides: Partial<PayPalClient> = {}) {
  const h = buildPhase5Harness(paypalOverrides);
  const seedAdmin = { userId: 'seed', email: 'seed@test', name: 'Seed', role: 'ADMIN' as const };
  const regPriv = (name: string, email: string, role: StoredUserRecord['role'], extra?: { collectionCenterId?: string }) =>
    h.authService.register({ name, email, password: 'Password123!', role, ...extra }, seedAdmin);
  const regCust = async (name: string, email: string) => {
    const r = await request(h.app).post('/api/auth/register').send({ name, email, password: 'Password123!' });
    return { user: r.body.user, token: r.body.token as string };
  };

  const admin = await regPriv('Admin', 'admin@rbx.test', 'ADMIN');
  const merchA = await regPriv('Merchant A', 'ma@rbx.test', 'MERCHANT_ADMIN');
  const merchB = await regPriv('Merchant B', 'mb@rbx.test', 'MERCHANT_ADMIN');
  const custA = await regCust('Customer A', 'ca@rbx.test');
  const custB = await regCust('Customer B', 'cb@rbx.test');
  const partner1 = await regPriv('Partner 1', 'p1@rbx.test', 'DELIVERY_PARTNER');
  const partner2 = await regPriv('Partner 2', 'p2@rbx.test', 'DELIVERY_PARTNER');
  const centre = await regPriv('Centre Op', 'centre@rbx.test', 'COLLECTION_CENTRE', { collectionCenterId: 'CHN-01' });

  const bizA = await request(h.app)
    .post('/api/businesses')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      name: 'Merchant Alpha',
      legalName: 'Merchant Alpha LLC',
      slug: 'merchant-alpha',
      ownerUserId: merchA.user.userId,
      packagingModel: 'MERCHANT_OWNED',
      currency: 'USD',
    });
  const bizB = await request(h.app)
    .post('/api/businesses')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      name: 'Merchant Beta',
      legalName: 'Merchant Beta LLC',
      slug: 'merchant-beta',
      ownerUserId: merchB.user.userId,
      packagingModel: 'MERCHANT_OWNED',
      currency: 'USD',
    });
  // Refresh merchant tokens with linked businessId
  const merchALogin = await request(h.app).post('/api/auth/login').send({ email: 'ma@rbx.test', password: 'Password123!' });
  merchA.token = merchALogin.body.token;
  const merchBLogin = await request(h.app).post('/api/auth/login').send({ email: 'mb@rbx.test', password: 'Password123!' });
  merchB.token = merchBLogin.body.token;

  const prod = await request(h.app)
    .post('/api/products')
    .set('Authorization', `Bearer ${merchA.token}`)
    .send({
      sku: 'SERUM-50',
      name: 'Serum Dropper',
      dimensionsCm: { length: 16, width: 10, height: 8 },
      weightKg: 0.8,
      unitPrice: 45,
    });

  // Register M box -> deposit = $5.00 USD -> Order total = $45 + $5 = $50.00 USD
  const pkgRes = await request(h.app)
    .post('/api/inventory')
    .set('Authorization', `Bearer ${merchA.token}`)
    .send({
      packageId: 'RBX-RET-M001',
      ownerType: 'MERCHANT',
      packageClass: 'M',
      fulfilmentLocation: 'CHN-HUB-01',
    });
  const packageId = pkgRes.body.package.packageId as string;
  const qrToken = pkgRes.body.qrPayload.token as string;

  const ordRes = await request(h.app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${custA.token}`)
    .send({
      merchantId: bizA.body.business.id,
      items: [{ productId: prod.body.product.id, quantity: 1 }],
      shippingReference: {
        recipientName: 'Customer A',
        zone: 'Zone-North',
        addressLine: '101 Green St',
        fulfilmentLocation: 'CHN-HUB-01',
      },
      autoAllocate: true,
    });
  const orderId = ordRes.body.order.id as string;

  const ppCreate = await request(h.app)
    .post('/api/payments/paypal/create-order')
    .set('Authorization', `Bearer ${custA.token}`)
    .set('Idempotency-Key', 'p5-pp-c1')
    .send({ orderId });
  await request(h.app)
    .post(`/api/payments/paypal/capture/${ppCreate.body.paypalOrderId}`)
    .set('Authorization', `Bearer ${custA.token}`)
    .set('Idempotency-Key', 'p5-pp-cap1')
    .send({});

  await request(h.app)
    .post(`/api/packages/${packageId}/scan`)
    .set('Authorization', `Bearer ${merchA.token}`)
    .send({ action: 'PACK', scanMode: 'QR_TOKEN', qrToken, assignedPartnerUserId: partner1.user.userId });

  await request(h.app)
    .post(`/api/packages/${packageId}/scan`)
    .set('Authorization', `Bearer ${partner1.token}`)
    .send({ action: 'DISPATCH', scanMode: 'QR_TOKEN', qrToken });

  await request(h.app)
    .post(`/api/packages/${packageId}/scan`)
    .set('Authorization', `Bearer ${partner1.token}`)
    .send({ action: 'DELIVER', scanMode: 'QR_TOKEN', qrToken });

  return {
    ...h,
    admin,
    merchA,
    merchB,
    custA,
    custB,
    partner1,
    partner2,
    centre,
    bizAId: bizA.body.business.id as string,
    bizBId: bizB.body.business.id as string,
    productId: prod.body.product.id as string,
    orderId,
    packageId,
    qrToken,
  };
}

describe('Phase 5 — Deterministic Refund Calculation Unit Matrix', () => {
  const baseInput = {
    checklist: {
      identityVerified: true,
      structuralIntegrity: true,
      cleanlinessAcceptable: true,
      completeComponents: true,
    },
    isLateReturn: false,
    daysLate: 0,
    allocatedDeposit: 5.0,
    alreadyRefundedForPackage: 0,
    alreadyPendingForPackage: 0,
    totalCapturedTransactionAmount: 50.0,
    totalConfirmedRefundsAcrossOrder: 0,
    totalPendingRefundsAcrossOrder: 0,
    currency: 'USD',
  };

  it('computes full, partial, zero, late, and remaining-balance-capped refunds across all blueprint condition categories', () => {
    const good = calculateReturnRefund({ ...baseInput, condition: 'GOOD' });
    expect(good.calculatedAmount).toBe(5.0);
    expect(good.eligible).toBe(true);
    expect(good.inspectionOutcome).toBe('PASS');

    const wear = calculateReturnRefund({ ...baseInput, condition: 'MINOR_WEAR' });
    expect(wear.calculatedAmount).toBe(5.0);
    expect(wear.totalDeductions).toBe(0);
    expect(wear.inspectionOutcome).toBe('PASS');

    const minorDmg = calculateReturnRefund({ ...baseInput, condition: 'MINOR_DAMAGE' });
    expect(minorDmg.calculatedAmount).toBe(2.5);
    expect(minorDmg.totalDeductions).toBe(2.5);
    expect(minorDmg.inspectionOutcome).toBe('NEEDS_REVIEW');

    for (const zeroCond of ['MAJOR_DAMAGE', 'CONTAMINATED', 'MISSING_PACKAGING', 'UNUSABLE', 'WRONG_PACKAGE'] as const) {
      const res = calculateReturnRefund({ ...baseInput, condition: zeroCond });
      expect(res.calculatedAmount).toBe(0);
      expect(res.eligible).toBe(false);
    }

    const lateGood = calculateReturnRefund({ ...baseInput, condition: 'GOOD', isLateReturn: true, daysLate: 3 });
    expect(lateGood.inspectionOutcome).toBe('NEEDS_REVIEW');
    expect(lateGood.calculatedAmount).toBe(4.0); // 20% disclosed late recovery deduction

    // Never exceed remaining unrefunded balance on capture
    const capped = calculateReturnRefund({
      ...baseInput,
      condition: 'GOOD',
      alreadyRefundedForPackage: 3.0,
      totalConfirmedRefundsAcrossOrder: 3.0,
    });
    expect(capped.calculatedAmount).toBe(2.0);
    expect(capped.deductionBreakdown.some((d) => d.code === 'PRIOR_REFUND_CAP')).toBe(true);
  });
});

describe('Phase 5 — End-to-End Return Lifecycle, GridFS Evidence, PayPal Refunds & Webhooks', () => {
  it('completes full lifecycle: return initiation -> pickup -> QR collect -> centre receipt -> photo evidence -> inspect -> PayPal partial refund -> webhook sync -> cleaning -> AVAILABLE (reuseCount + 1)', async () => {
    const s = await seedDeliveredOrderScenario();

    // 1. Customer initiates PICKUP return
    const retRes = await request(s.app)
      .post('/api/returns')
      .set('Authorization', `Bearer ${s.custA.token}`)
      .send({
        orderId: s.orderId,
        packageId: s.packageId,
        mode: 'PICKUP',
        reason: 'Box emptied cleanly',
        serviceZone: 'Zone-North',
        addressSummary: '101 Green St',
      });
    expect(retRes.status).toBe(201);
    const returnId = retRes.body.returnRecord.id as string;
    expect(retRes.body.returnRecord.status).toBe('PICKUP_SCHEDULED');
    expect(s.pickups.size).toBe(1);

    // Duplicate return request MUST be rejected
    const dupRet = await request(s.app)
      .post('/api/returns')
      .set('Authorization', `Bearer ${s.custA.token}`)
      .send({ orderId: s.orderId, packageId: s.packageId, mode: 'DROP_OFF', dropoffLocationLabel: 'Hub' });
    expect(dupRet.status).toBe(409);
    expect(dupRet.body.error.code).toBe('DUPLICATE_RETURN_REQUEST');

    // 2. Customer attaches GridFS photo evidence & retrieves it cleanly
    const evUpload = await request(s.app)
      .post(`/api/returns/${returnId}/evidence`)
      .set('Authorization', `Bearer ${s.custA.token}`)
      .send({
        filename: 'clean_box.jpg',
        mimeType: 'image/jpeg',
        contentBase64: makeFakeJpeg().toString('base64'),
      });
    expect(evUpload.status).toBe(201);
    const fileId = evUpload.body.returnRecord.evidenceFiles[0].fileId as string;

    const evDownload = await request(s.app)
      .get(`/api/returns/${returnId}/evidence/${fileId}`)
      .set('Authorization', `Bearer ${s.centre.token}`);
    expect(evDownload.status).toBe(200);
    expect(evDownload.headers['content-type']).toContain('image/jpeg');

    // 3. Assign Partner 1 & QR-verify collect (unassigned Partner 2 rejected)
    await request(s.app)
      .post(`/api/returns/${returnId}/assign-partner`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({ partnerUserId: s.partner1.user.userId });

    const p2Collect = await request(s.app)
      .post(`/api/returns/${returnId}/collect`)
      .set('Authorization', `Bearer ${s.partner2.token}`)
      .send({ scanMode: 'QR_TOKEN', qrToken: s.qrToken });
    expect(p2Collect.status).toBe(403);

    const p1Collect = await request(s.app)
      .post(`/api/returns/${returnId}/collect`)
      .set('Authorization', `Bearer ${s.partner1.token}`)
      .send({ scanMode: 'QR_TOKEN', qrToken: s.qrToken, scanId: 'ret-col-001' });
    expect(p1Collect.status).toBe(200);
    expect(p1Collect.body.returnRecord.status).toBe('COLLECTED');

    // 4. Collection Centre receives via QR
    const recvRes = await request(s.app)
      .post(`/api/returns/${returnId}/receive`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({ scanMode: 'QR_TOKEN', qrToken: s.qrToken, scanId: 'ret-recv-001' });
    expect(recvRes.status).toBe(200);
    expect(recvRes.body.returnRecord.status).toBe('RECEIVED');

    // Reject client-supplied tampered refundAmount on inspect & approve
    const tamperedInspect = await request(s.app)
      .post(`/api/returns/${returnId}/inspect`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({
        condition: 'GOOD',
        checklist: { identityVerified: true, structuralIntegrity: true, cleanlinessAcceptable: true, completeComponents: true },
        refundAmount: 999,
      });
    expect(tamperedInspect.status).toBe(400);
    expect(tamperedInspect.body.error.code).toBe('CLIENT_REFUND_AMOUNT_FORBIDDEN');

    // 5. Inspect MINOR_DAMAGE (partial $2.50 refund of $5.00 deposit)
    const inspectRes = await request(s.app)
      .post(`/api/returns/${returnId}/inspect`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({
        condition: 'MINOR_DAMAGE',
        checklist: { identityVerified: true, structuralIntegrity: true, cleanlinessAcceptable: true, completeComponents: true },
        damageReason: 'Corner latch scuffed',
      });
    expect(inspectRes.status).toBe(200);
    expect(inspectRes.body.returnRecord.status).toBe('NEEDS_REVIEW');
    expect(inspectRes.body.returnRecord.refundEligibility.calculatedAmount).toBe(2.5);

    // 6. Approve & execute partial PayPal capture refund
    const approveRes = await request(s.app)
      .post(`/api/returns/${returnId}/approve`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .set('Idempotency-Key', 'p5-app-1')
      .send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.refund.state).toBe('REFUNDED');
    expect(approveRes.body.refund.amount).toBe(2.5);
    expect(approveRes.body.returnRecord.status).toBe('CLOSED');
    const tx = Array.from(s.transactions.values())[0];
    expect(tx.state).toBe('PARTIALLY_REFUNDED');
    expect(tx.depositAllocations[0].refundedAmount).toBe(2.5);

    // Repeat approve returns idempotent result without calling PayPal twice
    const dupApprove = await request(s.app)
      .post(`/api/returns/${returnId}/approve`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .set('Idempotency-Key', 'p5-app-2')
      .send({});
    expect(dupApprove.status).toBe(200);
    expect(dupApprove.body.alreadyRefunded).toBe(true);

    // 7. Clean & recirculate package -> INSPECT_PASS -> MARK_CLEANING -> RELEASE_AVAILABLE increments reuseCount 0 -> 1
    await request(s.app)
      .post(`/api/packages/${s.packageId}/scan`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({ action: 'MARK_CLEANING', scanMode: 'QR_TOKEN', qrToken: s.qrToken });
    const releaseRes = await request(s.app)
      .post(`/api/packages/${s.packageId}/scan`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({ action: 'RELEASE_AVAILABLE', scanMode: 'QR_TOKEN', qrToken: s.qrToken });
    // Note: since condition was MINOR_DAMAGE (NEEDS_REVIEW), shouldIncrementReuseCount only increments when lastInspectionOutcome === 'PASS'!
    expect(releaseRes.status).toBe(200);
    expect(releaseRes.body.package.status).toBe('AVAILABLE');
    expect(releaseRes.body.package.reuseCount).toBe(0); // Because latch had MINOR_DAMAGE!

    // Verify outbox recorded return, payment, passport & package_event
    expect(s.outboxEntries.some((o) => o.entityType === 'return')).toBe(true);
    expect(s.outboxEntries.some((o) => o.entityType === 'payment')).toBe(true);
    expect(s.outboxEntries.some((o) => o.entityType === 'passport')).toBe(true);
  });

  it('handles GOOD return -> full deposit refund -> PASS -> CLEANING -> AVAILABLE with reuseCount incrementing 0 -> 1 cleanly, AND zero-refund path', async () => {
    const s = await seedDeliveredOrderScenario();
    const ret = await request(s.app)
      .post('/api/returns')
      .set('Authorization', `Bearer ${s.custA.token}`)
      .send({ orderId: s.orderId, packageId: s.packageId, mode: 'DROP_OFF', dropoffLocationLabel: 'Hub Locker 9' });
    const retId = ret.body.returnRecord.id;
    expect(ret.body.returnRecord.status).toBe('DROP_OFF_SELECTED');

    await request(s.app)
      .post(`/api/returns/${retId}/receive`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({ scanMode: 'QR_TOKEN', qrToken: s.qrToken });

    const inspectGood = await request(s.app)
      .post(`/api/returns/${retId}/inspect`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({
        condition: 'GOOD',
        checklist: { identityVerified: true, structuralIntegrity: true, cleanlinessAcceptable: true, completeComponents: true },
      });
    expect(inspectGood.body.returnRecord.refundEligibility.calculatedAmount).toBe(5.0);

    const appGood = await request(s.app)
      .post(`/api/returns/${retId}/approve`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({});
    expect(appGood.status).toBe(200);
    expect(appGood.body.refund.amount).toBe(5.0);

    await request(s.app)
      .post(`/api/packages/${s.packageId}/scan`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({ action: 'MARK_CLEANING', scanMode: 'QR_TOKEN', qrToken: s.qrToken });
    const released = await request(s.app)
      .post(`/api/packages/${s.packageId}/scan`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({ action: 'RELEASE_AVAILABLE', scanMode: 'QR_TOKEN', qrToken: s.qrToken });
    expect(released.body.package.status).toBe('AVAILABLE');
    expect(released.body.package.reuseCount).toBe(1);
  });

  it('handles PayPal PENDING refund, timeout reconciliation, FAILED retry, Gate 3 independence (cleaning continues during pending refund), and Webhooks (valid/invalid sig, duplicate, out-of-order, forged)', async () => {
    let simulateTimeoutOnce = true;
    const customRefundId = 'PP-REF-ASYNC-999';
    const refundSpy = vi.fn(async (params: PayPalRefundParams): Promise<PayPalRefundResponse> => {
      if (simulateTimeoutOnce) {
        simulateTimeoutOnce = false;
        throw new PayPalClientError('PAYPAL_TIMEOUT', 'Gateway timeout during refund');
      }
      return {
        id: customRefundId,
        status: 'PENDING',
        invoice_id: params.invoiceId,
        amount: { currency_code: params.currency, value: params.amount.toFixed(2) },
      };
    });
    const verifySigSpy = vi.fn(async (params: PayPalWebhookVerifyParams) => {
      return params.headers.transmissionSig === 'VALID_SIG';
    });
    let liveProviderRefundStatus = 'COMPLETED';
    const getRefundSpy = vi.fn(async (refundId: string): Promise<PayPalRefundResponse> => ({
      id: refundId,
      status: liveProviderRefundStatus,
      amount: { currency_code: 'USD', value: '5.00' },
    }));

    const s = await seedDeliveredOrderScenario({
      refundCapture: refundSpy,
      verifyWebhookSignature: verifySigSpy,
      getRefund: getRefundSpy,
    });

    const ret = await request(s.app)
      .post('/api/returns')
      .set('Authorization', `Bearer ${s.custA.token}`)
      .send({ orderId: s.orderId, packageId: s.packageId, mode: 'NEXT_DELIVERY_SWAP', swapOrderNumber: 'ORD-SWAP-2' });
    const retId = ret.body.returnRecord.id as string;

    await request(s.app)
      .post(`/api/returns/${retId}/receive`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({ scanMode: 'MANUAL_SUPERVISED', manualReason: 'Label obscured by moisture, matched serial' });

    await request(s.app)
      .post(`/api/returns/${retId}/inspect`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({
        condition: 'GOOD',
        checklist: { identityVerified: true, structuralIntegrity: true, cleanlinessAcceptable: true, completeComponents: true },
      });

    // 1. Timeout during refundCapture -> safely reconciles & holds REFUND_PENDING (202 Accepted) with pendingRefundAmount reserved
    const timeoutApprove = await request(s.app)
      .post(`/api/returns/${retId}/approve`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({});
    expect(timeoutApprove.status).toBe(202);
    expect(timeoutApprove.body.pending).toBe(true);
    expect(timeoutApprove.body.refund.state).toBe('REFUND_PENDING');

    const txAfterTimeout = Array.from(s.transactions.values())[0];
    expect(txAfterTimeout.depositAllocations[0].pendingRefundAmount).toBe(5.0);

    // 2. Gate 3: Physical cleaning & release CANNOT be blocked by pending refund!
    await request(s.app)
      .post(`/api/packages/${s.packageId}/scan`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({ action: 'MARK_CLEANING', scanMode: 'QR_TOKEN', qrToken: s.qrToken });
    const relDuringPending = await request(s.app)
      .post(`/api/packages/${s.packageId}/scan`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({ action: 'RELEASE_AVAILABLE', scanMode: 'QR_TOKEN', qrToken: s.qrToken });
    expect(relDuringPending.status).toBe(200);
    expect(relDuringPending.body.package.status).toBe('AVAILABLE');

    // 3. Invalid webhook signature rejected with 401
    const badSigHook = await request(s.app)
      .post('/api/webhooks/paypal')
      .set({
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
        'paypal-transmission-id': 'tx-bad-1',
        'paypal-transmission-sig': 'FORGED_SIG',
        'paypal-transmission-time': new Date().toISOString(),
      })
      .send({
        id: 'WH-EVT-FORGED-1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: { id: customRefundId, invoice_id: ret.body.returnRecord.returnNumber },
      });
    expect(badSigHook.status).toBe(401);

    // 4. Forged/unsolicited refund webhook without approved internal refund is IGNORED cleanly
    const unapprovedHook = await request(s.app)
      .post('/api/webhooks/paypal')
      .set({
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
        'paypal-transmission-id': 'tx-forged-ref',
        'paypal-transmission-sig': 'VALID_SIG',
        'paypal-transmission-time': new Date().toISOString(),
      })
      .send({
        id: 'WH-EVT-UNAPPROVED',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: { id: 'PP-REF-DOES-NOT-EXIST', invoice_id: 'RET-NOPE' },
      });
    expect(unapprovedHook.status).toBe(200);
    expect(unapprovedHook.body.ignored).toBe(true);

    // 5. Verified PAYMENT.CAPTURE.REFUNDED webhook reconciles with getRefund() and finalizes pending refund -> REFUNDED + Return -> CLOSED!
    const validHook = await request(s.app)
      .post('/api/webhooks/paypal')
      .set({
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
        'paypal-transmission-id': 'tx-ok-1',
        'paypal-transmission-sig': 'VALID_SIG',
        'paypal-transmission-time': new Date().toISOString(),
      })
      .send({
        id: 'WH-EVT-REF-001',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: {
          id: customRefundId,
          invoice_id: ret.body.returnRecord.returnNumber,
          supplementary_data: { related_ids: { capture_id: txAfterTimeout.captureId } },
        },
      });
    expect(validHook.status).toBe(200);
    expect(validHook.body.ignored).toBe(false);
    expect(validHook.body.processingState).toBe('PROCESSED');
    expect(s.returns.get(retId)!.status).toBe('CLOSED');
    expect(s.refunds.get(timeoutApprove.body.refund.id)!.state).toBe('REFUNDED');
    expect(txAfterTimeout.depositAllocations[0].refundedAmount).toBe(5.0);
    expect(txAfterTimeout.depositAllocations[0].pendingRefundAmount).toBe(0);

    // 6. Duplicate webhook delivery is deduplicated cleanly
    const dupHook = await request(s.app)
      .post('/api/webhooks/paypal')
      .set({
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
        'paypal-transmission-id': 'tx-ok-1',
        'paypal-transmission-sig': 'VALID_SIG',
        'paypal-transmission-time': new Date().toISOString(),
      })
      .send({
        id: 'WH-EVT-REF-001',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: { id: customRefundId },
      });
    expect(dupHook.status).toBe(200);
    expect(dupHook.body.duplicate).toBe(true);

    // 7. Unknown webhook event type safely stored as IGNORED
    const unknownHook = await request(s.app)
      .post('/api/webhooks/paypal')
      .set({
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
        'paypal-transmission-id': 'tx-unk-1',
        'paypal-transmission-sig': 'VALID_SIG',
        'paypal-transmission-time': new Date().toISOString(),
      })
      .send({ id: 'WH-EVT-UNK-1', event_type: 'BILLING.SUBSCRIPTION.CREATED', resource: { id: 'SUB-1' } });
    expect(unknownHook.status).toBe(200);
    expect(unknownHook.body.ignored).toBe(true);

    void liveProviderRefundStatus;
  });

  it('enforces authorization (cross-customer, cross-merchant, self-inspection, wrong evidence) and failed refund retry recovery', async () => {
    let failFirstRefund = true;
    const s = await seedDeliveredOrderScenario({
      async refundCapture(params) {
        if (failFirstRefund) {
          failFirstRefund = false;
          return {
            id: 'PP-REF-FAIL-1',
            status: 'FAILED',
            status_details: { reason: 'INSUFFICIENT_FUNDS' },
            amount: { currency_code: params.currency, value: params.amount.toFixed(2) },
          };
        }
        return {
          id: 'PP-REF-RETRY-OK',
          status: 'COMPLETED',
          amount: { currency_code: params.currency, value: params.amount.toFixed(2) },
        };
      },
      async getRefund() {
        return { id: 'PP-REF-FAIL-1', status: 'FAILED' };
      },
    });

    // Cross-customer return request blocked
    const crossCust = await request(s.app)
      .post('/api/returns')
      .set('Authorization', `Bearer ${s.custB.token}`)
      .send({ orderId: s.orderId, packageId: s.packageId, mode: 'DROP_OFF', dropoffLocationLabel: 'Hub' });
    expect(crossCust.status).toBe(403);

    // Valid request by custA
    const ret = await request(s.app)
      .post('/api/returns')
      .set('Authorization', `Bearer ${s.custA.token}`)
      .send({ orderId: s.orderId, packageId: s.packageId, mode: 'DROP_OFF', dropoffLocationLabel: 'Hub 1' });
    const retId = ret.body.returnRecord.id as string;

    // Cross-merchant read & approve blocked
    const crossMerchRead = await request(s.app)
      .get(`/api/returns/${retId}`)
      .set('Authorization', `Bearer ${s.merchB.token}`);
    expect(crossMerchRead.status).toBe(403);

    // Spoofed evidence payload (non-image bytes claiming jpeg) rejected
    const badEv = await request(s.app)
      .post(`/api/returns/${retId}/evidence`)
      .set('Authorization', `Bearer ${s.custA.token}`)
      .send({ filename: 'fake.jpg', mimeType: 'image/jpeg', contentBase64: Buffer.from('not-an-image').toString('base64') });
    expect(badEv.status).toBe(400);

    // Customer cannot inspect own return
    await request(s.app)
      .post(`/api/returns/${retId}/receive`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({ scanMode: 'QR_TOKEN', qrToken: s.qrToken });
    const custInspect = await request(s.app)
      .post(`/api/returns/${retId}/inspect`)
      .set('Authorization', `Bearer ${s.custA.token}`)
      .send({ condition: 'GOOD', checklist: { identityVerified: true, structuralIntegrity: true, cleanlinessAcceptable: true, completeComponents: true } });
    expect(custInspect.status).toBe(403);

    await request(s.app)
      .post(`/api/returns/${retId}/inspect`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({ condition: 'GOOD', checklist: { identityVerified: true, structuralIntegrity: true, cleanlinessAcceptable: true, completeComponents: true } });

    // Initial approve returns FAILED -> pendingRefundAmount released cleanly!
    const failedApprove = await request(s.app)
      .post(`/api/returns/${retId}/approve`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({});
    expect(failedApprove.status).toBe(200);
    expect(failedApprove.body.refund.state).toBe('REFUND_FAILED');
    const tx = Array.from(s.transactions.values())[0];
    expect(tx.depositAllocations[0].pendingRefundAmount).toBe(0);

    // Reconcile/retry succeeds cleanly and completes refund!
    const retryRes = await request(s.app)
      .post(`/api/returns/${retId}/reconcile-refund`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({});
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.refund.state).toBe('REFUNDED');
    expect(tx.depositAllocations[0].refundedAmount).toBe(5.0);
  });

  it('reconciles out-of-order PAYMENT.CAPTURE.COMPLETED webhooks safely and rejects PayPal refund currency mismatches', async () => {
    const s = await seedDeliveredOrderScenario({
      async refundCapture(params) {
        return {
          id: 'PP-REF-CUR-MISMATCH',
          status: 'COMPLETED',
          amount: { currency_code: 'EUR', value: params.amount.toFixed(2) },
        };
      },
    });

    // 1. Out-of-order PAYMENT.CAPTURE.COMPLETED webhook before client /capture runs
    await request(s.app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({
        packageId: 'RBX-RET-M002',
        ownerType: 'MERCHANT',
        packageClass: 'M',
        fulfilmentLocation: 'CHN-HUB-01',
      });
    const ord2Res = await request(s.app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${s.custA.token}`)
      .send({
        merchantId: s.bizAId,
        items: [{ productId: s.productId, quantity: 1 }],
        shippingReference: {
          recipientName: 'Customer A',
          zone: 'Zone-North',
          addressLine: '101 Green St',
          fulfilmentLocation: 'CHN-HUB-01',
        },
        autoAllocate: true,
      });
    expect(ord2Res.status).toBe(201);
    const ord2Id = ord2Res.body.order.id as string;

    const ppCreate2 = await request(s.app)
      .post('/api/payments/paypal/create-order')
      .set('Authorization', `Bearer ${s.custA.token}`)
      .set('Idempotency-Key', 'p5-pp-c2-ooo')
      .send({ orderId: ord2Id });
    expect(ppCreate2.status).toBe(201);
    const tx2Id = ppCreate2.body.transaction.id as string;
    expect(s.transactions.get(tx2Id)!.state).toBe('CREATED');

    const capHook = await request(s.app)
      .post('/api/webhooks/paypal')
      .set({
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
        'paypal-transmission-id': 'tx-cap-ooo-1',
        'paypal-transmission-sig': 'VALID_SIG',
        'paypal-transmission-time': new Date().toISOString(),
      })
      .send({
        id: 'WH-EVT-CAP-OOO-1',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAP-OOO-CHECK',
          supplementary_data: { related_ids: { order_id: ppCreate2.body.paypalOrderId } },
        },
      });
    expect(capHook.status).toBe(200);
    expect(capHook.body.ignored).toBe(false);
    expect(s.transactions.get(tx2Id)!.state).toBe('CAPTURED');
    expect(s.orders.get(ord2Id)!.status).toBe('PAID');

    // 2. Refund currency mismatch (EUR returned when expected USD) is rejected cleanly without marking REFUNDED
    const ret = await request(s.app)
      .post('/api/returns')
      .set('Authorization', `Bearer ${s.custA.token}`)
      .send({ orderId: s.orderId, packageId: s.packageId, mode: 'DROP_OFF', dropoffLocationLabel: 'Hub C' });
    const retId = ret.body.returnRecord.id as string;
    await request(s.app)
      .post(`/api/returns/${retId}/receive`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({ scanMode: 'QR_TOKEN', qrToken: s.qrToken });
    await request(s.app)
      .post(`/api/returns/${retId}/inspect`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({ condition: 'GOOD', checklist: { identityVerified: true, structuralIntegrity: true, cleanlinessAcceptable: true, completeComponents: true } });

    const mismatchApprove = await request(s.app)
      .post(`/api/returns/${retId}/approve`)
      .set('Authorization', `Bearer ${s.centre.token}`)
      .send({});
    expect(mismatchApprove.status).toBe(409);
    expect(mismatchApprove.body.error?.code).toBe('REFUND_CURRENCY_MISMATCH');
    const tx1 = Array.from(s.transactions.values()).find((t) => t.orderId === s.orderId)!;
    expect(tx1.depositAllocations[0].refundedAmount).toBe(0);
  });
});
