import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { PackageDto } from '../repositories/phase2Repositories.js';

export interface QrKeyEntry {
  keyId: string;
  secret: string;
}

export interface QrServiceOptions {
  currentKeyId?: string;
  currentSecret?: string;
  previousKeys?: QrKeyEntry[];
  defaultTtlSeconds?: number;
}

export interface QrTokenPayload {
  v: 1;
  pkg: string;
  ver: number;
  n: string;
  iat: number;
  exp: number;
}

export interface IssuedQrToken {
  packageId: string;
  token: string;
  tokenHash: string;
  tokenVersion: number;
  keyId: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface QrLabelData {
  packageId: string;
  packageClass: PackageDto['packageClass'];
  dimensionsCm: PackageDto['dimensionsCm'];
  maxWeightKg: number;
  protectionCategory: PackageDto['protectionCategory'];
  supportsLiquidContainment: boolean;
  material: string;
  ownerType: PackageDto['ownerType'];
  fulfilmentLocation: string;
  tokenVersion: number;
  qrToken: string;
  issuedAt: string;
  expiresAt: string;
  handlingInstructions: string[];
}

export type QrVerificationErrorCode =
  | 'INVALID_QR_FORMAT'
  | 'UNKNOWN_KEY_ID'
  | 'INVALID_QR_SIGNATURE'
  | 'INVALID_QR_PAYLOAD'
  | 'QR_PACKAGE_MISMATCH'
  | 'QR_REVOKED'
  | 'QR_TOKEN_SUPERSEDED'
  | 'QR_TOKEN_MISMATCH'
  | 'QR_TOKEN_EXPIRED';

export interface QrVerificationResult {
  valid: boolean;
  code?: QrVerificationErrorCode;
  reason?: string;
  keyId?: string;
  payload?: QrTokenPayload;
  tokenHash?: string;
}

const TOKEN_PREFIX = 'RBXQR:';

export class QrService {
  private readonly currentKeyId: string;
  private readonly currentSecret: string;
  private readonly keysById = new Map<string, string>();
  private readonly defaultTtlSeconds: number;

  constructor(options: QrServiceOptions = {}) {
    this.currentKeyId = (options.currentKeyId ?? config.qrKeyId).trim();
    this.currentSecret = (options.currentSecret ?? config.qrSigningSecret).trim();
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? config.qrTokenTtlSeconds;

    if (!this.currentKeyId || !this.currentSecret) {
      throw new Error('QrService requires a non-empty signing key ID and secret.');
    }

    this.keysById.set(this.currentKeyId, this.currentSecret);

    const configuredPrev =
      options.previousKeys ??
      (config.qrPreviousKeyId && config.qrPreviousSigningSecret
        ? [{ keyId: config.qrPreviousKeyId, secret: config.qrPreviousSigningSecret }]
        : []);

    for (const prev of configuredPrev) {
      if (prev.keyId && prev.secret) {
        this.keysById.set(prev.keyId.trim(), prev.secret.trim());
      }
    }
  }

  hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  /**
   * Parses RBXQR:v1.<kid>.<payloadB64Url>.<hmacB64Url> or raw URL-encoded query wrapper
   * without throwing, returning only verified structural parts.
   */
  extractPackageIdHint(rawInput: string): string | null {
    const trimmed = rawInput.trim();
    if (!trimmed.startsWith(TOKEN_PREFIX)) {
      return null;
    }
    const body = trimmed.slice(TOKEN_PREFIX.length);
    const parts = body.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      return null;
    }
    try {
      const jsonStr = Buffer.from(parts[2], 'base64url').toString('utf8');
      const parsed = JSON.parse(jsonStr) as Partial<QrTokenPayload>;
      if (typeof parsed.pkg === 'string' && parsed.pkg.trim().length > 0) {
        return parsed.pkg.trim().toUpperCase();
      }
      return null;
    } catch {
      return null;
    }
  }

  issuePackageToken(
    packageId: string,
    tokenVersion = 1,
    options?: { ttlSeconds?: number; nowMs?: number }
  ): IssuedQrToken {
    const normalizedPkg = packageId.trim().toUpperCase();
    const nowMs = options?.nowMs ?? Date.now();
    const ttlSeconds = options?.ttlSeconds ?? this.defaultTtlSeconds;
    const iat = Math.floor(nowMs / 1000);
    const exp = iat + Math.max(1, ttlSeconds);
    const nonce = crypto.randomBytes(12).toString('base64url');

    const payload: QrTokenPayload = {
      v: 1,
      pkg: normalizedPkg,
      ver: tokenVersion,
      n: nonce,
      iat,
      exp,
    };

    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signingInput = `v1.${this.currentKeyId}.${payloadB64}`;
    const hmacB64 = crypto
      .createHmac('sha256', this.currentSecret)
      .update(signingInput)
      .digest('base64url');

    const token = `${TOKEN_PREFIX}${signingInput}.${hmacB64}`;
    return {
      packageId: normalizedPkg,
      token,
      tokenHash: this.hashToken(token),
      tokenVersion,
      keyId: this.currentKeyId,
      nonce,
      issuedAt: new Date(iat * 1000),
      expiresAt: new Date(exp * 1000),
    };
  }

  verifyPackageToken(
    rawToken: string,
    pkg: Pick<PackageDto, 'packageId' | 'qrTokenHash' | 'qrTokenVersion' | 'qrRevoked'>,
    nowMs: number = Date.now()
  ): QrVerificationResult {
    const trimmed = rawToken.trim();
    if (!trimmed.startsWith(TOKEN_PREFIX)) {
      return {
        valid: false,
        code: 'INVALID_QR_FORMAT',
        reason: 'QR payload does not match ReBoxify signed token format.',
      };
    }

    const parts = trimmed.slice(TOKEN_PREFIX.length).split('.');
    if (parts.length !== 4 || parts[0] !== 'v1' || !parts[1] || !parts[2] || !parts[3]) {
      return {
        valid: false,
        code: 'INVALID_QR_FORMAT',
        reason: 'Malformed signed QR token structure.',
      };
    }

    const [versionTag, keyId, payloadB64, providedSigB64] = parts;
    const keySecret = this.keysById.get(keyId);
    if (!keySecret) {
      return {
        valid: false,
        code: 'UNKNOWN_KEY_ID',
        reason: `QR signing key "${keyId}" is not recognized or has been retired.`,
      };
    }

    const signingInput = `${versionTag}.${keyId}.${payloadB64}`;
    const expectedSigBuf = crypto
      .createHmac('sha256', keySecret)
      .update(signingInput)
      .digest();

    let providedSigBuf: Buffer;
    try {
      providedSigBuf = Buffer.from(providedSigB64, 'base64url');
    } catch {
      return {
        valid: false,
        code: 'INVALID_QR_SIGNATURE',
        reason: 'Invalid QR HMAC encoding.',
      };
    }

    if (
      providedSigBuf.length !== expectedSigBuf.length ||
      !crypto.timingSafeEqual(providedSigBuf, expectedSigBuf)
    ) {
      return {
        valid: false,
        code: 'INVALID_QR_SIGNATURE',
        reason: 'QR HMAC signature check failed.',
      };
    }

    let payload: QrTokenPayload;
    try {
      const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      if (
        !parsed ||
        parsed.v !== 1 ||
        typeof parsed.pkg !== 'string' ||
        typeof parsed.ver !== 'number' ||
        typeof parsed.n !== 'string' ||
        typeof parsed.iat !== 'number' ||
        typeof parsed.exp !== 'number'
      ) {
        return {
          valid: false,
          code: 'INVALID_QR_PAYLOAD',
          reason: 'Signed QR payload is missing required claims.',
        };
      }
      payload = parsed;
    } catch {
      return {
        valid: false,
        code: 'INVALID_QR_PAYLOAD',
        reason: 'Signed QR payload could not be parsed.',
      };
    }

    if (payload.pkg.toUpperCase() !== pkg.packageId.toUpperCase()) {
      return {
        valid: false,
        code: 'QR_PACKAGE_MISMATCH',
        reason: `QR token belongs to package ${payload.pkg}, not ${pkg.packageId}.`,
      };
    }

    if (pkg.qrRevoked) {
      return {
        valid: false,
        code: 'QR_REVOKED',
        reason: `QR label for ${pkg.packageId} has been revoked.`,
      };
    }

    const activeVersion = pkg.qrTokenVersion ?? 1;
    if (payload.ver !== activeVersion) {
      return {
        valid: false,
        code: 'QR_TOKEN_SUPERSEDED',
        reason: `QR token version ${payload.ver} is superseded by active version ${activeVersion}.`,
      };
    }

    const tokenHash = this.hashToken(trimmed);
    const expectedHashBuf = Buffer.from(pkg.qrTokenHash, 'utf8');
    const actualHashBuf = Buffer.from(tokenHash, 'utf8');
    if (
      expectedHashBuf.length !== actualHashBuf.length ||
      !crypto.timingSafeEqual(expectedHashBuf, actualHashBuf)
    ) {
      return {
        valid: false,
        code: 'QR_TOKEN_MISMATCH',
        reason: 'QR token digest does not match the active registered label for this package.',
      };
    }

    const nowSec = Math.floor(nowMs / 1000);
    if (payload.exp <= nowSec) {
      return {
        valid: false,
        code: 'QR_TOKEN_EXPIRED',
        reason: 'QR token has expired. Reprint an updated label before scanning.',
      };
    }

    return {
      valid: true,
      keyId,
      payload,
      tokenHash,
    };
  }

  buildLabelData(pkg: PackageDto, issued: IssuedQrToken): QrLabelData {
    const handlingInstructions: string[] = [
      `Max payload ${pkg.maxWeightKg} kg | ${pkg.dimensionsCm.length}x${pkg.dimensionsCm.width}x${pkg.dimensionsCm.height} cm`,
    ];
    if (pkg.protectionCategory !== 'STANDARD') {
      handlingInstructions.push(`${pkg.protectionCategory.replace('_', ' ')} enclosure`);
    }
    if (pkg.supportsLiquidContainment) {
      handlingInstructions.push('Liquid-containment seal enabled');
    }
    handlingInstructions.push('Authorized ReBoxify scan required at every custody transfer');

    return {
      packageId: pkg.packageId,
      packageClass: pkg.packageClass,
      dimensionsCm: pkg.dimensionsCm,
      maxWeightKg: pkg.maxWeightKg,
      protectionCategory: pkg.protectionCategory,
      supportsLiquidContainment: pkg.supportsLiquidContainment,
      material: pkg.material,
      ownerType: pkg.ownerType,
      fulfilmentLocation: pkg.fulfilmentLocation,
      tokenVersion: issued.tokenVersion,
      qrToken: issued.token,
      issuedAt: issued.issuedAt.toISOString(),
      expiresAt: issued.expiresAt.toISOString(),
      handlingInstructions,
    };
  }
}

export const defaultQrService = new QrService();

