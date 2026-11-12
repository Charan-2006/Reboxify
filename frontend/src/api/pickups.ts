import { apiRequest } from './client';
import {
  PaginatedResponse,
  PartnerScheduleDto,
  PickupDto,
  PickupResourcesResponse,
  PickupStatus,
  ReturnDto,
  ReturnMode,
} from '../types/domain';

export function listPickups(
  params: {
    merchantId?: string;
    status?: PickupStatus;
    serviceZone?: string;
    partnerId?: string;
    collectionCenterId?: string;
    from?: string;
    to?: string;
    search?: string;
    page?: number;
    pageSize?: number;
    sortBy?: 'slotStart' | 'status' | 'serviceZone' | 'createdAt' | 'updatedAt';
    sortDir?: 'asc' | 'desc';
  } = {}
) {
  const q = new URLSearchParams();
  if (params.merchantId) q.set('merchantId', params.merchantId);
  if (params.status) q.set('status', params.status);
  if (params.serviceZone) q.set('serviceZone', params.serviceZone);
  if (params.partnerId) q.set('partnerId', params.partnerId);
  if (params.collectionCenterId) q.set('collectionCenterId', params.collectionCenterId);
  if (params.from) q.set('from', params.from);
  if (params.to) q.set('to', params.to);
  if (params.search) q.set('search', params.search);
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  if (params.sortBy) q.set('sortBy', params.sortBy);
  if (params.sortDir) q.set('sortDir', params.sortDir);
  const qs = q.toString() ? `?${q.toString()}` : '';
  return apiRequest<PaginatedResponse<PickupDto>>(`/api/pickups${qs}`);
}

export function listPickupResources(
  params: {
    serviceZone?: string;
    date?: string;
    includeSlots?: boolean;
  } = {}
) {
  const q = new URLSearchParams();
  if (params.serviceZone) q.set('serviceZone', params.serviceZone);
  if (params.date) q.set('date', params.date);
  if (params.includeSlots) q.set('includeSlots', 'true');
  const qs = q.toString() ? `?${q.toString()}` : '';
  return apiRequest<PickupResourcesResponse>(`/api/pickups/resources${qs}`);
}

export function getPickupById(pickupId: string) {
  return apiRequest<{ pickup: PickupDto }>(`/api/pickups/${encodeURIComponent(pickupId)}`);
}

export function createPickup(payload: {
  returnId: string;
  collectionCenterId?: string;
  partnerId?: string;
  slotStart: string;
  slotEnd: string;
  timeZone?: string;
  pickupMethod?: ReturnMode;
  serviceZone: string;
  addressSummary: string;
  notes?: string;
}) {
  return apiRequest<{ pickup: PickupDto }>('/api/pickups', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updatePickup(
  pickupId: string,
  payload: {
    slotStart?: string;
    slotEnd?: string;
    timeZone?: string;
    partnerId?: string | null;
    collectionCenterId?: string | null;
    serviceZone?: string;
    addressSummary?: string;
    status?: PickupStatus;
    notes?: string;
    missedReason?: string;
    reason?: string;
    expectedVersion?: number;
  }
) {
  return apiRequest<{ pickup: PickupDto }>(`/api/pickups/${encodeURIComponent(pickupId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function assignPickup(
  pickupId: string,
  payload: {
    partnerId?: string;
    collectionCenterId?: string;
    notes?: string;
    expectedVersion?: number;
  }
) {
  return apiRequest<{ pickup: PickupDto }>(`/api/pickups/${encodeURIComponent(pickupId)}/assign`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function reschedulePickup(
  pickupId: string,
  payload: {
    slotStart: string;
    slotEnd: string;
    timeZone?: string;
    partnerId?: string | null;
    reason: string;
    expectedVersion?: number;
  }
) {
  return apiRequest<{ pickup: PickupDto }>(
    `/api/pickups/${encodeURIComponent(pickupId)}/reschedule`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export function cancelPickup(
  pickupId: string,
  payload: { reason: string; expectedVersion?: number }
) {
  return apiRequest<{ pickup: PickupDto }>(`/api/pickups/${encodeURIComponent(pickupId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function completePickup(
  pickupId: string,
  payload: {
    scanMode: 'QR_TOKEN' | 'MANUAL_SUPERVISED';
    qrToken?: string;
    scanId?: string;
    locationRef?: string;
    manualReason?: string;
  }
) {
  return apiRequest<{ pickup: PickupDto; returnRecord: ReturnDto }>(
    `/api/pickups/${encodeURIComponent(pickupId)}/complete`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export function updatePartnerSchedule(
  partnerId: string,
  payload: Partial<
    Pick<
      PartnerScheduleDto,
      | 'displayName'
      | 'serviceZones'
      | 'timeZone'
      | 'workingHours'
      | 'unavailablePeriods'
      | 'dailyCapacity'
      | 'maxConcurrentCapacity'
      | 'status'
    >
  >
) {
  return apiRequest<{ partner: PartnerScheduleDto }>(
    `/api/pickups/partners/${encodeURIComponent(partnerId)}/schedule`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }
  );
}

