import { PackageClass } from '../types/domain.js';

export interface PackageClassSpec {
  packageClass: PackageClass;
  dimensionsCm: {
    length: number;
    width: number;
    height: number;
  };
  maxWeightKg: number;
  protectionCategory: 'STANDARD' | 'REINFORCED' | 'HIGH_PROTECTION';
  supportsLiquidContainment: boolean;
  replacementValueByCurrency: Record<string, number>;
  baseDepositByCurrency: Record<string, number>;
  usageFeeByCurrency: Record<string, number>;
}

export const PACKAGING_CATALOGUE: Record<PackageClass, PackageClassSpec> = {
  S: {
    packageClass: 'S',
    dimensionsCm: { length: 20, width: 15, height: 10 },
    maxWeightKg: 3,
    protectionCategory: 'STANDARD',
    supportsLiquidContainment: false,
    replacementValueByCurrency: { USD: 12, INR: 100 },
    baseDepositByCurrency: { USD: 3, INR: 50 },
    usageFeeByCurrency: { USD: 0.5, INR: 8 },
  },
  M: {
    packageClass: 'M',
    dimensionsCm: { length: 30, width: 25, height: 15 },
    maxWeightKg: 8,
    protectionCategory: 'REINFORCED',
    supportsLiquidContainment: true,
    replacementValueByCurrency: { USD: 20, INR: 160 },
    baseDepositByCurrency: { USD: 5, INR: 80 },
    usageFeeByCurrency: { USD: 0.75, INR: 12 },
  },
  L: {
    packageClass: 'L',
    dimensionsCm: { length: 45, width: 35, height: 25 },
    maxWeightKg: 18,
    protectionCategory: 'HIGH_PROTECTION',
    supportsLiquidContainment: true,
    replacementValueByCurrency: { USD: 32, INR: 270 },
    baseDepositByCurrency: { USD: 8, INR: 120 },
    usageFeeByCurrency: { USD: 1.25, INR: 20 },
  },
  XL: {
    packageClass: 'XL',
    dimensionsCm: { length: 60, width: 45, height: 35 },
    maxWeightKg: 30,
    protectionCategory: 'HIGH_PROTECTION',
    supportsLiquidContainment: true,
    replacementValueByCurrency: { USD: 50, INR: 420 },
    baseDepositByCurrency: { USD: 12, INR: 180 },
    usageFeeByCurrency: { USD: 1.75, INR: 30 },
  },
};

export interface DepositCalculationResult {
  amount: number;
  currency: string;
  breakdown: {
    baseDeposit: number;
    multiplier: number;
    replacementValue: number;
    ruleVersion: string;
  };
}

export const DEPOSIT_RULE_VERSION = 'v2.0-deterministic';

export function getSpecForClass(packageClass: PackageClass): PackageClassSpec {
  return PACKAGING_CATALOGUE[packageClass];
}

export function calculateConfiguredDeposit(params: {
  packageClass: PackageClass;
  currency: string;
  depositMultiplier?: number;
  overrideReplacementValue?: number;
  overrideBaseDeposit?: number;
}): DepositCalculationResult {
  const spec = getSpecForClass(params.packageClass);
  const currency = params.currency.toUpperCase();
  const baseDeposit =
    params.overrideBaseDeposit ??
    spec.baseDepositByCurrency[currency] ??
    spec.baseDepositByCurrency.USD;
  const replacementValue =
    params.overrideReplacementValue ??
    spec.replacementValueByCurrency[currency] ??
    spec.replacementValueByCurrency.USD;

  const multiplier = Number.isFinite(params.depositMultiplier)
    ? Math.max(0, Math.min(2.5, params.depositMultiplier!))
    : 1.0;

  const raw = baseDeposit * multiplier;
  const bounded = Math.min(replacementValue, Math.max(0, raw));
  const amount = Math.round(bounded * 100) / 100;

  return {
    amount,
    currency,
    breakdown: {
      baseDeposit,
      multiplier,
      replacementValue,
      ruleVersion: DEPOSIT_RULE_VERSION,
    },
  };
}

