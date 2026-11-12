import { API_BASE_URL, apiRequest, getStoredToken } from './client';
import {
  InspectionCondition,
  PaginatedResponse,
  RefundDto,
  ReturnDto,
  ReturnMode,
} from '../types/domain';

export function initiateReturn(payload: {
  orderId: string;
  packageId: string;
  mode: ReturnMode;
  reason?: string;
  dropoffLocationLabel?: string;
  pickupWindowStart?: string;
  pickupWindowEnd?: string;
  serviceZone?: string;
  addressSummary?: string;
  swapOrderNumber?: string;
}) {
  return apiRequest<{ returnRecord: ReturnDto }>('/api/returns', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function listReturns(
  params: { status?: string; merchantId?: string; page?: number; pageSize?: number } = {}
) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.merchantId) q.set('merchantId', params.merchantId);
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  const qs = q.toString() ? `?${q.toString()}` : '';
  return apiRequest<PaginatedResponse<ReturnDto>>(`/api/returns${qs}`);
}

export function getReturnDetail(returnId: string) {
  return apiRequest<{ returnRecord: ReturnDto }>(`/api/returns/${encodeURIComponent(returnId)}`);
}

export function getReturnRefund(returnId: string) {
  return apiRequest<{ refund: RefundDto | null }>(
    `/api/returns/${encodeURIComponent(returnId)}/refund`
  );
}

export function assignReturnPartner(returnId: string, partnerUserId: string) {
  return apiRequest<{ returnRecord: ReturnDto }>(
    `/api/returns/${encodeURIComponent(returnId)}/assign-partner`,
    {
      method: 'POST',
      body: JSON.stringify({ partnerUserId }),
    }
  );
}

export function collectReturn(
  returnId: string,
  payload: {
    scanMode: 'QR_TOKEN' | 'MANUAL_SUPERVISED';
    qrToken?: string;
    scanId?: string;
    locationRef?: string;
    manualReason?: string;
  }
) {
  return apiRequest<{ returnRecord: ReturnDto }>(
    `/api/returns/${encodeURIComponent(returnId)}/collect`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export function receiveReturnAtCentre(
  returnId: string,
  payload: {
    scanMode: 'QR_TOKEN' | 'MANUAL_SUPERVISED';
    qrToken?: string;
    scanId?: string;
    locationRef?: string;
    manualReason?: string;
  }
) {
  return apiRequest<{ returnRecord: ReturnDto }>(
    `/api/returns/${encodeURIComponent(returnId)}/receive`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export function uploadReturnEvidence(
  returnId: string,
  payload: { filename: string; mimeType: string; contentBase64: string }
) {
  return apiRequest<{ returnRecord: ReturnDto }>(
    `/api/returns/${encodeURIComponent(returnId)}/evidence`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export async function fetchAuthorizedEvidenceBlobUrl(
  returnId: string,
  fileId: string
): Promise<string> {
  const token = getStoredToken();
  const res = await fetch(
    `${API_BASE_URL}/api/returns/${encodeURIComponent(returnId)}/evidence/${encodeURIComponent(fileId)}`,
    {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }
  );
  if (!res.ok) {
    throw new Error('Could not load private evidence file.');
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function inspectReturn(
  returnId: string,
  payload: {
    condition: InspectionCondition;
    checklist: {
      identityVerified: boolean;
      structuralIntegrity: boolean;
      cleanlinessAcceptable: boolean;
      completeComponents: boolean;
    };
    damageReason?: string;
    notes?: string;
    disputed?: boolean;
    disputeReason?: string;
  }
) {
  return apiRequest<{ returnRecord: ReturnDto }>(
    `/api/returns/${encodeURIComponent(returnId)}/inspect`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export function approveReturnRefund(returnId: string, reason?: string) {
  const idempotencyKey = `ui-refund-${returnId}-${Date.now()}`;
  return apiRequest<{
    returnRecord: ReturnDto;
    refund: RefundDto | null;
    pending: boolean;
    alreadyRefunded: boolean;
    zeroRefundApproved: boolean;
    message: string;
  }>(`/api/returns/${encodeURIComponent(returnId)}/approve`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ ...(reason ? { reason } : {}) }),
  });
}

export function rejectReturn(returnId: string, reason: string) {
  return apiRequest<{ returnRecord: ReturnDto }>(
    `/api/returns/${encodeURIComponent(returnId)}/reject`,
    {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }
  );
}

export function reconcileReturnRefund(returnId: string) {
  return apiRequest<{
    returnRecord: ReturnDto;
    refund: RefundDto | null;
    pending: boolean;
    alreadyRefunded: boolean;
    message: string;
  }>(`/api/returns/${encodeURIComponent(returnId)}/reconcile-refund`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

