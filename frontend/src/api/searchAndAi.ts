import { apiRequest } from './client';
import {
  InspectionAssistResponse,
  InspectionCondition,
  OperationalInsightsResponse,
  PackageClass,
  PackageOwnerType,
  ReturnMode,
  SearchPaginatedResponse,
  SearchStatusSnapshot,
} from '../types/domain';

export type SearchEntity = 'orders' | 'packages' | 'inventory' | 'returns' | 'transactions';

export function searchOperationalEntity<T>(
  entity: SearchEntity,
  params: {
    q?: string;
    merchantId?: string;
    status?: string;
    mode?: ReturnMode;
    condition?: InspectionCondition | string;
    packageClass?: PackageClass;
    ownerType?: PackageOwnerType;
    refundStatus?: string;
    page?: number;
    pageSize?: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  }
): Promise<SearchPaginatedResponse<T>> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.merchantId) qs.set('merchantId', params.merchantId);
  if (params.status) qs.set('status', params.status);
  if (params.mode) qs.set('mode', params.mode);
  if (params.condition) qs.set('condition', params.condition);
  if (params.packageClass) qs.set('packageClass', params.packageClass);
  if (params.ownerType) qs.set('ownerType', params.ownerType);
  if (params.refundStatus) qs.set('refundStatus', params.refundStatus);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  if (params.sortBy) qs.set('sortBy', params.sortBy);
  if (params.sortDir) qs.set('sortDir', params.sortDir);
  const query = qs.toString() ? `?${qs.toString()}` : '';
  return apiRequest<SearchPaginatedResponse<T>>(`/api/search/${entity}${query}`);
}

export function getSearchStatus(): Promise<SearchStatusSnapshot> {
  return apiRequest<SearchStatusSnapshot>('/api/search/status');
}

export function triggerSearchReindex(payload: {
  entities?: Array<'orders' | 'packages' | 'returns' | 'transactions'>;
  merchantId?: string;
  batchSize?: number;
  resumeJobId?: string;
}) {
  return apiRequest<{
    reindex: {
      jobId: string;
      status: string;
      processedCounts: Record<string, number>;
      failedCount: number;
      lastError?: string;
    };
  }>('/api/search/reindex', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getAiStatus() {
  return apiRequest<{
    gemini: {
      configured: boolean;
      status: 'NOT_CONFIGURED' | 'CONFIGURED' | 'HEALTHY' | 'DEGRADED';
      model: string;
      message?: string;
      checkedAt: string;
    };
  }>('/api/ai/status');
}

export function askAiInsights(payload: {
  question: string;
  merchantId?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}) {
  return apiRequest<OperationalInsightsResponse>('/api/ai/insights/ask', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getAiSummary(payload: {
  focus?: 'REUSE' | 'RETURNS' | 'PICKUPS' | 'OVERVIEW';
  merchantId?: string;
}) {
  return apiRequest<OperationalInsightsResponse>('/api/ai/insights/summary', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function assistReturnInspection(returnId: string) {
  return apiRequest<InspectionAssistResponse>(
    `/api/ai/returns/${encodeURIComponent(returnId)}/inspect-assist`,
    { method: 'POST' }
  );
}

