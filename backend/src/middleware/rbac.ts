import { NextFunction, Request, Response } from 'express';
import { AuthPrincipal, UserRole } from '../types/domain.js';
import { forbidden, unauthorized } from '../utils/errors.js';

export function requireRoles(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      next(unauthorized());
      return;
    }
    if (!allowedRoles.includes(req.auth.role)) {
      next(forbidden(`Role ${req.auth.role} is not authorized for this operation.`));
      return;
    }
    next();
  };
}

/**
 * Resolves the effective merchant tenant ID for a request.
 * Non-ADMIN merchant roles are always confined to their token's businessId.
 */
export function resolveMerchantScope(
  principal: AuthPrincipal,
  requestedBusinessId?: string
): string | undefined {
  if (principal.role === 'ADMIN') {
    return requestedBusinessId;
  }

  if (principal.role === 'MERCHANT_ADMIN' || principal.role === 'MERCHANT_STAFF') {
    if (!principal.businessId) {
      throw forbidden('Merchant account is not linked to a business.');
    }
    if (requestedBusinessId && requestedBusinessId !== principal.businessId) {
      throw forbidden('Cross-tenant access to another business is prohibited.');
    }
    return principal.businessId;
  }

  throw forbidden('Tenant-scoped merchant privileges required.');
}

