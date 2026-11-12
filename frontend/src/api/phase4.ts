import { apiRequest } from './client';
import {
  DeliveryPartnerSummary,
  DigitalPassportView,
  PackageDto,
  PaginatedResponse,
  QrLabelData,
  ScanAction,
} from '../types/domain';

export function getPackagePassport(packageId: string) {
  return apiRequest<{ passport: DigitalPassportView }>(
    `/api/packages/${encodeURIComponent(packageId.trim().toUpperCase())}/passport`
  );
}

export function scanPackage(
  packageId: string,
  payload: {
    action: ScanAction;
    scanMode: 'QR_TOKEN' | 'MANUAL_SUPERVISED';
    qrToken?: string;
    scanId?: string;
    assignedPartnerUserId?: string;
    locationRef?: string;
    notes?: string;
    manualReason?: string;
  }
) {
  return apiRequest<{
    package: PackageDto;
    orderUpdated: boolean;
    scanMode: 'QR_TOKEN' | 'MANUAL_SUPERVISED';
    verifiedKeyId?: string;
    passport: DigitalPassportView;
  }>(`/api/packages/${encodeURIComponent(packageId.trim().toUpperCase())}/scan`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function assignDeliveryPartner(packageId: string, partnerUserId: string) {
  return apiRequest<{ package: PackageDto; partner: DeliveryPartnerSummary }>(
    `/api/packages/${encodeURIComponent(packageId.trim().toUpperCase())}/assign-partner`,
    {
      method: 'POST',
      body: JSON.stringify({ partnerUserId }),
    }
  );
}

export function reprintQrLabel(packageId: string, reason: string) {
  return apiRequest<{
    package: PackageDto;
    qrPayload: { packageId: string; token: string; tokenVersion: number; expiresAt: string };
    label: QrLabelData;
  }>(`/api/packages/${encodeURIComponent(packageId.trim().toUpperCase())}/qr/reprint`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function revokeQrToken(packageId: string, reason: string) {
  return apiRequest<{ package: PackageDto }>(
    `/api/packages/${encodeURIComponent(packageId.trim().toUpperCase())}/qr/revoke`,
    {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }
  );
}

export function listDeliveryPartners() {
  return apiRequest<{ partners: DeliveryPartnerSummary[] }>('/api/packages/partners');
}

export function listMyAssignedPackages(params: { status?: string; page?: number; pageSize?: number } = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  const qs = q.toString() ? `?${q.toString()}` : '';
  return apiRequest<PaginatedResponse<PackageDto>>(`/api/packages/assigned/me${qs}`);
}

/**
 * Extracts packageId hint from RBXQR:v1.<kid>.<b64urlPayload>.<hmac> purely to pre-fill UI form fields;
 * backend verifies full HMAC signature and payload match on every request.
 */
export function extractPackageIdFromQrInput(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('RBXQR:')) {
    if (/^RBX-[A-Z0-9-]{4,30}$/i.test(trimmed)) {
      return trimmed.toUpperCase();
    }
    return null;
  }
  const parts = trimmed.slice('RBXQR:'.length).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const b64 = parts[2].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const decoded = JSON.parse(atob(padded)) as { pkg?: unknown };
    if (typeof decoded.pkg === 'string' && decoded.pkg.trim()) {
      return decoded.pkg.trim().toUpperCase();
    }
    return null;
  } catch {
    return null;
  }
}

