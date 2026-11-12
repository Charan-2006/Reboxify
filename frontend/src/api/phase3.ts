import { apiRequest } from './client';
import {
  PaginatedResponse,
  PayPalPublicConfig,
  TransactionDto,
} from '../types/domain';

export function getPayPalPublicConfig() {
  return apiRequest<PayPalPublicConfig>('/api/payments/config', { skipAuth: true });
}

export function createPayPalCheckoutOrder(orderId: string, idempotencyKey?: string) {
  return apiRequest<{
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
      returnDeadlineAt?: string;
    };
  }>('/api/payments/paypal/create-order', {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    body: JSON.stringify({ orderId }),
  });
}

export function capturePayPalCheckoutOrder(paypalOrderId: string, idempotencyKey?: string) {
  return apiRequest<{
    transaction: TransactionDto;
    orderStatus: string;
    alreadyCaptured: boolean;
    pending: boolean;
    message: string;
  }>(`/api/payments/paypal/capture/${encodeURIComponent(paypalOrderId)}`, {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    body: JSON.stringify({}),
  });
}

export function cancelPayPalCheckoutOrder(paypalOrderId: string) {
  return apiRequest<{ transaction: TransactionDto; orderStatus: string }>(
    `/api/payments/paypal/cancel/${encodeURIComponent(paypalOrderId)}`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    }
  );
}

export function getPaymentById(idOrOrderId: string) {
  return apiRequest<{ transaction: TransactionDto }>(
    `/api/payments/${encodeURIComponent(idOrOrderId)}`
  );
}

export function listTransactions(
  params: {
    merchantId?: string;
    state?: string;
    search?: string;
    page?: number;
    pageSize?: number;
    sortBy?: 'amount' | 'state' | 'createdAt' | 'updatedAt';
    sortDir?: 'asc' | 'desc';
  } = {}
) {
  const q = new URLSearchParams();
  if (params.merchantId) q.set('merchantId', params.merchantId);
  if (params.state) q.set('state', params.state);
  if (params.search) q.set('search', params.search);
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  if (params.sortBy) q.set('sortBy', params.sortBy);
  if (params.sortDir) q.set('sortDir', params.sortDir);
  const qs = q.toString() ? `?${q.toString()}` : '';
  return apiRequest<PaginatedResponse<TransactionDto>>(`/api/transactions${qs}`);
}

