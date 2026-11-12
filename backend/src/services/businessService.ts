import { ClientSession } from 'mongoose';
import { config } from '../config/env.js';
import {
  BusinessDto,
  BusinessRepository,
  defaultTransactionRunner,
  MongooseBusinessRepository,
  PaginatedResult,
} from '../repositories/phase2Repositories.js';
import { resolveMerchantScope } from '../middleware/rbac.js';
import { AuthPrincipal, OwnershipModel } from '../types/domain.js';
import { conflict, forbidden, notFound } from '../utils/errors.js';
import { AuditWriter, defaultAuditWriter } from './auditService.js';

export type TransactionRunner = <T>(
  work: (session: ClientSession | null) => Promise<T>
) => Promise<T>;

export interface CreateBusinessInput {
  name: string;
  legalName: string;
  slug: string;
  ownerUserId?: string;
  currency?: string;
  packagingModel?: OwnershipModel;
  allowCrossMerchantPool?: boolean;
  policies?: {
    returnWindowDays?: number;
    autoApproveOnPass?: boolean;
    depositMultiplier?: number;
    allowedReturnApprovers?: string[];
  };
  subscription?: {
    plan: 'STARTER' | 'BUSINESS' | 'ENTERPRISE';
  };
  status?: 'ACTIVE' | 'ONBOARDING';
}

export class BusinessService {
  constructor(
    private readonly businesses: BusinessRepository = new MongooseBusinessRepository(),
    private readonly audit: AuditWriter = defaultAuditWriter,
    private readonly runTx: TransactionRunner = defaultTransactionRunner
  ) {}

  async createBusiness(
    input: CreateBusinessInput,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<BusinessDto> {
    const normalizedSlug = input.slug.toLowerCase().trim();
    const existing = await this.businesses.findBySlug(normalizedSlug);
    if (existing) {
      throw conflict(`Business slug "${normalizedSlug}" is already taken.`, 'DUPLICATE_SLUG');
    }

    const isAdmin = caller.role === 'ADMIN';
    if (!isAdmin && caller.businessId) {
      throw forbidden('Your account is already linked to a business.');
    }

    // Non-admin onboarding requests always start in ONBOARDING pending Admin approval.
    const initialStatus: BusinessDto['status'] = isAdmin ? (input.status ?? 'ACTIVE') : 'ONBOARDING';
    const ownerUserId = isAdmin && input.ownerUserId ? input.ownerUserId : caller.userId;

    const created = await this.runTx(async (session) => {
      const biz = await this.businesses.create(
        {
          ownerUserId,
          name: input.name.trim(),
          legalName: input.legalName.trim(),
          slug: normalizedSlug,
          currency: (input.currency ?? config.defaultCurrency).toUpperCase(),
          packagingModel: input.packagingModel ?? 'HYBRID',
          allowCrossMerchantPool: input.allowCrossMerchantPool ?? true,
          policies: {
            returnWindowDays: input.policies?.returnWindowDays ?? 14,
            autoApproveOnPass: input.policies?.autoApproveOnPass ?? true,
            depositMultiplier: input.policies?.depositMultiplier ?? 1.0,
            allowedReturnApprovers: input.policies?.allowedReturnApprovers ?? [
              'COLLECTION_CENTRE',
              'MERCHANT_ADMIN',
              'ADMIN',
            ],
          },
          subscription: {
            plan: input.subscription?.plan ?? 'STARTER',
            status: 'ACTIVE',
          },
          status: initialStatus,
        },
        session
      );

      if (biz.status === 'ACTIVE') {
        await this.businesses.linkOwnerUser(ownerUserId, biz.id, session);
      }
      return biz;
    });

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'BUSINESS_CREATED',
      entityType: 'Business',
      entityId: created.id,
      businessId: created.id,
      afterSummary: {
        name: created.name,
        slug: created.slug,
        status: created.status,
        packagingModel: created.packagingModel,
      },
      correlationId: meta?.correlationId,
    });

    return created;
  }

  async approveOrUpdateStatus(
    businessId: string,
    nextStatus: BusinessDto['status'],
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<BusinessDto> {
    if (caller.role !== 'ADMIN') {
      throw forbidden('Only ReBoxify Administrators can approve or suspend businesses.');
    }

    const updated = await this.runTx(async (session) => {
      const existing = await this.businesses.findById(businessId, session);
      if (!existing) {
        throw notFound('Business not found.');
      }

      const saved = await this.businesses.updateStatus(businessId, nextStatus, session);
      if (!saved) {
        throw notFound('Business not found.');
      }

      if (nextStatus === 'ACTIVE') {
        await this.businesses.linkOwnerUser(existing.ownerUserId, saved.id, session);
      }

      await this.audit.record({
        actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
        action: 'BUSINESS_STATUS_UPDATED',
        entityType: 'Business',
        entityId: saved.id,
        businessId: saved.id,
        beforeSummary: { status: existing.status },
        afterSummary: { status: saved.status },
        correlationId: meta?.correlationId,
      });

      return saved;
    });

    return updated;
  }

  async updatePolicies(
    businessId: string,
    updates: {
      packagingModel?: OwnershipModel;
      allowCrossMerchantPool?: boolean;
      currency?: string;
      policies?: Partial<BusinessDto['policies']>;
    },
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<BusinessDto> {
    const scopedId = resolveMerchantScope(caller, businessId);
    const targetId = scopedId ?? businessId;

    const existing = await this.businesses.findById(targetId);
    if (!existing) {
      throw notFound('Business not found.');
    }

    const mergedPolicies = updates.policies
      ? { ...existing.policies, ...updates.policies }
      : existing.policies;

    const updated = await this.businesses.updatePolicies(targetId, {
      ...(updates.packagingModel ? { packagingModel: updates.packagingModel } : {}),
      ...(updates.allowCrossMerchantPool !== undefined
        ? { allowCrossMerchantPool: updates.allowCrossMerchantPool }
        : {}),
      ...(updates.currency ? { currency: updates.currency.toUpperCase() } : {}),
      policies: mergedPolicies,
    });

    if (!updated) throw notFound('Business not found.');

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'BUSINESS_POLICIES_UPDATED',
      entityType: 'Business',
      entityId: updated.id,
      businessId: updated.id,
      beforeSummary: {
        packagingModel: existing.packagingModel,
        policies: existing.policies,
      },
      afterSummary: {
        packagingModel: updated.packagingModel,
        policies: updated.policies,
      },
      correlationId: meta?.correlationId,
    });

    return updated;
  }

  async getBusinessById(businessId: string, caller: AuthPrincipal): Promise<BusinessDto> {
    const biz = await this.businesses.findById(businessId);
    if (!biz) throw notFound('Business not found.');

    if (caller.role === 'ADMIN') return biz;

    if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      if (caller.businessId !== biz.id) {
        throw forbidden('Cross-tenant business access is prohibited.');
      }
      return biz;
    }

    if (biz.status !== 'ACTIVE') {
      throw notFound('Business storefront is not active.');
    }
    return biz;
  }

  async listBusinesses(
    params: { status?: string; packagingModel?: string; page: number; pageSize: number },
    caller: AuthPrincipal
  ): Promise<PaginatedResult<BusinessDto>> {
    if (caller.role === 'ADMIN') {
      return this.businesses.list(params);
    }

    if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      if (!caller.businessId) {
        return { items: [], total: 0, page: params.page, pageSize: params.pageSize };
      }
      return this.businesses.list({
        ...params,
        businessId: caller.businessId,
      });
    }

    // Customers and operational roles only see active storefront directory entries.
    return this.businesses.list({
      ...params,
      status: 'ACTIVE',
    });
  }
}

