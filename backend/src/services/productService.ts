import { resolveMerchantScope } from '../middleware/rbac.js';
import {
  BusinessRepository,
  MongooseBusinessRepository,
  MongooseProductRepository,
  PaginatedResult,
  ProductDto,
  ProductRepository,
} from '../repositories/phase2Repositories.js';
import { AuthPrincipal } from '../types/domain.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';
import { AuditWriter, defaultAuditWriter } from './auditService.js';

export interface UpsertProductInput {
  merchantId?: string;
  sku: string;
  name: string;
  dimensionsCm: { length: number; width: number; height: number };
  weightKg: number;
  allowedOrientations?: string[];
  rotatable?: boolean;
  fragility?: 'LOW' | 'MEDIUM' | 'HIGH';
  restrictions?: {
    liquidContainment?: boolean;
    temperatureControlled?: boolean;
    contaminationSensitive?: boolean;
    notes?: string;
  };
  unitPrice: number;
  currency?: string;
  active?: boolean;
}

export class ProductService {
  constructor(
    private readonly products: ProductRepository = new MongooseProductRepository(),
    private readonly businesses: BusinessRepository = new MongooseBusinessRepository(),
    private readonly audit: AuditWriter = defaultAuditWriter
  ) {}

  async upsertProduct(
    input: UpsertProductInput,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<ProductDto> {
    const targetMerchantId = resolveMerchantScope(caller, input.merchantId);
    if (!targetMerchantId) {
      throw badRequest('merchantId is required when creating a product.');
    }

    const business = await this.businesses.findById(targetMerchantId);
    if (!business) {
      throw notFound('Target merchant business was not found.');
    }
    if (business.status !== 'ACTIVE' && caller.role !== 'ADMIN') {
      throw forbidden(`Business status ${business.status} cannot manage catalogue items.`);
    }

    const rotatable = input.rotatable ?? true;
    const allowedOrientations =
      input.allowedOrientations && input.allowedOrientations.length > 0
        ? input.allowedOrientations
        : rotatable
          ? ['UPRIGHT', 'ROTATED']
          : ['UPRIGHT'];

    const saved = await this.products.upsertBySku({
      merchantId: targetMerchantId,
      sku: input.sku.toUpperCase().trim(),
      name: input.name.trim(),
      dimensionsCm: input.dimensionsCm,
      weightKg: input.weightKg,
      allowedOrientations,
      rotatable,
      fragility: input.fragility ?? 'LOW',
      restrictions: {
        liquidContainment: Boolean(input.restrictions?.liquidContainment),
        temperatureControlled: Boolean(input.restrictions?.temperatureControlled),
        contaminationSensitive: Boolean(input.restrictions?.contaminationSensitive),
        notes: input.restrictions?.notes,
      },
      unitPrice: input.unitPrice,
      currency: (input.currency ?? business.currency).toUpperCase(),
      active: input.active ?? true,
    });

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'PRODUCT_UPSERTED',
      entityType: 'Product',
      entityId: saved.id,
      businessId: targetMerchantId,
      afterSummary: {
        sku: saved.sku,
        dimensionsCm: saved.dimensionsCm,
        weightKg: saved.weightKg,
        unitPrice: saved.unitPrice,
      },
      correlationId: meta?.correlationId,
    });

    return saved;
  }

  async listProducts(
    params: { merchantId?: string; search?: string; page: number; pageSize: number },
    caller: AuthPrincipal
  ): Promise<PaginatedResult<ProductDto>> {
    if (caller.role === 'ADMIN') {
      return this.products.listByMerchant(params);
    }

    if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      const scopedMerchantId = resolveMerchantScope(caller, params.merchantId);
      return this.products.listByMerchant({
        ...params,
        merchantId: scopedMerchantId,
      });
    }

    // Customers may browse active products of a specific active merchant storefront.
    if (!params.merchantId) {
      throw badRequest('merchantId query parameter is required to browse storefront products.');
    }
    const business = await this.businesses.findById(params.merchantId);
    if (!business || business.status !== 'ACTIVE') {
      throw notFound('Active merchant storefront not found.');
    }

    return this.products.listByMerchant({
      ...params,
      merchantId: business.id,
      activeOnly: true,
    });
  }
}

