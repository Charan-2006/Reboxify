import { GoogleGenAI } from '@google/genai';
import { config } from '../config/env.js';

export type GeminiHealthState = 'NOT_CONFIGURED' | 'CONFIGURED' | 'HEALTHY' | 'DEGRADED';

export interface GeminiHealthReport {
  configured: boolean;
  status: GeminiHealthState;
  model: string;
  message?: string;
  checkedAt: string;
}

export class GeminiClientError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'GeminiClientError';
  }
}

export interface GeminiModelClient {
  isConfigured(): boolean;
  getModelName(): string;
  checkHealth(forceProbe?: boolean): Promise<GeminiHealthReport>;
  generateJson(params: {
    systemInstruction: string;
    userPrompt: string;
    timeoutMs?: number;
  }): Promise<string>;
}

function sanitizeGeminiError(err: unknown): string {
  const msg = err instanceof Error ? err.message : 'Gemini API call failed';
  return msg.replace(/AIza[0-9A-Za-z_-]{10,}/g, '[REDACTED_KEY]').slice(0, 220);
}

export class OfficialGeminiClient implements GeminiModelClient {
  private readonly sdk: GoogleGenAI | null;
  private readonly model: string;
  private readonly configured: boolean;
  private cachedHealth: { report: GeminiHealthReport; expiresAt: number } | null = null;

  constructor(options?: { apiKey?: string; model?: string }) {
    const key = (options?.apiKey ?? config.geminiApiKey)?.trim();
    this.model = (options?.model ?? config.geminiModel).trim() || 'gemini-2.5-flash';
    this.configured = Boolean(key);
    this.sdk = key ? new GoogleGenAI({ apiKey: key }) : null;
  }

  isConfigured(): boolean {
    return this.configured && this.sdk !== null;
  }

  getModelName(): string {
    return this.model;
  }

  async checkHealth(forceProbe = false): Promise<GeminiHealthReport> {
    if (!this.sdk) {
      return {
        configured: false,
        status: 'NOT_CONFIGURED',
        model: this.model,
        checkedAt: new Date().toISOString(),
      };
    }

    const now = Date.now();
    if (!forceProbe && this.cachedHealth && now < this.cachedHealth.expiresAt) {
      return this.cachedHealth.report;
    }

    try {
      const probePromise = this.sdk.models.get({ model: this.model });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Gemini model probe timed out')), 3500)
      );
      await Promise.race([probePromise, timeoutPromise]);

      const report: GeminiHealthReport = {
        configured: true,
        status: 'HEALTHY',
        model: this.model,
        checkedAt: new Date().toISOString(),
      };
      this.cachedHealth = { report, expiresAt: now + 60_000 };
      return report;
    } catch (err) {
      const report: GeminiHealthReport = {
        configured: true,
        status: 'DEGRADED',
        model: this.model,
        message: sanitizeGeminiError(err),
        checkedAt: new Date().toISOString(),
      };
      this.cachedHealth = { report, expiresAt: now + 20_000 };
      return report;
    }
  }

  async generateJson(params: {
    systemInstruction: string;
    userPrompt: string;
    timeoutMs?: number;
  }): Promise<string> {
    if (!this.sdk) {
      throw new GeminiClientError(503, 'AI_NOT_CONFIGURED', 'Gemini API is not configured.');
    }

    const timeoutMs = params.timeoutMs ?? 12_000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new GeminiClientError(504, 'AI_TIMEOUT', 'Gemini request timed out.', true)),
        timeoutMs
      )
    );

    try {
      const response = await Promise.race([
        this.sdk.models.generateContent({
          model: this.model,
          contents: params.userPrompt,
          config: {
            systemInstruction: params.systemInstruction,
            responseMimeType: 'application/json',
            temperature: 0.2,
            maxOutputTokens: 1024,
          },
        }),
        timeoutPromise,
      ]);

      const text = response?.text?.trim();
      if (!text) {
        throw new GeminiClientError(
          502,
          'AI_INVALID_RESPONSE',
          'Gemini returned an empty response.'
        );
      }
      return text;
    } catch (err) {
      if (err instanceof GeminiClientError) {
        throw err;
      }
      const status = Number((err as { status?: number; statusCode?: number })?.status ??
        (err as { statusCode?: number })?.statusCode ??
        502);
      const safeMsg = sanitizeGeminiError(err);
      if (status === 429 || /rate limit|quota|resource exhausted/i.test(safeMsg)) {
        throw new GeminiClientError(
          429,
          'AI_RATE_LIMITED',
          'Gemini API rate limit exceeded. Please retry shortly.',
          true
        );
      }
      if (status === 408 || /timeout|timed out|abort/i.test(safeMsg)) {
        throw new GeminiClientError(504, 'AI_TIMEOUT', 'Gemini API request timed out.', true);
      }
      throw new GeminiClientError(502, 'AI_PROVIDER_ERROR', safeMsg, status >= 500);
    }
  }
}

export const defaultGeminiClient = new OfficialGeminiClient();

