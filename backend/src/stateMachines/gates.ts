import {
  OrderStatus,
  PackageStatus,
  PaymentStatus,
  ReturnStatus,
} from '../types/domain.js';

export interface GateCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Blueprint Section 7.2 Gate 1: Dispatch requires a CAPTURED payment.
 */
export function canDispatchOrder(
  orderStatus: OrderStatus,
  paymentStatus: PaymentStatus,
  allocatedPackageCount: number
): GateCheckResult {
  if (allocatedPackageCount < 1) {
    return { allowed: false, reason: 'Order must have at least one allocated package before dispatch.' };
  }
  if (orderStatus !== 'ALLOCATED' && orderStatus !== 'PAID') {
    return { allowed: false, reason: `Order status ${orderStatus} is not ready for dispatch.` };
  }
  if (paymentStatus !== 'CAPTURED') {
    return {
      allowed: false,
      reason: `Dispatch blocked: payment state must be CAPTURED (currently ${paymentStatus}).`,
    };
  }
  return { allowed: true };
}

/**
 * Blueprint Section 7.2 Gate 2: Refund eligibility check starts only after inspection/approval.
 */
export function canInitiateRefundFromReturn(
  returnStatus: ReturnStatus,
  inspectionOutcome?: string,
  decisionOutcome?: string
): GateCheckResult {
  if (
    returnStatus !== 'UNDER_INSPECTION' &&
    returnStatus !== 'NEEDS_REVIEW' &&
    returnStatus !== 'APPROVED'
  ) {
    return {
      allowed: false,
      reason: `Return status ${returnStatus} cannot trigger a refund.`,
    };
  }
  if (inspectionOutcome !== 'PASS' && decisionOutcome !== 'APPROVED') {
    return {
      allowed: false,
      reason:
        'Return must pass inspection or receive authorized human review approval before refund initiation.',
    };
  }
  return { allowed: true };
}

/**
 * Blueprint Section 7.2 Gate 3: Physical cleaning and recirculation are NEVER blocked by pending refunds.
 */
export function canCleanAndRecirculatePackage(
  packageStatus: PackageStatus,
  _paymentStatus: PaymentStatus
): GateCheckResult {
  if (packageStatus !== 'INSPECTED' && packageStatus !== 'CLEANING' && packageStatus !== 'REPAIR') {
    return {
      allowed: false,
      reason: `Package in status ${packageStatus} cannot be released directly to AVAILABLE.`,
    };
  }
  return { allowed: true };
}

/**
 * Blueprint Section 22.2: A reuse cycle counts ONLY after a verified return and passing inspection.
 */
export function shouldIncrementReuseCount(
  fromStatus: PackageStatus,
  toStatus: PackageStatus,
  lastInspectionOutcome?: string
): boolean {
  return (
    toStatus === 'AVAILABLE' &&
    (fromStatus === 'CLEANING' || fromStatus === 'REPAIR') &&
    lastInspectionOutcome === 'PASS'
  );
}

