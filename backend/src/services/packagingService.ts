import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { resolveMerchantScope } from '../middleware/rbac.js';
import {
  BusinessRepository,
  MongooseBusinessRepository,
  MongoosePackageRepository,
  PackageDto,
  PackageRepository,
  PaginatedResult,
} from '../repositories/phase2Repositories.js';
import {
  AuthPrincipal,
  PackageClass,
  PackageOwnerType,
  PackageStatus,
} from '../types/domain.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { AuditWriter, defaultAuditWriter } from './auditService.js';
import { calculateConfiguredDeposit, PACKAGING_CATALOGUE } from './packagingCatalogue.js';
import { defaultQrService, QrLabelData, QrService } from './qrService.js';

export interface RegisterPackageInput {
  packageId?: string;
  ownerType: PackageOwnerType;
  ownerId?: string;
  packageClass: PackageClass;
  fulfilmentLocation: string;
  currency?: string;
  maxLifecycleLimit?: number;
  initialCustodian?: {
    custodianType: 'REBOXIFY_CENTRE' | 'MERCHANT';
    custodianId: string;
    label: string;
  };
}

export interface RegisterPackageResult {
  package: PackageDto;
  qrPayload: {
    packageId: string;
    token: string;
    tokenVersion: number;
    expiresAt: string;
  };
  label: QrLabelData;
}

export class PackagingService {
  constructor(
    private readonly packages: PackageRepository = new MongoosePackageRepository(),
    private readonly businesses: BusinessRepository = new MongooseBusinessRepository(),
    private readonly audit: AuditWriter = defaultAuditWriter,
    private readonly qr: QrService = defaultQrService
  ) {}

  getCatalogue(currency: string = config.defaultCurrency) {
    const normalizedCurrency = currency.toUpperCase();
    return Object.values(PACKAGING_CATALOGUE).map((spec) => ({
      packageClass: spec.packageClass,
      dimensionsCm: spec.dimensionsCm,
      maxWeightKg: spec.maxWeightKg,
      protectionCategory: spec.protectionCategory,
      supportsLiquidContainment: spec.supportsLiquidContainment,
      replacementValue:
        spec.replacementValueByCurrency[normalizedCurrency] ??
        spec.replacementValueByCurrency.USD,
      baseDeposit:
        spec.baseDepositByCurrency[normalizedCurrency] ??
        spec.baseDepositByCurrency.USD,
      usageFee:
        spec.usageFeeByCurrency[normalizedCurrency] ??
        spec.usageFeeByCurrency.USD,
      currency: normalizedCurrency,
    }));
  }

  async registerPackage(
    input: RegisterPackageInput,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<RegisterPackageResult> {
    let resolvedOwnerType: PackageOwnerType = input.ownerType;
    let resolvedOwnerId: string | undefined = input.ownerId;

    if (caller.role === 'MERCHANT_ADMIN') {
      if (input.ownerType !== 'MERCHANT') {
        throw forbidden('Merchants may only register MERCHANT-owned packages.');
      }
      resolvedOwnerId = resolveMerchantScope(caller, input.ownerId);
      resolvedOwnerType = 'MERCHANT';
    } else if (caller.role !== 'ADMIN') {
      throw forbidden('Only Admins or Merchant Admins may register reusable packages.');
    }

    if (resolvedOwnerType === 'MERCHANT' && !resolvedOwnerId) {
      throw badRequest('ownerId (merchant business ID) is required for MERCHANT packages.');
    }
    if (resolvedOwnerType === 'REBOXIFY_POOL') {
      resolvedOwnerId = undefined;
    }

    let ownerBusinessName = 'ReBoxify Network Pool';
    if (resolvedOwnerId) {
      const biz = await this.businesses.findById(resolvedOwnerId);
      if (!biz) throw notFound('Owner merchant business not found.');
      ownerBusinessName = biz.name;
    }

    const locPrefix =
      input.fulfilmentLocation
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase()
        .slice(0, 3) || 'GEN';
    const generatedId = `RBX-${locPrefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const packageId = (input.packageId?.trim().toUpperCase() || generatedId);

    const existing = await this.packages.findByPackageId(packageId);
    if (existing) {
      throw conflict(`Package ID "${packageId}" already exists.`, 'DUPLICATE_PACKAGE_ID');
    }

    const spec = PACKAGING_CATALOGUE[input.packageClass];
    const currency = (input.currency ?? config.defaultCurrency).toUpperCase();
    const depositCalc = calculateConfiguredDeposit({
      packageClass: input.packageClass,
      currency,
    });
    const replacementValue =
      spec.replacementValueByCurrency[currency] ?? spec.replacementValueByCurrency.USD;

    const issued = this.qr.issuePackageToken(packageId, 1);

    // Ownership and custody remain strictly separate concepts.
    const defaultCustodian =
      resolvedOwnerType === 'MERCHANT' && resolvedOwnerId
        ? {
            custodianType: 'MERCHANT' as const,
            custodianId: resolvedOwnerId,
            label: `${ownerBusinessName} (${input.fulfilmentLocation})`,
            assignedAt: new Date(),
          }
        : {
            custodianType: 'REBOXIFY_CENTRE' as const,
            custodianId: `HUB-${locPrefix}`,
            label: `ReBoxify Hub (${input.fulfilmentLocation})`,
            assignedAt: new Date(),
          };

    const currentCustodian = input.initialCustodian
      ? { ...input.initialCustodian, assignedAt: new Date() }
      : defaultCustodian;

    const created = await this.packages.create({
      packageId,
      qrTokenHash: issued.tokenHash,
      qrTokenVersion: issued.tokenVersion,
      qrRevoked: false,
      ownerType: resolvedOwnerType,
      ownerId: resolvedOwnerId,
      packageClass: input.packageClass,
      dimensionsCm: spec.dimensionsCm,
      maxWeightKg: spec.maxWeightKg,
      protectionCategory: spec.protectionCategory,
      supportsLiquidContainment: spec.supportsLiquidContainment,
      material: 'REUSABLE_PP',
      replacementValue,
      depositAmount: depositCalc.amount,
      currency,
      status: 'AVAILABLE',
      condition: 'NEW',
      reuseCount: 0,
      maxLifecycleLimit: input.maxLifecycleLimit ?? 50,
      fulfilmentLocation: input.fulfilmentLocation.trim(),
      currentCustodian,
    });

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'PACKAGE_REGISTERED',
      entityType: 'Package',
      entityId: created.packageId,
      businessId: resolvedOwnerId,
      afterSummary: {
        packageId: created.packageId,
        ownerType: created.ownerType,
        ownerId: created.ownerId,
        custodian: created.currentCustodian,
        packageClass: created.packageClass,
      },
      correlationId: meta?.correlationId,
    });

    return {
      package: created,
      qrPayload: {
        packageId: created.packageId,
        token: issued.token,
        tokenVersion: issued.tokenVersion,
        expiresAt: issued.expiresAt.toISOString(),
      },
      label: this.qr.buildLabelData(created, issued),
    };
  }

  async listInventory(
    params: {
      merchantId?: string;
      status?: PackageStatus;
      packageClass?: PackageClass;
      ownerType?: PackageOwnerType;
      search?: string;
      page: number;
      pageSize: number;
      sortBy?: string;
      sortDir?: 'asc' | 'desc';
    },
    caller: AuthPrincipal
  ): Promise<PaginatedResult<PackageDto>> {
    if (caller.role === 'ADMIN' || caller.role === 'COLLECTION_CENTRE') {
      return this.packages.list(params);
    }

    if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      const scopedMerchantId = resolveMerchantScope(caller, params.merchantId);
      const business = scopedMerchantId ? await this.businesses.findById(scopedMerchantId) : null;
      const includeSharedPool = business ? business.packagingModel !== 'MERCHANT_OWNED' : false;

      return this.packages.list({
        ...params,
        merchantId: scopedMerchantId,
        includeSharedPool,
      });
    }

    throw forbidden('Inventory listing requires merchant, collection centre, or admin access.');
  }
}

