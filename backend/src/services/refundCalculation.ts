import { InspectionCondition } from '../types/domain.js';

export interface InspectionChecklistInput {
  identityVerified: boolean;
  structuralIntegrity: boolean;
  cleanlinessAcceptable: boolean;
  completeComponents: boolean;
}

export interface DeductionItem {
  code: string;
  label: string;
  amount: number;
  reason: string;
}

export interface RefundCalculationInput {
  condition: InspectionCondition;
  checklist: InspectionChecklistInput;
  isLateReturn: boolean;
  daysLate: number;
  disputed?: boolean;
  allocatedDeposit: number;
  alreadyRefundedForPackage: number;
  alreadyPendingForPackage: number;
  totalCapturedTransactionAmount: number;
  totalConfirmedRefundsAcrossOrder: number;
  totalPendingRefundsAcrossOrder: number;
  currency: string;
}

export interface RefundCalculationOutput {
  ruleVersion: string;
  eligible: boolean;
  inspectionOutcome: 'PASS' | 'FAIL' | 'NEEDS_REVIEW';
  recommendedReturnStatus: 'UNDER_INSPECTION' | 'NEEDS_REVIEW';
  recommendedPackageStatus: 'INSPECTED' | 'QUARANTINED' | 'UNDER_INVESTIGATION';
  originalDeposit: number;
  maxRefundableBalance: number;
  totalDeductions: number;
  calculatedAmount: number;
  currency: string;
  reason: string;
  deductionBreakdown: DeductionItem[];
}

export const REFUND_RULE_VERSION = 'REBOXIFY_REFUND_RULES_V2';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Blueprint Section 10.4, 15.3, 21.3:
 * Deterministic server-side refund calculation. Never invokes AI and never trusts client refund amounts.
 */
export function calculateReturnRefund(input: RefundCalculationInput): RefundCalculationOutput {
  const pkgRemaining = round2(
    Math.max(0, input.allocatedDeposit - input.alreadyRefundedForPackage - input.alreadyPendingForPackage)
  );
  const txRemaining = round2(
    Math.max(
      0,
      input.totalCapturedTransactionAmount -
        input.totalConfirmedRefundsAcrossOrder -
        input.totalPendingRefundsAcrossOrder
    )
  );
  const maxRefundableBalance = round2(Math.min(pkgRemaining, txRemaining));
  const originalDeposit = round2(Math.max(0, input.allocatedDeposit));
  const currency = input.currency.toUpperCase();

  const deductions: DeductionItem[] = [];
  let baseRefundPct = 1.0;
  let inspectionOutcome: 'PASS' | 'FAIL' | 'NEEDS_REVIEW' = 'PASS';
  let recommendedPackageStatus: 'INSPECTED' | 'QUARANTINED' | 'UNDER_INVESTIGATION' = 'INSPECTED';
  let summaryReason = 'Package returned on time in acceptable reusable condition.';

  switch (input.condition) {
    case 'GOOD':
      baseRefundPct = 1.0;
      summaryReason = 'Good reusable condition: eligible for full deposit refund.';
      break;

    case 'MINOR_WEAR':
      // Blueprint 21.3: Normal wear does not automatically penalise the customer.
      baseRefundPct = 1.0;
      summaryReason = 'Normal minor wear observed: eligible for full deposit refund with no penalty.';
      break;

    case 'MINOR_DAMAGE':
      baseRefundPct = 0.5;
      inspectionOutcome = 'NEEDS_REVIEW';
      recommendedPackageStatus = 'INSPECTED';
      summaryReason = 'Minor structural or seal damage detected: 50% repair deduction applied.';
      deductions.push({
        code: 'MINOR_DAMAGE_REPAIR',
        label: 'Minor Damage Repair Deduction (50%)',
        amount: round2(originalDeposit * 0.5),
        reason: 'Recoverable structural/lid/latch damage requiring centre repair before reuse.',
      });
      break;

    case 'MAJOR_DAMAGE':
      baseRefundPct = 0;
      inspectionOutcome = 'FAIL';
      recommendedPackageStatus = 'QUARANTINED';
      summaryReason = 'Major structural damage renders package unsafe: zero deposit refund.';
      deductions.push({
        code: 'MAJOR_DAMAGE_FORFEIT',
        label: 'Major Damage Replacement Deduction (100%)',
        amount: originalDeposit,
        reason: 'Severe fracture, puncture, or hinge failure exceeding repair threshold.',
      });
      break;

    case 'CONTAMINATED':
      baseRefundPct = 0;
      inspectionOutcome = 'FAIL';
      recommendedPackageStatus = 'QUARANTINED';
      summaryReason = 'Hazardous or liquid contamination detected: zero deposit refund pending quarantine.';
      deductions.push({
        code: 'CONTAMINATION_DISPOSAL',
        label: 'Contamination Quarantine & Sanitization Deduction (100%)',
        amount: originalDeposit,
        reason: 'Spill, odor, or hazardous residue requires quarantine and specialized disposal/cleaning.',
      });
      break;

    case 'MISSING_PACKAGING':
      baseRefundPct = 0;
      inspectionOutcome = 'FAIL';
      recommendedPackageStatus = 'UNDER_INVESTIGATION';
      summaryReason = 'Reusable container missing from return: zero refund.';
      deductions.push({
        code: 'MISSING_PACKAGE_LOSS',
        label: 'Missing Packaging Replacement Deduction (100%)',
        amount: originalDeposit,
        reason: 'Allocated reusable container was not returned.',
      });
      break;

    case 'UNUSABLE':
      baseRefundPct = 0;
      inspectionOutcome = 'FAIL';
      recommendedPackageStatus = 'QUARANTINED';
      summaryReason = 'Package unusable beyond repair: zero refund.';
      deductions.push({
        code: 'UNUSABLE_WRITEOFF',
        label: 'Unusable Packaging Write-Off Deduction (100%)',
        amount: originalDeposit,
        reason: 'Container permanently degraded or rendered unusable.',
      });
      break;

    case 'WRONG_PACKAGE':
      baseRefundPct = 0;
      inspectionOutcome = 'NEEDS_REVIEW';
      recommendedPackageStatus = 'UNDER_INVESTIGATION';
      summaryReason = 'Wrong container returned; withheld pending identity & custody investigation.';
      deductions.push({
        code: 'WRONG_PACKAGE_HOLD',
        label: 'Wrong Package Identity Hold (100%)',
        amount: originalDeposit,
        reason: 'Physical container identity does not match allocated package.',
      });
      break;
  }

  // Checklist enforcement: even if condition selected GOOD/MINOR_WEAR, failing identity or missing lid/components routes to review
  if (!input.checklist.identityVerified && baseRefundPct > 0) {
    baseRefundPct = 0;
    inspectionOutcome = 'NEEDS_REVIEW';
    recommendedPackageStatus = 'UNDER_INVESTIGATION';
    summaryReason = 'Package identity mismatch during checklist: withheld pending human review.';
    deductions.push({
      code: 'IDENTITY_CHECK_FAILED',
      label: 'Package Identity Verification Hold',
      amount: originalDeposit,
      reason: 'Inspector could not verify allocated package identity.',
    });
  } else if (
    (input.condition === 'GOOD' || input.condition === 'MINOR_WEAR') &&
    (!input.checklist.structuralIntegrity ||
      !input.checklist.cleanlinessAcceptable ||
      !input.checklist.completeComponents)
  ) {
    baseRefundPct = 0.5;
    inspectionOutcome = 'NEEDS_REVIEW';
    summaryReason = 'Checklist incomplete (missing component, cleanliness, or structural issue): routed to human review with 50% deduction.';
    deductions.push({
      code: 'CHECKLIST_INCOMPLETE_DEDUCTION',
      label: 'Incomplete Checklist / Missing Component Deduction (50%)',
      amount: round2(originalDeposit * 0.5),
      reason: 'One or more return checklist criteria failed verification.',
    });
  }

  let preCapRefund = round2(originalDeposit * baseRefundPct);

  // Blueprint 21.3: Disclosed late-return handling routes to NEEDS_REVIEW cleanly without duplicate deduction
  if (input.isLateReturn) {
    inspectionOutcome = 'NEEDS_REVIEW';
    if (preCapRefund > 0) {
      const lateFee = round2(Math.min(preCapRefund, originalDeposit * 0.2));
      preCapRefund = round2(preCapRefund - lateFee);
      deductions.push({
        code: 'LATE_RETURN_POLICY',
        label: 'Disclosed Late Return Handling Fee (20%)',
        amount: lateFee,
        reason: `Returned ${Math.max(1, input.daysLate)} day(s) after disclosed return window.`,
      });
      summaryReason = `${summaryReason} Disclosed late-return adjustment (${input.daysLate}d overdue) routed to human review.`;
    }
  }

  if (input.disputed) {
    inspectionOutcome = 'NEEDS_REVIEW';
    summaryReason = `${summaryReason} Customer/operator dispute flagged for human review.`;
  }

  // Enforce strict upper cap against remaining captured deposit allocation
  let calculatedAmount = round2(Math.min(preCapRefund, maxRefundableBalance));

  if (preCapRefund > maxRefundableBalance && maxRefundableBalance < originalDeposit) {
    const capOffset = round2(preCapRefund - calculatedAmount);
    if (capOffset > 0) {
      deductions.push({
        code: 'PRIOR_REFUND_CAP',
        label: 'Captured Balance Cap Adjustment',
        amount: capOffset,
        reason: 'Capped to remaining unrefunded balance against original PayPal capture.',
      });
    }
    summaryReason = `${summaryReason} Amount capped at remaining refundable deposit balance (${currency} ${maxRefundableBalance.toFixed(2)}).`;
  }

  if (maxRefundableBalance <= 0 && calculatedAmount > 0) {
    calculatedAmount = 0;
  }

  const totalDeductions = round2(
    Math.min(
      originalDeposit,
      deductions.reduce((sum, item) => sum + item.amount, 0)
    )
  );

  const recommendedReturnStatus: 'UNDER_INSPECTION' | 'NEEDS_REVIEW' =
    inspectionOutcome === 'NEEDS_REVIEW' || inspectionOutcome === 'FAIL'
      ? 'NEEDS_REVIEW'
      : 'UNDER_INSPECTION';

  return {
    ruleVersion: REFUND_RULE_VERSION,
    eligible: calculatedAmount > 0 && baseRefundPct > 0,
    inspectionOutcome,
    recommendedReturnStatus,
    recommendedPackageStatus,
    originalDeposit,
    maxRefundableBalance,
    totalDeductions,
    calculatedAmount,
    currency,
    reason: summaryReason,
    deductionBreakdown: deductions,
  };
}

