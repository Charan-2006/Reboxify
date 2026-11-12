import { HealthResponse } from '../types/domain';

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000').replace(/\/+$/, '');
const SESSION_STORAGE_KEY = 'reboxify_auth_session';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly correlationId?: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getStoredToken(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: string | null };
    return parsed.token ?? null;
  } catch {
    return null;
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { skipAuth?: boolean } = {}
): Promise<T> {
  const { skipAuth, headers, ...rest } = options;
  const token = skipAuth ? null : getStoredToken();

  const mergedHeaders = new Headers(headers);
  if (!mergedHeaders.has('Content-Type') && rest.body) {
    mergedHeaders.set('Content-Type', 'application/json');
  }
  if (token) {
    mergedHeaders.set('Authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...rest,
      headers: mergedHeaders,
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      `Unable to reach ReBoxify API at ${API_BASE_URL}. Ensure the backend server is running.`
    );
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errObj = data?.error;
    throw new ApiError(
      response.status,
      errObj?.code || 'API_ERROR',
      errObj?.message || `Request failed with status ${response.status}.`,
      errObj?.correlationId,
      errObj?.details
    );
  }

  return data as T;
}

export function fetchSystemHealth(): Promise<HealthResponse> {
  return apiRequest<HealthResponse>('/api/health', { skipAuth: true });
}

