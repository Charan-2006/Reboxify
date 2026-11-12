import { config } from '../config/env.js';

export type PayPalErrorCode =
  | 'PAYPAL_UNCONFIGURED'
  | 'PAYPAL_AUTH_FAILED'
  | 'PAYPAL_TIMEOUT'
  | 'PAYPAL_NETWORK_ERROR'
  | 'PAYPAL_API_ERROR';

export class PayPalClientError extends Error {
  constructor(
    public readonly code: PayPalErrorCode,
    message: string,
    public readonly httpStatus?: number,
    public readonly providerDebugId?: string,
    public readonly providerDetails?: unknown
  ) {
    super(message);
    this.name = 'PayPalClientError';
  }
}

export interface PayPalCreateOrderParams {
  internalOrderId: string;
  orderNumber: string;
  currency: string;
  productSubtotal: number;
  depositTotal: number;
  shippingTotal: number;
  taxTotal: number;
  grandTotal: number;
  requestId: string;
}

export interface PayPalOrderResponse {
  id: string;
  status: string;
  purchase_units?: Array<{
    reference_id?: string;
    payments?: {
      captures?: Array<{
        id: string;
        status: string;
        amount?: {
          currency_code: string;
          value: string;
        };
      }>;
      refunds?: Array<{
        id: string;
        status: string;
        invoice_id?: string;
        amount?: {
          currency_code: string;
          value: string;
        };
      }>;
    };
  }>;
}

export interface PayPalRefundParams {
  captureId: string;
  amount: number;
  currency: string;
  requestId: string;
  invoiceId?: string;
  noteToPayer?: string;
}

export interface PayPalRefundResponse {
  id: string;
  status: string;
  invoice_id?: string;
  amount?: {
    currency_code: string;
    value: string;
  };
  status_details?: {
    reason?: string;
  };
  links?: Array<{
    href: string;
    rel: string;
    method?: string;
  }>;
}

export interface PayPalWebhookVerifyParams {
  headers: {
    authAlgo: string;
    certUrl: string;
    transmissionId: string;
    transmissionSig: string;
    transmissionTime: string;
  };
  webhookId: string;
  webhookEvent: Record<string, unknown>;
}

export interface PayPalClient {
  isConfigured(): boolean;
  isWebhookConfigured?(): boolean;
  createOrder(params: PayPalCreateOrderParams): Promise<PayPalOrderResponse>;
  captureOrder(paypalOrderId: string, requestId: string): Promise<PayPalOrderResponse>;
  getOrder(paypalOrderId: string): Promise<PayPalOrderResponse>;
  refundCapture?(params: PayPalRefundParams): Promise<PayPalRefundResponse>;
  getRefund?(refundId: string): Promise<PayPalRefundResponse>;
  verifyWebhookSignature?(params: PayPalWebhookVerifyParams): Promise<boolean>;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export class RestPayPalClient implements PayPalClient {
  private cachedToken: CachedToken | null = null;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly clientId: string | undefined = config.paypalClientId,
    private readonly clientSecret: string | undefined = config.paypalClientSecret,
    env: 'sandbox' | 'live' = config.paypalEnv,
    timeoutMs = 15_000,
    private readonly webhookId: string | undefined = config.paypalWebhookId
  ) {
    this.baseUrl =
      env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    this.timeoutMs = timeoutMs;
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  isWebhookConfigured(): boolean {
    return Boolean(this.isConfigured() && this.webhookId);
  }

  private assertConfigured(): { clientId: string; clientSecret: string } {
    if (!this.clientId || !this.clientSecret) {
      throw new PayPalClientError(
        'PAYPAL_UNCONFIGURED',
        'PayPal Sandbox credentials (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET) are not configured.'
      );
    }
    return { clientId: this.clientId, clientSecret: this.clientSecret };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        throw new PayPalClientError(
          'PAYPAL_TIMEOUT',
          'Request to PayPal REST API timed out.'
        );
      }
      throw new PayPalClientError(
        'PAYPAL_NETWORK_ERROR',
        err instanceof Error ? err.message : 'Network error calling PayPal REST API.'
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async getAccessToken(): Promise<string> {
    const { clientId, clientSecret } = this.assertConfigured();
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAtMs - 30_000) {
      return this.cachedToken.accessToken;
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await this.fetchWithTimeout(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
    };

    if (!res.ok || !data.access_token) {
      throw new PayPalClientError(
        'PAYPAL_AUTH_FAILED',
        data.error_description || 'Failed to obtain PayPal OAuth access token.',
        res.status,
        res.headers.get('paypal-debug-id') ?? undefined
      );
    }

    const expiresInSec = data.expires_in ?? 300;
    this.cachedToken = {
      accessToken: data.access_token,
      expiresAtMs: Date.now() + expiresInSec * 1000,
    };
    return data.access_token;
  }

  private async requestJson<T>(
    path: string,
    options: { method: string; body?: unknown; requestId?: string }
  ): Promise<T> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (options.requestId) {
      headers['PayPal-Request-Id'] = options.requestId;
    }

    const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: options.method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new PayPalClientError(
        'PAYPAL_API_ERROR',
        (typeof data.message === 'string' && data.message) ||
          `PayPal API returned status ${res.status}.`,
        res.status,
        res.headers.get('paypal-debug-id') ?? undefined,
        data
      );
    }

    return data as T;
  }

  async createOrder(params: PayPalCreateOrderParams): Promise<PayPalOrderResponse> {
    const formatAmt = (n: number) => n.toFixed(2);
    const itemsAndDepositSum =
      Math.round((params.productSubtotal + params.depositTotal) * 100) / 100;

    return this.requestJson<PayPalOrderResponse>('/v2/checkout/orders', {
      method: 'POST',
      requestId: params.requestId,
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: params.internalOrderId,
            custom_id: params.orderNumber,
            description: `ReBoxify Order ${params.orderNumber} (includes refundable packaging deposit)`,
            amount: {
              currency_code: params.currency,
              value: formatAmt(params.grandTotal),
              breakdown: {
                item_total: {
                  currency_code: params.currency,
                  value: formatAmt(itemsAndDepositSum),
                },
                shipping: {
                  currency_code: params.currency,
                  value: formatAmt(params.shippingTotal),
                },
                tax_total: {
                  currency_code: params.currency,
                  value: formatAmt(params.taxTotal),
                },
              },
            },
          },
        ],
      },
    });
  }

  async captureOrder(paypalOrderId: string, requestId: string): Promise<PayPalOrderResponse> {
    return this.requestJson<PayPalOrderResponse>(
      `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
      {
        method: 'POST',
        requestId,
        body: {},
      }
    );
  }

  async getOrder(paypalOrderId: string): Promise<PayPalOrderResponse> {
    return this.requestJson<PayPalOrderResponse>(
      `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`,
      { method: 'GET' }
    );
  }

  async refundCapture(params: PayPalRefundParams): Promise<PayPalRefundResponse> {
    return this.requestJson<PayPalRefundResponse>(
      `/v2/payments/captures/${encodeURIComponent(params.captureId)}/refund`,
      {
        method: 'POST',
        requestId: params.requestId,
        body: {
          amount: {
            currency_code: params.currency.toUpperCase(),
            value: params.amount.toFixed(2),
          },
          ...(params.invoiceId ? { invoice_id: params.invoiceId } : {}),
          ...(params.noteToPayer ? { note_to_payer: params.noteToPayer } : {}),
        },
      }
    );
  }

  async getRefund(refundId: string): Promise<PayPalRefundResponse> {
    return this.requestJson<PayPalRefundResponse>(
      `/v2/payments/refunds/${encodeURIComponent(refundId)}`,
      { method: 'GET' }
    );
  }

  async verifyWebhookSignature(params: PayPalWebhookVerifyParams): Promise<boolean> {
    const resolvedWebhookId = params.webhookId || this.webhookId;
    if (!resolvedWebhookId) {
      throw new PayPalClientError(
        'PAYPAL_UNCONFIGURED',
        'PAYPAL_WEBHOOK_ID is required to verify PayPal webhook signatures.'
      );
    }
    const resp = await this.requestJson<{ verification_status?: string }>(
      '/v1/notifications/verify-webhook-signature',
      {
        method: 'POST',
        body: {
          auth_algo: params.headers.authAlgo,
          cert_url: params.headers.certUrl,
          transmission_id: params.headers.transmissionId,
          transmission_sig: params.headers.transmissionSig,
          transmission_time: params.headers.transmissionTime,
          webhook_id: resolvedWebhookId,
          webhook_event: params.webhookEvent,
        },
      }
    );
    return resp.verification_status === 'SUCCESS';
  }
}

