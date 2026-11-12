import crypto from 'node:crypto';
import mongoose, { ClientSession } from 'mongoose';
import { config } from '../config/env.js';
import {
  BusinessModel,
  OrderModel,
  PackageEventModel,
  PackageModel,
  ProductModel,
  UserModel,
} from '../models/index.js';
import { enqueueSearchOutbox } from './outboxHelper.js';
import {
  OrderStatus,
  OwnershipModel,
  PackageClass,
  PackageOwnerType,
  PackageStatus,
  UserRole,
} from '../types/domain.js';
import { serviceUnavailable } from '../utils/errors.js';

export interface BusinessDto {
  id: string;
  ownerUserId: string;
  name: string;
  legalName: string;
  slug: string;
  currency: string;
  packagingModel: OwnershipModel;
  allowCrossMerchantPool: boolean;
  policies: {
    returnWindowDays: number;
    autoApproveOnPass: boolean;
    depositMultiplier: number;
    allowedReturnApprovers: string[];
  };
  subscription: {
    plan: 'STARTER' | 'BUSINESS' | 'ENTERPRISE';
    status: 'ACTIVE' | 'PAUSED' | 'CANCELLED';
  };
  status: 'ACTIVE' | 'ONBOARDING' | 'SUSPENDED';
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductDto {
  id: string;
  merchantId: string;
  sku: string;
  name: string;
  dimensionsCm: { length: number; width: number; height: number };
  weightKg: number;
  allowedOrientations: string[];
  rotatable: boolean;
  fragility: 'LOW' | 'MEDIUM' | 'HIGH';
  restrictions: {
    liquidContainment: boolean;
    temperatureControlled: boolean;
    contaminationSensitive: boolean;
    notes?: string;
  };
  unitPrice: number;
  currency: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PackageDto {
  id: string;
  packageId: string;
  qrTokenHash: string;
  qrTokenVersion?: number;
  qrRevoked?: boolean;
  qrRevokedAt?: Date;
  qrRevokedReason?: string;
  ownerType: PackageOwnerType;
  ownerId?: string;
  packageClass: PackageClass;
  dimensionsCm: { length: number; width: number; height: number };
  maxWeightKg: number;
  protectionCategory: 'STANDARD' | 'REINFORCED' | 'HIGH_PROTECTION';
  supportsLiquidContainment: boolean;
  material: string;
  replacementValue: number;
  depositAmount: number;
  currency: string;
  status: PackageStatus;
  condition: 'NEW' | 'GOOD' | 'MINOR_WEAR' | 'DAMAGED' | 'CONTAMINATED';
  reuseCount: number;
  maxLifecycleLimit: number;
  fulfilmentLocation: string;
  currentCustodian: {
    custodianType: 'REBOXIFY_CENTRE' | 'MERCHANT' | 'DELIVERY_PARTNER' | 'CUSTOMER';
    custodianId: string;
    label: string;
    assignedAt: Date;
  };
  currentOrderId?: string;
  assignedPartnerUserId?: string;
  assignedPartnerName?: string;
  lastInspectionAt?: Date;
  lastInspectionOutcome?: 'PASS' | 'FAIL' | 'NEEDS_REVIEW';
  lastCleanedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderAllocatedPackageDto {
  packageRef: string;
  packageId: string;
  packageClass: string;
  ownerType: string;
  depositAmount: number;
  depositBreakdown?: {
    baseDeposit: number;
    multiplier: number;
    replacementValue: number;
    ruleVersion: string;
  };
  explanation?: string;
  explanationSource?: 'GEMINI' | 'TEMPLATE';
}

export interface OrderDto {
  id: string;
  orderNumber: string;
  merchantId: string;
  customerId: string;
  items: Array<{
    productId: string;
    sku: string;
    name: string;
    quantity: number;
    unitPrice: number;
  }>;
  shippingReference: {
    recipientName: string;
    zone: string;
    addressLine: string;
    fulfilmentLocation: string;
  };
  allocatedPackages: OrderAllocatedPackageDto[];
  allocationMetadata?: {
    outcome: string;
    policyVersion: string;
    allocatedAt?: Date;
    splitRecommended?: boolean;
    notes?: string;
  };
  totals: {
    productSubtotal: number;
    depositTotal: number;
    shippingTotal: number;
    taxTotal: number;
    grandTotal: number;
  };
  currency: string;
  status: OrderStatus;
  returnDeadlineAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaginationQuery {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface BusinessRepository {
  create(
    input: Omit<BusinessDto, 'id' | 'createdAt' | 'updatedAt'>,
    session?: ClientSession | null
  ): Promise<BusinessDto>;
  findById(id: string, session?: ClientSession | null): Promise<BusinessDto | null>;
  findBySlug(slug: string): Promise<BusinessDto | null>;
  list(filters: {
    status?: string;
    packagingModel?: string;
    businessId?: string;
    page: number;
    pageSize: number;
  }): Promise<PaginatedResult<BusinessDto>>;
  updateStatus(
    id: string,
    status: BusinessDto['status'],
    session?: ClientSession | null
  ): Promise<BusinessDto | null>;
  updatePolicies(
    id: string,
    updates: Partial<
      Pick<BusinessDto, 'packagingModel' | 'allowCrossMerchantPool' | 'currency' | 'policies'>
    >,
    session?: ClientSession | null
  ): Promise<BusinessDto | null>;
  linkOwnerUser(
    userId: string,
    businessId: string,
    session?: ClientSession | null
  ): Promise<void>;
}

export interface ProductRepository {
  upsertBySku(
    input: Omit<ProductDto, 'id' | 'createdAt' | 'updatedAt'>,
    session?: ClientSession | null
  ): Promise<ProductDto>;
  findByMerchantAndIds(
    merchantId: string,
    productIds: string[],
    session?: ClientSession | null
  ): Promise<ProductDto[]>;
  listByMerchant(filters: {
    merchantId?: string;
    activeOnly?: boolean;
    search?: string;
    page: number;
    pageSize: number;
  }): Promise<PaginatedResult<ProductDto>>;
}

export interface PackageRepository {
  create(
    input: Omit<PackageDto, 'id' | 'createdAt' | 'updatedAt'>,
    session?: ClientSession | null
  ): Promise<PackageDto>;
  findByPackageId(packageId: string, session?: ClientSession | null): Promise<PackageDto | null>;
  list(filters: {
    merchantId?: string;
    includeSharedPool?: boolean;
    status?: PackageStatus;
    packageClass?: PackageClass;
    ownerType?: PackageOwnerType;
    search?: string;
    page: number;
    pageSize: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  }): Promise<PaginatedResult<PackageDto>>;
  findCandidatesForAllocation(
    merchantId: string,
    allowSharedPool: boolean,
    allowCrossMerchantHybrid: boolean,
    session?: ClientSession | null
  ): Promise<PackageDto[]>;
  reservePackagesAtomically(
    reservations: Array<{
      packageRefId: string;
      packageId: string;
      orderId: string;
      merchantId: string;
      merchantCustodianLabel: string;
      actor: { userId: string; role: UserRole };
      correlationId?: string;
    }>,
    session?: ClientSession | null
  ): Promise<PackageDto[] | null>;
}

export interface OrderRepository {
  create(
    input: Omit<OrderDto, 'id' | 'createdAt' | 'updatedAt'>,
    session?: ClientSession | null
  ): Promise<OrderDto>;
  findById(id: string, session?: ClientSession | null): Promise<OrderDto | null>;
  list(filters: {
    merchantId?: string;
    customerId?: string;
    status?: OrderStatus;
    page: number;
    pageSize: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  }): Promise<PaginatedResult<OrderDto>>;
  applyAllocationAtomically(
    orderId: string,
    update: {
      allocatedPackages: OrderAllocatedPackageDto[];
      allocationMetadata: NonNullable<OrderDto['allocationMetadata']>;
      depositTotal: number;
      grandTotal: number;
      status: OrderStatus;
    },
    session?: ClientSession | null
  ): Promise<OrderDto | null>;
}

function ensureDbReady(): void {
  if (mongoose.connection.readyState !== 1) {
    throw serviceUnavailable('Database connection is not active. Configure MONGODB_URI.');
  }
}

function mapBusiness(doc: any): BusinessDto {
  return {
    id: doc._id.toString(),
    ownerUserId: doc.ownerUserId.toString(),
    name: doc.name,
    legalName: doc.legalName,
    slug: doc.slug,
    currency: doc.currency,
    packagingModel: doc.packagingModel,
    allowCrossMerchantPool: Boolean(doc.allowCrossMerchantPool),
    policies: {
      returnWindowDays: doc.policies?.returnWindowDays ?? 14,
      autoApproveOnPass: doc.policies?.autoApproveOnPass ?? true,
      depositMultiplier: doc.policies?.depositMultiplier ?? 1.0,
      allowedReturnApprovers: doc.policies?.allowedReturnApprovers ?? ['COLLECTION_CENTRE', 'MERCHANT_ADMIN', 'ADMIN'],
    },
    subscription: doc.subscription ?? { plan: 'STARTER', status: 'ACTIVE' },
    status: doc.status,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function mapProduct(doc: any): ProductDto {
  return {
    id: doc._id.toString(),
    merchantId: doc.merchantId.toString(),
    sku: doc.sku,
    name: doc.name,
    dimensionsCm: doc.dimensionsCm,
    weightKg: doc.weightKg,
    allowedOrientations: doc.allowedOrientations ?? ['UPRIGHT'],
    rotatable: Boolean(doc.rotatable),
    fragility: doc.fragility ?? 'LOW',
    restrictions: {
      liquidContainment: Boolean(doc.restrictions?.liquidContainment),
      temperatureControlled: Boolean(doc.restrictions?.temperatureControlled),
      contaminationSensitive: Boolean(doc.restrictions?.contaminationSensitive),
      notes: doc.restrictions?.notes,
    },
    unitPrice: doc.unitPrice,
    currency: doc.currency,
    active: Boolean(doc.active),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function mapPackageDto(doc: any): PackageDto {
  return {
    id: doc._id.toString(),
    packageId: doc.packageId,
    qrTokenHash: doc.qrTokenHash,
    qrTokenVersion: doc.qrTokenVersion ?? 1,
    qrRevoked: Boolean(doc.qrRevoked),
    qrRevokedAt: doc.qrRevokedAt,
    qrRevokedReason: doc.qrRevokedReason,
    ownerType: doc.ownerType,
    ownerId: doc.ownerId ? doc.ownerId.toString() : undefined,
    packageClass: doc.packageClass,
    dimensionsCm: doc.dimensionsCm,
    maxWeightKg: doc.maxWeightKg,
    protectionCategory: doc.protectionCategory ?? 'STANDARD',
    supportsLiquidContainment: Boolean(doc.supportsLiquidContainment),
    material: doc.material ?? 'REUSABLE_PP',
    replacementValue: doc.replacementValue,
    depositAmount: doc.depositAmount,
    currency: doc.currency,
    status: doc.status,
    condition: doc.condition,
    reuseCount: doc.reuseCount ?? 0,
    maxLifecycleLimit: doc.maxLifecycleLimit ?? 50,
    fulfilmentLocation: doc.fulfilmentLocation,
    currentCustodian: doc.currentCustodian,
    currentOrderId: doc.currentOrderId ? doc.currentOrderId.toString() : undefined,
    assignedPartnerUserId: doc.assignedPartnerUserId ? doc.assignedPartnerUserId.toString() : undefined,
    assignedPartnerName: doc.assignedPartnerName,
    lastInspectionAt: doc.lastInspectionAt,
    lastInspectionOutcome: doc.lastInspectionOutcome,
    lastCleanedAt: doc.lastCleanedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function mapOrder(doc: any): OrderDto {
  return {
    id: doc._id.toString(),
    orderNumber: doc.orderNumber,
    merchantId: doc.merchantId.toString(),
    customerId: doc.customerId.toString(),
    items: (doc.items ?? []).map((i: any) => ({
      productId: i.productId.toString(),
      sku: i.sku,
      name: i.name,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
    })),
    shippingReference: doc.shippingReference,
    allocatedPackages: (doc.allocatedPackages ?? []).map((p: any) => ({
      packageRef: p.packageRef.toString(),
      packageId: p.packageId,
      packageClass: p.packageClass,
      ownerType: p.ownerType,
      depositAmount: p.depositAmount,
      depositBreakdown: p.depositBreakdown,
      explanation: p.explanation,
      explanationSource: p.explanationSource,
    })),
    allocationMetadata: doc.allocationMetadata,
    totals: doc.totals,
    currency: doc.currency,
    status: doc.status,
    returnDeadlineAt: doc.returnDeadlineAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export class MongooseBusinessRepository implements BusinessRepository {
  async create(
    input: Omit<BusinessDto, 'id' | 'createdAt' | 'updatedAt'>,
    session?: ClientSession | null
  ): Promise<BusinessDto> {
    ensureDbReady();
    const [doc] = await BusinessModel.create(
      [
        {
          ...input,
          ownerUserId: new mongoose.Types.ObjectId(input.ownerUserId),
        },
      ],
      { session: session ?? undefined }
    );
    return mapBusiness(doc);
  }

  async findById(id: string, session?: ClientSession | null): Promise<BusinessDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const doc = await BusinessModel.findById(id)
      .session(session ?? null)
      .lean();
    return doc ? mapBusiness(doc) : null;
  }

  async findBySlug(slug: string): Promise<BusinessDto | null> {
    ensureDbReady();
    const doc = await BusinessModel.findOne({ slug: slug.toLowerCase().trim() }).lean();
    return doc ? mapBusiness(doc) : null;
  }

  async list(filters: {
    status?: string;
    packagingModel?: string;
    businessId?: string;
    page: number;
    pageSize: number;
  }): Promise<PaginatedResult<BusinessDto>> {
    ensureDbReady();
    const query: Record<string, unknown> = {};
    if (filters.status) query.status = filters.status;
    if (filters.packagingModel) query.packagingModel = filters.packagingModel;
    if (filters.businessId) query._id = new mongoose.Types.ObjectId(filters.businessId);

    const [docs, total] = await Promise.all([
      BusinessModel.find(query)
        .sort({ createdAt: -1 })
        .skip((filters.page - 1) * filters.pageSize)
        .limit(filters.pageSize)
        .lean(),
      BusinessModel.countDocuments(query),
    ]);
    return {
      items: docs.map(mapBusiness),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async updateStatus(
    id: string,
    status: BusinessDto['status'],
    session?: ClientSession | null
  ): Promise<BusinessDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const doc = await BusinessModel.findByIdAndUpdate(
      id,
      { $set: { status } },
      { new: true, session: session ?? undefined }
    ).lean();
    return doc ? mapBusiness(doc) : null;
  }

  async updatePolicies(
    id: string,
    updates: Partial<
      Pick<BusinessDto, 'packagingModel' | 'allowCrossMerchantPool' | 'currency' | 'policies'>
    >,
    session?: ClientSession | null
  ): Promise<BusinessDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const doc = await BusinessModel.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, session: session ?? undefined }
    ).lean();
    return doc ? mapBusiness(doc) : null;
  }

  async linkOwnerUser(
    userId: string,
    businessId: string,
    session?: ClientSession | null
  ): Promise<void> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(userId)) return;
    const user = await UserModel.findById(userId).session(session ?? null);
    if (!user) return;
    user.businessId = new mongoose.Types.ObjectId(businessId);
    if (user.role === 'CUSTOMER') {
      user.role = 'MERCHANT_ADMIN';
    }
    await user.save({ session: session ?? undefined });
  }
}

export class MongooseProductRepository implements ProductRepository {
  async upsertBySku(
    input: Omit<ProductDto, 'id' | 'createdAt' | 'updatedAt'>,
    session?: ClientSession | null
  ): Promise<ProductDto> {
    ensureDbReady();
    const doc = await ProductModel.findOneAndUpdate(
      {
        merchantId: new mongoose.Types.ObjectId(input.merchantId),
        sku: input.sku.toUpperCase().trim(),
      },
      {
        $set: {
          ...input,
          merchantId: new mongoose.Types.ObjectId(input.merchantId),
          sku: input.sku.toUpperCase().trim(),
        },
      },
      { upsert: true, new: true, runValidators: true, session: session ?? undefined }
    ).lean();
    return mapProduct(doc);
  }

  async findByMerchantAndIds(
    merchantId: string,
    productIds: string[],
    session?: ClientSession | null
  ): Promise<ProductDto[]> {
    ensureDbReady();
    const validIds = productIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));
    if (validIds.length === 0) return [];
    const docs = await ProductModel.find({
      merchantId: new mongoose.Types.ObjectId(merchantId),
      _id: { $in: validIds },
    })
      .session(session ?? null)
      .lean();
    return docs.map(mapProduct);
  }

  async listByMerchant(filters: {
    merchantId?: string;
    activeOnly?: boolean;
    search?: string;
    page: number;
    pageSize: number;
  }): Promise<PaginatedResult<ProductDto>> {
    ensureDbReady();
    const query: Record<string, unknown> = {};
    if (filters.merchantId) query.merchantId = new mongoose.Types.ObjectId(filters.merchantId);
    if (filters.activeOnly) query.active = true;
    if (filters.search) {
      query.$or = [
        { sku: { $regex: filters.search, $options: 'i' } },
        { name: { $regex: filters.search, $options: 'i' } },
      ];
    }

    const [docs, total] = await Promise.all([
      ProductModel.find(query)
        .sort({ updatedAt: -1 })
        .skip((filters.page - 1) * filters.pageSize)
        .limit(filters.pageSize)
        .lean(),
      ProductModel.countDocuments(query),
    ]);
    return {
      items: docs.map(mapProduct),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }
}

export class MongoosePackageRepository implements PackageRepository {
  async create(
    input: Omit<PackageDto, 'id' | 'createdAt' | 'updatedAt'>,
    session?: ClientSession | null
  ): Promise<PackageDto> {
    ensureDbReady();
    const [doc] = await PackageModel.create(
      [
        {
          ...input,
          ...(input.ownerId ? { ownerId: new mongoose.Types.ObjectId(input.ownerId) } : {}),
        },
      ],
      { session: session ?? undefined }
    );

    await PackageEventModel.create(
      [
        {
          eventId: `evt_${crypto.randomUUID()}`,
          packageId: doc.packageId,
          merchantId: doc.ownerId,
          type: 'PACKAGE_CREATED',
          actor: { userId: 'system', role: 'ADMIN' },
          occurredAt: new Date(),
          sourceSystem: 'REBOXIFY_API',
          outcome: 'ACCEPTED',
          evidence: [],
          metadata: {
            ownerType: doc.ownerType,
            packageClass: doc.packageClass,
            fulfilmentLocation: doc.fulfilmentLocation,
          },
        },
      ],
      { session: session ?? undefined }
    );

    await enqueueSearchOutbox(
      [{ entityType: 'passport', entityId: doc.packageId }],
      session
    );

    return mapPackageDto(doc);
  }

  async findByPackageId(
    packageId: string,
    session?: ClientSession | null
  ): Promise<PackageDto | null> {
    ensureDbReady();
    const doc = await PackageModel.findOne({ packageId: packageId.toUpperCase().trim() })
      .session(session ?? null)
      .lean();
    return doc ? mapPackageDto(doc) : null;
  }

  async list(filters: {
    merchantId?: string;
    includeSharedPool?: boolean;
    status?: PackageStatus;
    packageClass?: PackageClass;
    ownerType?: PackageOwnerType;
    search?: string;
    page: number;
    pageSize: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  }): Promise<PaginatedResult<PackageDto>> {
    ensureDbReady();
    const query: Record<string, unknown> = {};
    if (filters.merchantId) {
      const mId = new mongoose.Types.ObjectId(filters.merchantId);
      query.$or = filters.includeSharedPool
        ? [{ ownerId: mId }, { ownerType: 'REBOXIFY_POOL' }, { 'currentCustodian.custodianId': filters.merchantId }]
        : [{ ownerId: mId }, { 'currentCustodian.custodianId': filters.merchantId }];
    }
    if (filters.status) query.status = filters.status;
    if (filters.packageClass) query.packageClass = filters.packageClass;
    if (filters.ownerType) query.ownerType = filters.ownerType;
    if (filters.search) {
      query.packageId = { $regex: filters.search, $options: 'i' };
    }

    const allowedSort: Record<string, string> = {
      packageId: 'packageId',
      packageClass: 'packageClass',
      status: 'status',
      reuseCount: 'reuseCount',
      updatedAt: 'updatedAt',
    };
    const sortField = (filters.sortBy && allowedSort[filters.sortBy]) || 'updatedAt';
    const sortVal = filters.sortDir === 'asc' ? 1 : -1;

    const [docs, total] = await Promise.all([
      PackageModel.find(query)
        .sort({ [sortField]: sortVal })
        .skip((filters.page - 1) * filters.pageSize)
        .limit(filters.pageSize)
        .lean(),
      PackageModel.countDocuments(query),
    ]);
    return {
      items: docs.map(mapPackageDto),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async findCandidatesForAllocation(
    merchantId: string,
    allowSharedPool: boolean,
    allowCrossMerchantHybrid: boolean,
    session?: ClientSession | null
  ): Promise<PackageDto[]> {
    ensureDbReady();
    const mId = new mongoose.Types.ObjectId(merchantId);
    const ownerClauses: Record<string, unknown>[] = [{ ownerId: mId }];
    if (allowSharedPool) ownerClauses.push({ ownerType: 'REBOXIFY_POOL' });
    if (allowCrossMerchantHybrid) ownerClauses.push({ ownerType: 'HYBRID' });

    const docs = await PackageModel.find({
      status: 'AVAILABLE',
      $or: ownerClauses,
    })
      .session(session ?? null)
      .lean();
    return docs.map(mapPackageDto);
  }

  async reservePackagesAtomically(
    reservations: Array<{
      packageRefId: string;
      packageId: string;
      orderId: string;
      merchantId: string;
      merchantCustodianLabel: string;
      actor: { userId: string; role: UserRole };
      correlationId?: string;
    }>,
    session?: ClientSession | null
  ): Promise<PackageDto[] | null> {
    ensureDbReady();
    const reserved: PackageDto[] = [];
    for (const r of reservations) {
      const updated = await PackageModel.findOneAndUpdate(
        {
          _id: new mongoose.Types.ObjectId(r.packageRefId),
          status: 'AVAILABLE',
        },
        {
          $set: {
            status: 'RESERVED',
            currentOrderId: new mongoose.Types.ObjectId(r.orderId),
            currentCustodian: {
              custodianType: 'MERCHANT',
              custodianId: r.merchantId,
              label: r.merchantCustodianLabel,
              assignedAt: new Date(),
            },
          },
        },
        { new: true, session: session ?? undefined }
      ).lean();

      if (!updated) {
        return null;
      }

      const evtId = `evt_${crypto.randomUUID()}`;
      await PackageEventModel.create(
        [
          {
            eventId: evtId,
            packageId: updated.packageId,
            merchantId: new mongoose.Types.ObjectId(r.merchantId),
            type: 'PACKAGE_RESERVED',
            actor: r.actor,
            occurredAt: new Date(),
            sourceSystem: 'REBOXIFY_API',
            correlationId: r.correlationId ?? r.orderId,
            outcome: 'ACCEPTED',
            evidence: [],
            metadata: { orderId: r.orderId, ownerType: updated.ownerType },
          },
        ],
        { session: session ?? undefined }
      );

      await enqueueSearchOutbox(
        [
          { entityType: 'passport', entityId: updated.packageId },
          { entityType: 'package_event', entityId: evtId },
        ],
        session
      );

      reserved.push(mapPackageDto(updated));
    }

    return reserved;
  }
}

export class MongooseOrderRepository implements OrderRepository {
  async create(
    input: Omit<OrderDto, 'id' | 'createdAt' | 'updatedAt'>,
    session?: ClientSession | null
  ): Promise<OrderDto> {
    ensureDbReady();
    const [doc] = await OrderModel.create(
      [
        {
          ...input,
          merchantId: new mongoose.Types.ObjectId(input.merchantId),
          customerId: new mongoose.Types.ObjectId(input.customerId),
          items: input.items.map((item) => ({
            ...item,
            productId: new mongoose.Types.ObjectId(item.productId),
          })),
          allocatedPackages: input.allocatedPackages.map((pkg) => ({
            ...pkg,
            packageRef: new mongoose.Types.ObjectId(pkg.packageRef),
          })),
        },
      ],
      { session: session ?? undefined }
    );
    return mapOrder(doc);
  }

  async findById(id: string, session?: ClientSession | null): Promise<OrderDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const doc = await OrderModel.findById(id)
      .session(session ?? null)
      .lean();
    return doc ? mapOrder(doc) : null;
  }

  async list(filters: {
    merchantId?: string;
    customerId?: string;
    status?: OrderStatus;
    page: number;
    pageSize: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  }): Promise<PaginatedResult<OrderDto>> {
    ensureDbReady();
    const query: Record<string, unknown> = {};
    if (filters.merchantId) query.merchantId = new mongoose.Types.ObjectId(filters.merchantId);
    if (filters.customerId) query.customerId = new mongoose.Types.ObjectId(filters.customerId);
    if (filters.status) query.status = filters.status;

    const allowedSort: Record<string, string> = {
      orderNumber: 'orderNumber',
      status: 'status',
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
    };
    const sortField = (filters.sortBy && allowedSort[filters.sortBy]) || 'createdAt';
    const sortVal = filters.sortDir === 'asc' ? 1 : -1;

    const [docs, total] = await Promise.all([
      OrderModel.find(query)
        .sort({ [sortField]: sortVal })
        .skip((filters.page - 1) * filters.pageSize)
        .limit(filters.pageSize)
        .lean(),
      OrderModel.countDocuments(query),
    ]);
    return {
      items: docs.map(mapOrder),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async applyAllocationAtomically(
    orderId: string,
    update: {
      allocatedPackages: OrderAllocatedPackageDto[];
      allocationMetadata: NonNullable<OrderDto['allocationMetadata']>;
      depositTotal: number;
      grandTotal: number;
      status: OrderStatus;
    },
    session?: ClientSession | null
  ): Promise<OrderDto | null> {
    ensureDbReady();
    const doc = await OrderModel.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(orderId),
        allocatedPackages: { $size: 0 },
      },
      {
        $set: {
          allocatedPackages: update.allocatedPackages.map((p) => ({
            ...p,
            packageRef: new mongoose.Types.ObjectId(p.packageRef),
          })),
          allocationMetadata: update.allocationMetadata,
          'totals.depositTotal': update.depositTotal,
          'totals.grandTotal': update.grandTotal,
          status: update.status,
        },
      },
      { new: true, session: session ?? undefined }
    ).lean();
    return doc ? mapOrder(doc) : null;
  }
}

export const defaultTransactionRunner = async <T>(
  work: (session: ClientSession | null) => Promise<T>
): Promise<T> => {
  // Enforces MongoDB replica-set session transactions in production (via config/db.ts).
  const { runInTransaction } = await import('../config/db.js');
  return runInTransaction(work, {
    requireReplicaSet: process.env.NODE_ENV === 'production' || config.nodeEnv === 'production',
  });
};

export function createQrTokenHash(packageId: string): { rawToken: string; hash: string } {
  const rawToken = `${packageId}.${crypto.randomBytes(16).toString('hex')}`;
  const hash = crypto
    .createHmac('sha256', config.qrSigningSecret)
    .update(rawToken)
    .digest('hex');
  return { rawToken, hash };
}

