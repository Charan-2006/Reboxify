import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { AuthPrincipal, USER_ROLES, UserRole } from '../types/domain.js';
import { unauthorized } from '../utils/errors.js';

interface JwtPayloadShape {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
  businessId?: string;
  collectionCenterId?: string;
}

export function signAuthToken(principal: AuthPrincipal): string {
  const payload: JwtPayloadShape = {
    sub: principal.userId,
    email: principal.email,
    name: principal.name,
    role: principal.role,
    ...(principal.businessId ? { businessId: principal.businessId } : {}),
    ...(principal.collectionCenterId ? { collectionCenterId: principal.collectionCenterId } : {}),
  };

  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: '12h',
    issuer: 'reboxify-api',
  });
}

export function verifyAuthToken(token: string): AuthPrincipal {
  const decoded = jwt.verify(token, config.jwtSecret, {
    issuer: 'reboxify-api',
  }) as JwtPayloadShape;

  if (!decoded?.sub || !decoded?.role || !USER_ROLES.includes(decoded.role)) {
    throw unauthorized('Invalid authentication token.');
  }

  return {
    userId: decoded.sub,
    email: decoded.email,
    name: decoded.name,
    role: decoded.role,
    businessId: decoded.businessId,
    collectionCenterId: decoded.collectionCenterId,
  };
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.header('authorization');
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }
  return token.trim();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    next(unauthorized('Bearer authorization token is required.'));
    return;
  }

  try {
    req.auth = verifyAuthToken(token);
    next();
  } catch {
    next(unauthorized('Authentication token is invalid or expired.'));
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    next();
    return;
  }

  try {
    req.auth = verifyAuthToken(token);
    next();
  } catch {
    next(unauthorized('Authentication token is invalid or expired.'));
  }
}

