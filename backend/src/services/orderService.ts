import crypto from 'node:crypto';
import { ClientSession } from 'mongoose';
import { resolveMerchantScope } from '../middleware/rbac.js';
import {
  BusinessRepository,
  MongooseBusinessRepository,
  MongooseOrderRepository,
  MongoosePackageRepository,
  MongooseProductRepository,
  OrderAllocatedPackageDto,
  OrderDto,
  OrderRepository,
  PackageRepository,
  PaginatedResult,
  ProductDto,
  ProductRepository,
} from '../repositories/phase2Repositories.js';
import { AuthPrincipal, OrderStatus } from '../types/domain.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { AuditWriter, defaultAuditWriter } from './auditService.js';
import {
  AllocationProductItem,
  AllocationResult,
  evaluatePackagingAllocation,
} from './allocationEngine.js';
import { TransactionRunner } from './businessService.js';
import { defaultTransactionRunner } from '../repositories/phase2Repositories.js';

export interface CreateOrderInput {
  merchantId: string;
  customerId?: string;
  items: Array<{ productId: string; quantity: number }>;
  shippingReference: {
    recipientName: string;
    zone: string;
    addressLine: string;
    fulfilmentLocation: string;
  };
  shippingTotal?: number;
  taxRate?: number;
  autoAllocate?: boolean;
  allowSplit?: boolean;
}

export interface AllocateOrderResult {
  order: OrderDto;
  allocation: AllocationResult;
  alreadyAllocated: boolean;
}

export class OrderService {
  constructor(
    private readonly orders: OrderRepository = new MongooseOrderRepository(),
    private readonly products: ProductRepository = new MongooseProductRepository(),
    private readonly businesses: BusinessRepository = new MongooseBusinessRepository(),
    private readonly packages: PackageRepository = new MongoosePackageRepository(),
    private readonly audit: AuditWriter = defaultAuditWriter,
    private readonly runTx: TransactionRunner = defaultTransactionRunner
  ) {}

  async createOrder(
    input: CreateOrderInput,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<{ order: OrderDto; allocation?: AllocationResult }> {
    let targetMerchantId = input.merchantId;
    if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      targetMerchantId = resolveMerchantScope(caller, input.merchantId) ?? input.merchantId;
    }

    const business = await this.businesses.findById(targetMerchantId);
    if (!business) throw notFound('Merchant business not found.');
    if (business.status !== 'ACTIVE') {
      throw forbidden(`Merchant business is ${business.status} and cannot accept orders.`);
    }

    const targetCustomerId = caller.role === 'CUSTOMER' ? caller.userId : input.customerId;
    if (!targetCustomerId) {
      throw badRequest('customerId is required when creating an order on behalf of a customer.');
    }

    if (!input.items || input.items.length === 0) {
      throw badRequest('Order must contain at least one product item.');
    }

    const requestedIds = Array.from(new Set(input.items.map((i) => i.productId)));
    const foundProducts = await this.products.findByMerchantAndIds(targetMerchantId, requestedIds);
    const productMap = new Map<string, ProductDto>(foundProducts.map((p) => [p.id, p]));

    const orderItems: OrderDto['items'] = [];
    let productSubtotal = 0;

    for (const reqItem of input.items) {
      const product = productMap.get(reqItem.productId);
      if (!product || !product.active) {
        throw badRequest(
          `Product ${reqItem.productId} is unavailable or does not belong to merchant ${business.name}.`
        );
      }
      orderItems.push({
        productId: product.id,
        sku: product.sku,
        name: product.name,
        quantity: reqItem.quantity,
        unitPrice: product.unitPrice,
      });
      productSubtotal += product.unitPrice * reqItem.quantity;
    }

    productSubtotal = Math.round(productSubtotal * 100) / 100;
    const shippingTotal = Math.round((input.shippingTotal ?? 0) * 100) / 100;
    const taxRate = input.taxRate ?? 0;
    const taxTotal = Math.round(productSubtotal * taxRate * 100) / 100;
    const grandTotal = Math.round((productSubtotal + shippingTotal + taxTotal) * 100) / 100;

    const returnDeadlineAt = new Date();
    returnDeadlineAt.setDate(returnDeadlineAt.getDate() + business.policies.returnWindowDays);

    const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${crypto
      .randomBytes(2)
      .toString('hex')
      .toUpperCase()}`;

    const result = await this.runTx(async (session) => {
      const createdOrder = await this.orders.create(
        {
          orderNumber,
          merchantId: business.id,
          customerId: targetCustomerId,
          items: orderItems,
          shippingReference: input.shippingReference,
          allocatedPackages: [],
          totals: {
            productSubtotal,
            depositTotal: 0,
            shippingTotal,
            taxTotal,
            grandTotal,
          },
          currency: business.currency,
          status: 'PLACED',
          returnDeadlineAt,
        },
        session
      );

      if (!input.autoAllocate) {
        return { order: createdOrder };
      }

      const allocated = await this.executeAllocationInSession(
        createdOrder,
        business,
        productMap,
        caller,
        Boolean(input.allowSplit),
        session,
        meta
      );
      return { order: allocated.order, allocation: allocated.allocation };
    });

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'ORDER_CREATED',
      entityType: 'Order',
      entityId: result.order.id,
      businessId: business.id,
      afterSummary: {
        orderNumber: result.order.orderNumber,
        status: result.order.status,
        totals: result.order.totals,
        allocatedPackages: result.order.allocatedPackages.map((p) => p.packageId),
      },
      correlationId: meta?.correlationId,
    });

    return result;
  }

  async allocatePackage(
    orderId: string,
    options: { allowSplit?: boolean },
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<AllocateOrderResult> {
    return this.runTx(async (session) => {
      const order = await this.orders.findById(orderId, session);
      if (!order) throw notFound('Order not found.');

      this.assertOrderAccess(order, caller, true);

      // Idempotent guard: repeated allocation calls never reserve duplicate packages.
      if (order.allocatedPackages.length > 0) {
        return {
          order,
          alreadyAllocated: true,
          allocation: {
            outcome: (order.allocationMetadata?.outcome as AllocationResult['outcome']) ?? 'ALLOCATED',
            policyVersion: order.allocationMetadata?.policyVersion ?? 'v2.0-deterministic',
            selectedPackages: order.allocatedPackages.map((p) => ({
              packageRefId: p.packageRef,
              packageId: p.packageId,
              packageClass: p.packageClass as any,
              ownerType: p.ownerType as any,
              fulfilmentLocation: order.shippingReference.fulfilmentLocation,
              score: 0,
              deposit: {
                amount: p.depositAmount,
                currency: order.currency,
                breakdown: p.depositBreakdown ?? {
                  baseDeposit: p.depositAmount,
                  multiplier: 1,
                  replacementValue: p.depositAmount,
                  ruleVersion: 'v2.0-deterministic',
                },
              },
              assignedSkus: order.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
              explanation: p.explanation ?? 'Previously allocated package retained idempotently.',
            })),
            totalDeposit: order.totals.depositTotal,
            currency: order.currency,
            explanation: 'Order already has allocated reusable packaging.',
            rejections: [],
          },
        };
      }

      if (order.status === 'CANCELLED' || order.status === 'DISPATCHED' || order.status === 'DELIVERED') {
        throw conflict(
          `Order in status ${order.status} cannot be allocated packaging.`,
          'INVALID_ORDER_STATE'
        );
      }

      const business = await this.businesses.findById(order.merchantId, session);
      if (!business) throw notFound('Merchant business not found.');
      if (business.status !== 'ACTIVE') {
        throw forbidden(`Merchant business is ${business.status} and cannot allocate packaging.`);
      }

      const productIds = Array.from(new Set(order.items.map((i) => i.productId)));
      const foundProducts = await this.products.findByMerchantAndIds(
        order.merchantId,
        productIds,
        session
      );
      const productMap = new Map<string, ProductDto>(foundProducts.map((p) => [p.id, p]));

      return this.executeAllocationInSession(
        order,
        business,
        productMap,
        caller,
        Boolean(options.allowSplit),
        session,
        meta
      );
    });
  }

  private async executeAllocationInSession(
    order: OrderDto,
    business: Awaited<ReturnType<BusinessRepository['findById']>> & object,
    productMap: Map<string, ProductDto>,
    caller: AuthPrincipal,
    allowSplit: boolean,
    session: ClientSession | null,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<AllocateOrderResult> {
    const allocationItems: AllocationProductItem[] = order.items.map((item) => {
      const prod = productMap.get(item.productId);
      if (!prod) {
        throw badRequest(`Product SKU ${item.sku} no longer exists for measurement lookup.`);
      }
      return {
        sku: prod.sku,
        name: prod.name,
        quantity: item.quantity,
        dimensionsCm: prod.dimensionsCm,
        weightKg: prod.weightKg,
        rotatable: prod.rotatable,
        allowedOrientations: prod.allowedOrientations,
        fragility: prod.fragility,
        restrictions: prod.restrictions,
      };
    });

    const candidates = await this.packages.findCandidatesForAllocation(
      business.id,
      business.packagingModel !== 'MERCHANT_OWNED',
      business.allowCrossMerchantPool && business.packagingModel === 'SHARED_POOL',
      session
    );

    const allocation = evaluatePackagingAllocation({
      merchantId: business.id,
      packagingModel: business.packagingModel,
      allowCrossMerchantPool: business.allowCrossMerchantPool,
      fulfilmentLocation: order.shippingReference.fulfilmentLocation,
      currency: order.currency,
      depositMultiplier: business.policies.depositMultiplier,
      allowSplit,
      items: allocationItems,
      candidates,
    });

    if (allocation.outcome !== 'ALLOCATED' && allocation.outcome !== 'ALLOCATED_SPLIT') {
      const statusCode = allocation.outcome === 'SPLIT_RECOMMENDED' ? 409 : 422;
      throw new AppError(statusCode, allocation.outcome, allocation.explanation, {
        outcome: allocation.outcome,
        recommendedSplitGroups: allocation.recommendedSplitGroups,
        rejections: allocation.rejections.slice(0, 10),
      });
    }

    const reserved = await this.packages.reservePackagesAtomically(
      allocation.selectedPackages.map((sel) => ({
        packageRefId: sel.packageRefId,
        packageId: sel.packageId,
        orderId: order.id,
        merchantId: business.id,
        merchantCustodianLabel: `${business.name} Fulfilment (${order.shippingReference.fulfilmentLocation})`,
        actor: { userId: caller.userId, role: caller.role },
        correlationId: meta?.correlationId ?? order.id,
      })),
      session
    );

    if (!reserved) {
      throw conflict(
        'Selected package became unavailable during reservation. Please retry allocation.',
        'ALLOCATION_CONFLICT'
      );
    }

    const allocatedPackages: OrderAllocatedPackageDto[] = allocation.selectedPackages.map((sel) => ({
      packageRef: sel.packageRefId,
      packageId: sel.packageId,
      packageClass: sel.packageClass,
      ownerType: sel.ownerType,
      depositAmount: sel.deposit.amount,
      depositBreakdown: sel.deposit.breakdown,
      explanation: sel.explanation,
      explanationSource: 'TEMPLATE',
    }));

    const depositTotal = allocation.totalDeposit;
    const grandTotal =
      Math.round(
        (order.totals.productSubtotal +
          order.totals.shippingTotal +
          order.totals.taxTotal +
          depositTotal) *
          100
      ) / 100;

    const nextStatus: OrderStatus = order.status === 'PLACED' ? 'ALLOCATED' : order.status;

    const updatedOrder = await this.orders.applyAllocationAtomically(
      order.id,
      {
        allocatedPackages,
        allocationMetadata: {
          outcome: allocation.outcome,
          policyVersion: allocation.policyVersion,
          allocatedAt: new Date(),
          splitRecommended: allocation.outcome === 'ALLOCATED_SPLIT',
          notes: allocation.explanation,
        },
        depositTotal,
        grandTotal,
        status: nextStatus,
      },
      session
    );

    if (!updatedOrder) {
      throw conflict('Order was concurrently allocated by another request.', 'ALLOCATION_CONFLICT');
    }

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'ORDER_PACKAGE_ALLOCATED',
      entityType: 'Order',
      entityId: updatedOrder.id,
      businessId: business.id,
      afterSummary: {
        outcome: allocation.outcome,
        packages: allocatedPackages.map((p) => p.packageId),
        depositTotal,
        grandTotal,
      },
      correlationId: meta?.correlationId,
    });

    return {
      order: updatedOrder,
      allocation,
      alreadyAllocated: false,
    };
  }

  private assertOrderAccess(order: OrderDto, caller: AuthPrincipal, isWriteAllocation = false): void {
    if (caller.role === 'ADMIN') return;
    if (caller.role === 'CUSTOMER') {
      if (order.customerId !== caller.userId) {
        throw forbidden('Customers may only access their own orders.');
      }
      return;
    }
    if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      if (order.merchantId !== caller.businessId) {
        throw forbidden('Cross-tenant access to another merchant order is prohibited.');
      }
      return;
    }
    if (isWriteAllocation) {
      throw forbidden('You are not authorized to allocate packaging for this order.');
    }
    throw forbidden('You are not authorized to view this order.');
  }

  async getOrderById(orderId: string, caller: AuthPrincipal): Promise<OrderDto> {
    const order = await this.orders.findById(orderId);
    if (!order) throw notFound('Order not found.');
    this.assertOrderAccess(order, caller);
    return order;
  }

  async listOrders(
    params: {
      merchantId?: string;
      status?: OrderStatus;
      search?: string;
      page: number;
      pageSize: number;
      sortBy?: string;
      sortDir?: 'asc' | 'desc';
    },
    caller: AuthPrincipal
  ): Promise<PaginatedResult<OrderDto>> {
    if (caller.role === 'ADMIN') {
      return this.orders.list(params);
    }

    if (caller.role === 'CUSTOMER') {
      return this.orders.list({
        ...params,
        merchantId: undefined,
        customerId: caller.userId,
      });
    }

    if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      const scopedMerchantId = resolveMerchantScope(caller, params.merchantId);
      return this.orders.list({
        ...params,
        merchantId: scopedMerchantId,
      });
    }

    throw forbidden('Order listing is restricted to customers, merchants, and admins.');
  }
}

