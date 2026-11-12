import { apiRequest } from './client';
import {
  BusinessDto,
  OrderDto,
  OwnershipModel,
  PackageCatalogueSpec,
  PackageClass,
  PackageDto,
  PackageOwnerType,
  PaginatedResponse,
  ProductDto,
  QrLabelData,
} from '../types/domain';

export function listBusinesses(params: { status?: string; page?: number; pageSize?: number } = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  const qs = q.toString() ? `?${q.toString()}` : '';
  return apiRequest<PaginatedResponse<BusinessDto>>(`/api/businesses${qs}`);
}

export function createBusiness(payload: {
  name: string;
  legalName: string;
  slug: string;
  ownerUserId?: string;
  currency?: string;
  packagingModel?: OwnershipModel;
  allowCrossMerchantPool?: boolean;
  policies?: {
    returnWindowDays?: number;
    depositMultiplier?: number;
  };
}) {
  return apiRequest<{ business: BusinessDto }>('/api/businesses', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateBusinessStatus(
  businessId: string,
  status: 'ACTIVE' | 'ONBOARDING' | 'SUSPENDED'
) {
  return apiRequest<{ business: BusinessDto }>(`/api/businesses/${businessId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function updateBusinessPolicies(
  businessId: string,
  payload: {
    packagingModel?: OwnershipModel;
    allowCrossMerchantPool?: boolean;
    currency?: string;
    policies?: {
      returnWindowDays?: number;
      depositMultiplier?: number;
    };
  }
) {
  return apiRequest<{ business: BusinessDto }>(`/api/businesses/${businessId}/policies`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function listProducts(params: { merchantId?: string; search?: string; page?: number } = {}) {
  const q = new URLSearchParams();
  if (params.merchantId) q.set('merchantId', params.merchantId);
  if (params.search) q.set('search', params.search);
  if (params.page) q.set('page', String(params.page));
  const qs = q.toString() ? `?${q.toString()}` : '';
  return apiRequest<PaginatedResponse<ProductDto>>(`/api/products${qs}`);
}

export function upsertProduct(payload: {
  merchantId?: string;
  sku: string;
  name: string;
  dimensionsCm: { length: number; width: number; height: number };
  weightKg: number;
  rotatable: boolean;
  fragility: 'LOW' | 'MEDIUM' | 'HIGH';
  restrictions?: { liquidContainment?: boolean };
  unitPrice: number;
  currency?: string;
}) {
  return apiRequest<{ product: ProductDto }>('/api/products', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getPackageCatalogue(currency?: string) {
  const qs = currency ? `?currency=${encodeURIComponent(currency)}` : '';
  return apiRequest<{ classes: PackageCatalogueSpec[] }>(`/api/inventory/catalogue${qs}`);
}

export function listInventory(
  params: { status?: string; packageClass?: PackageClass; ownerType?: PackageOwnerType; page?: number; pageSize?: number } = {}
) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.packageClass) q.set('packageClass', params.packageClass);
  if (params.ownerType) q.set('ownerType', params.ownerType);
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  const qs = q.toString() ? `?${q.toString()}` : '';
  return apiRequest<PaginatedResponse<PackageDto>>(`/api/inventory${qs}`);
}

export function registerPackage(payload: {
  packageId?: string;
  ownerType: PackageOwnerType;
  ownerId?: string;
  packageClass: PackageClass;
  fulfilmentLocation: string;
  currency?: string;
}) {
  return apiRequest<{
    package: PackageDto;
    qrPayload: { packageId: string; token: string; tokenVersion: number; expiresAt: string };
    label: QrLabelData;
  }>('/api/inventory', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function listOrders(params: { status?: string; page?: number; pageSize?: number } = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  const qs = q.toString() ? `?${q.toString()}` : '';
  return apiRequest<PaginatedResponse<OrderDto>>(`/api/orders${qs}`);
}

export function createOrder(
  payload: {
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
    autoAllocate?: boolean;
    allowSplit?: boolean;
  },
  idempotencyKey?: string
) {
  return apiRequest<{ order: OrderDto }>('/api/orders', {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    body: JSON.stringify(payload),
  });
}

export function allocateOrderPackage(orderId: string, allowSplit = false) {
  return apiRequest<{ order: OrderDto; alreadyAllocated: boolean }>(
    `/api/orders/${orderId}/allocate-package`,
    {
      method: 'POST',
      body: JSON.stringify({ allowSplit }),
    }
  );
}

