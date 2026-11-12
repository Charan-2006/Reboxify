import {
  OwnershipModel,
  PackageClass,
  PackageOwnerType,
  PackageStatus,
} from '../types/domain.js';
import {
  calculateConfiguredDeposit,
  DepositCalculationResult,
  PACKAGING_CATALOGUE,
} from './packagingCatalogue.js';

export interface AllocationProductItem {
  sku: string;
  name: string;
  quantity: number;
  dimensionsCm: {
    length: number;
    width: number;
    height: number;
  };
  weightKg: number;
  rotatable: boolean;
  allowedOrientations?: string[];
  fragility: 'LOW' | 'MEDIUM' | 'HIGH';
  restrictions?: {
    liquidContainment?: boolean;
    temperatureControlled?: boolean;
    contaminationSensitive?: boolean;
  };
}

export interface CandidatePackage {
  id: string;
  packageId: string;
  ownerType: PackageOwnerType;
  ownerId?: string;
  packageClass: PackageClass;
  dimensionsCm: {
    length: number;
    width: number;
    height: number;
  };
  maxWeightKg: number;
  protectionCategory: 'STANDARD' | 'REINFORCED' | 'HIGH_PROTECTION';
  supportsLiquidContainment: boolean;
  replacementValue: number;
  depositAmount: number;
  currency: string;
  status: PackageStatus;
  condition: 'NEW' | 'GOOD' | 'MINOR_WEAR' | 'DAMAGED' | 'CONTAMINATED';
  reuseCount: number;
  maxLifecycleLimit: number;
  fulfilmentLocation: string;
}

export interface AllocationInput {
  merchantId: string;
  packagingModel: OwnershipModel;
  allowCrossMerchantPool: boolean;
  fulfilmentLocation: string;
  currency: string;
  depositMultiplier?: number;
  allowSplit?: boolean;
  items: AllocationProductItem[];
  candidates: CandidatePackage[];
}

export interface SelectedPackageResult {
  packageRefId: string;
  packageId: string;
  packageClass: PackageClass;
  ownerType: PackageOwnerType;
  fulfilmentLocation: string;
  score: number;
  deposit: DepositCalculationResult;
  assignedSkus: Array<{ sku: string; quantity: number }>;
  explanation: string;
}

export interface AllocationRejectionSummary {
  packageId?: string;
  packageClass?: PackageClass;
  reason: string;
}

export interface AllocationResult {
  outcome:
    | 'ALLOCATED'
    | 'ALLOCATED_SPLIT'
    | 'SPLIT_RECOMMENDED'
    | 'INSUFFICIENT_INVENTORY'
    | 'OVERSIZED_PRODUCT'
    | 'INVALID_INPUT';
  policyVersion: string;
  selectedPackages: SelectedPackageResult[];
  recommendedSplitGroups?: Array<{
    groupIndex: number;
    items: Array<{ sku: string; quantity: number }>;
    candidateClass?: PackageClass;
    availablePackageId?: string;
  }>;
  totalDeposit: number;
  currency: string;
  explanation: string;
  rejections: AllocationRejectionSummary[];
}

export const ALLOCATION_POLICY_VERSION = 'v2.0-deterministic';

const CLASS_ORDER: Record<PackageClass, number> = { S: 1, M: 2, L: 3, XL: 4 };
const PROTECTION_RANK: Record<'STANDARD' | 'REINFORCED' | 'HIGH_PROTECTION', number> = {
  STANDARD: 1,
  REINFORCED: 2,
  HIGH_PROTECTION: 3,
};

function clearanceForFragility(fragility: 'LOW' | 'MEDIUM' | 'HIGH'): number {
  if (fragility === 'HIGH') return 3.0;
  if (fragility === 'MEDIUM') return 2.0;
  return 1.0;
}

function minProtectionForFragility(
  fragility: 'LOW' | 'MEDIUM' | 'HIGH'
): 'STANDARD' | 'REINFORCED' | 'HIGH_PROTECTION' {
  if (fragility === 'HIGH') return 'REINFORCED';
  return 'STANDARD';
}

interface Dimensions {
  length: number;
  width: number;
  height: number;
}

function getOrientations(dims: Dimensions, rotatable: boolean, allowedOrientations?: string[]): Dimensions[] {
  const uprightOnly =
    !rotatable ||
    (allowedOrientations &&
      allowedOrientations.length > 0 &&
      allowedOrientations.every((o) => o === 'UPRIGHT'));

  if (uprightOnly) {
    return [
      { length: dims.length, width: dims.width, height: dims.height },
      { length: dims.width, width: dims.length, height: dims.height },
    ];
  }

  const { length: l, width: w, height: h } = dims;
  return [
    { length: l, width: w, height: h },
    { length: l, width: h, height: w },
    { length: w, width: l, height: h },
    { length: w, width: h, height: l },
    { length: h, width: l, height: w },
    { length: h, width: w, height: l },
  ];
}

function fitsBox(boxDims: Dimensions, reqDims: Dimensions, clearanceCm: number): boolean {
  return (
    reqDims.length + clearanceCm <= boxDims.length &&
    reqDims.width + clearanceCm <= boxDims.width &&
    reqDims.height + clearanceCm <= boxDims.height
  );
}

interface UnitRequirement {
  sku: string;
  name: string;
  dimensionsCm: Dimensions;
  weightKg: number;
  rotatable: boolean;
  allowedOrientations?: string[];
  fragility: 'LOW' | 'MEDIUM' | 'HIGH';
  requiresLiquidContainment: boolean;
}

function expandUnits(items: AllocationProductItem[]): UnitRequirement[] {
  const units: UnitRequirement[] = [];
  for (const item of items) {
    for (let i = 0; i < item.quantity; i += 1) {
      units.push({
        sku: item.sku,
        name: item.name,
        dimensionsCm: item.dimensionsCm,
        weightKg: item.weightKg,
        rotatable: item.rotatable,
        allowedOrientations: item.allowedOrientations,
        fragility: item.fragility,
        requiresLiquidContainment: Boolean(item.restrictions?.liquidContainment),
      });
    }
  }
  return units;
}

function aggregateUnitsSimpleStack(units: UnitRequirement[]): {
  footprintOptions: Dimensions[];
  totalWeightKg: number;
  maxClearanceCm: number;
  requiredProtectionRank: number;
  requiresLiquidContainment: boolean;
} {
  let totalWeightKg = 0;
  let maxClearanceCm = 1.0;
  let requiredProtectionRank = 1;
  let requiresLiquidContainment = false;

  // Try deterministic axis stacking along X (length), Y (width), or Z (height)
  // using each unit's primary valid orientations.
  let stackX: Dimensions = { length: 0, width: 0, height: 0 };
  let stackY: Dimensions = { length: 0, width: 0, height: 0 };
  let stackZ: Dimensions = { length: 0, width: 0, height: 0 };

  for (const u of units) {
    totalWeightKg += u.weightKg;
    maxClearanceCm = Math.max(maxClearanceCm, clearanceForFragility(u.fragility));
    requiredProtectionRank = Math.max(
      requiredProtectionRank,
      PROTECTION_RANK[minProtectionForFragility(u.fragility)]
    );
    if (u.requiresLiquidContainment) requiresLiquidContainment = true;

    const orientations = getOrientations(u.dimensionsCm, u.rotatable, u.allowedOrientations);
    // Pick lowest-height orientation when stacking vertically, compact horizontal footprint otherwise.
    const sortedByHeight = [...orientations].sort((a, b) => a.height - b.height);
    const flat = sortedByHeight[0];
    const sortedByLength = [...orientations].sort((a, b) => a.length - b.length);
    const slimX = sortedByLength[0];
    const sortedByWidth = [...orientations].sort((a, b) => a.width - b.width);
    const slimY = sortedByWidth[0];

    stackZ = {
      length: Math.max(stackZ.length, flat.length),
      width: Math.max(stackZ.width, flat.width),
      height: stackZ.height + flat.height,
    };
    stackX = {
      length: stackX.length + slimX.length,
      width: Math.max(stackX.width, slimX.width),
      height: Math.max(stackX.height, slimX.height),
    };
    stackY = {
      length: Math.max(stackY.length, slimY.length),
      width: stackY.width + slimY.width,
      height: Math.max(stackY.height, slimY.height),
    };
  }

  // Generate permutations of the stacked bounding boxes when all items are rotatable.
  const allRotatable = units.every(
    (u) =>
      u.rotatable &&
      !(
        u.allowedOrientations &&
        u.allowedOrientations.length > 0 &&
        u.allowedOrientations.every((o) => o === 'UPRIGHT')
      )
  );

  const footprintOptions: Dimensions[] = [];
  for (const stack of [stackZ, stackX, stackY]) {
    footprintOptions.push(...getOrientations(stack, allRotatable));
  }

  return {
    footprintOptions,
    totalWeightKg: Math.round(totalWeightKg * 1000) / 1000,
    maxClearanceCm,
    requiredProtectionRank,
    requiresLiquidContainment,
  };
}

function isPackageEligibleForOwnership(
  pkg: CandidatePackage,
  merchantId: string,
  packagingModel: OwnershipModel,
  allowCrossMerchantPool: boolean
): { eligible: boolean; ownershipPriority: number; reason?: string } {
  if (pkg.ownerType === 'MERCHANT') {
    if (pkg.ownerId !== merchantId) {
      return {
        eligible: false,
        ownershipPriority: 0,
        reason: `Package ${pkg.packageId} is owned by another merchant.`,
      };
    }
    if (packagingModel === 'SHARED_POOL') {
      return {
        eligible: false,
        ownershipPriority: 0,
        reason: `Merchant operates in SHARED_POOL mode and cannot consume MERCHANT_OWNED stock.`,
      };
    }
    return { eligible: true, ownershipPriority: 100 };
  }

  if (pkg.ownerType === 'HYBRID') {
    if (pkg.ownerId === merchantId) {
      return { eligible: true, ownershipPriority: 90 };
    }
    if (allowCrossMerchantPool && packagingModel !== 'MERCHANT_OWNED') {
      return { eligible: true, ownershipPriority: 40 };
    }
    return {
      eligible: false,
      ownershipPriority: 0,
      reason: `Hybrid package ${pkg.packageId} does not permit cross-merchant allocation.`,
    };
  }

  // REBOXIFY_POOL
  if (packagingModel === 'MERCHANT_OWNED') {
    return {
      eligible: false,
      ownershipPriority: 0,
      reason: `Merchant policy is MERCHANT_OWNED only; shared ReBoxify pool disabled.`,
    };
  }

  return {
    eligible: true,
    ownershipPriority: packagingModel === 'HYBRID' ? 50 : 100,
  };
}

function evaluateUnitsAgainstSpec(
  units: UnitRequirement[],
  specDims: Dimensions,
  maxWeightKg: number,
  protectionCategory: 'STANDARD' | 'REINFORCED' | 'HIGH_PROTECTION',
  supportsLiquid: boolean
): { fits: boolean; reason?: string; voidVolume: number } {
  const agg = aggregateUnitsSimpleStack(units);

  if (agg.totalWeightKg > maxWeightKg) {
    return {
      fits: false,
      reason: `Total weight ${agg.totalWeightKg}kg exceeds ${maxWeightKg}kg limit.`,
      voidVolume: Infinity,
    };
  }
  if (PROTECTION_RANK[protectionCategory] < agg.requiredProtectionRank) {
    return {
      fits: false,
      reason: `Protection category ${protectionCategory} is below required level for HIGH fragility.`,
      voidVolume: Infinity,
    };
  }
  if (agg.requiresLiquidContainment && !supportsLiquid) {
    return {
      fits: false,
      reason: `Package does not support liquid containment.`,
      voidVolume: Infinity,
    };
  }

  const fitsAnyOrientation = agg.footprintOptions.some((opt) =>
    fitsBox(specDims, opt, agg.maxClearanceCm)
  );
  if (!fitsAnyOrientation) {
    return {
      fits: false,
      reason: `Dimensions with ${agg.maxClearanceCm}cm protective clearance do not fit ${specDims.length}x${specDims.width}x${specDims.height}cm.`,
      voidVolume: Infinity,
    };
  }

  const pkgVol = specDims.length * specDims.width * specDims.height;
  const reqVol = Math.min(
    ...agg.footprintOptions.map((o) => o.length * o.width * o.height)
  );
  return { fits: true, voidVolume: Math.max(0, pkgVol - reqVol) };
}

function selectBestCandidateForUnits(
  units: UnitRequirement[],
  input: AllocationInput,
  excludedIds: Set<string>
): {
  winner?: { candidate: CandidatePackage; score: number; deposit: DepositCalculationResult };
  rejections: AllocationRejectionSummary[];
  fitsAnyCatalogueClass: boolean;
} {
  const rejections: AllocationRejectionSummary[] = [];

  const fitsAnyCatalogueClass = (['S', 'M', 'L', 'XL'] as PackageClass[]).some((cls) => {
    const spec = PACKAGING_CATALOGUE[cls];
    return evaluateUnitsAgainstSpec(
      units,
      spec.dimensionsCm,
      spec.maxWeightKg,
      spec.protectionCategory,
      spec.supportsLiquidContainment
    ).fits;
  });

  const scored: Array<{
    candidate: CandidatePackage;
    score: number;
    deposit: DepositCalculationResult;
  }> = [];

  for (const pkg of input.candidates) {
    if (excludedIds.has(pkg.id)) continue;

    if (pkg.status !== 'AVAILABLE') {
      rejections.push({
        packageId: pkg.packageId,
        packageClass: pkg.packageClass,
        reason: `Package is in status ${pkg.status}, not AVAILABLE.`,
      });
      continue;
    }

    if (pkg.condition === 'DAMAGED' || pkg.condition === 'CONTAMINATED') {
      rejections.push({
        packageId: pkg.packageId,
        packageClass: pkg.packageClass,
        reason: `Package condition ${pkg.condition} is ineligible for allocation.`,
      });
      continue;
    }

    if (pkg.reuseCount >= pkg.maxLifecycleLimit) {
      rejections.push({
        packageId: pkg.packageId,
        packageClass: pkg.packageClass,
        reason: `Package reached lifecycle limit (${pkg.reuseCount}/${pkg.maxLifecycleLimit}).`,
      });
      continue;
    }

    const ownerCheck = isPackageEligibleForOwnership(
      pkg,
      input.merchantId,
      input.packagingModel,
      input.allowCrossMerchantPool
    );
    if (!ownerCheck.eligible) {
      rejections.push({
        packageId: pkg.packageId,
        packageClass: pkg.packageClass,
        reason: ownerCheck.reason!,
      });
      continue;
    }

    const fit = evaluateUnitsAgainstSpec(
      units,
      pkg.dimensionsCm,
      pkg.maxWeightKg,
      pkg.protectionCategory,
      pkg.supportsLiquidContainment
    );
    if (!fit.fits) {
      rejections.push({
        packageId: pkg.packageId,
        packageClass: pkg.packageClass,
        reason: fit.reason!,
      });
      continue;
    }

    const locationBonus = pkg.fulfilmentLocation === input.fulfilmentLocation ? 500 : 0;
    const classPenalty = CLASS_ORDER[pkg.packageClass] * 1000;
    const voidPenalty = Math.min(400, fit.voidVolume / 100);
    const reusePenalty = pkg.reuseCount * 0.1;

    // Ownership preference (merchant-owned before shared pool in HYBRID) has highest weight (100x),
    // followed by smallest compliant package class, fulfilment location match, void space, and reuse count.
    const score =
      ownerCheck.ownershipPriority * 100 +
      locationBonus -
      classPenalty -
      voidPenalty -
      reusePenalty;
    const deposit = calculateConfiguredDeposit({
      packageClass: pkg.packageClass,
      currency: input.currency,
      depositMultiplier: input.depositMultiplier,
      overrideReplacementValue: pkg.replacementValue,
      overrideBaseDeposit: pkg.depositAmount,
    });

    scored.push({ candidate: pkg, score, deposit });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.candidate.packageId.localeCompare(b.candidate.packageId);
  });

  return {
    winner: scored[0],
    rejections,
    fitsAnyCatalogueClass,
  };
}

function summarizeSkus(units: UnitRequirement[]): Array<{ sku: string; quantity: number }> {
  const counts = new Map<string, number>();
  for (const u of units) {
    counts.set(u.sku, (counts.get(u.sku) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([sku, quantity]) => ({ sku, quantity }));
}

export function evaluatePackagingAllocation(input: AllocationInput): AllocationResult {
  const rejections: AllocationRejectionSummary[] = [];

  if (!input.items || input.items.length === 0) {
    return {
      outcome: 'INVALID_INPUT',
      policyVersion: ALLOCATION_POLICY_VERSION,
      selectedPackages: [],
      totalDeposit: 0,
      currency: input.currency,
      explanation: 'Order contains no items for packaging allocation.',
      rejections: [{ reason: 'No order items provided.' }],
    };
  }

  for (const item of input.items) {
    const { length, width, height } = item.dimensionsCm || ({} as Dimensions);
    if (
      !Number.isFinite(length) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      length <= 0 ||
      width <= 0 ||
      height <= 0 ||
      !Number.isFinite(item.weightKg) ||
      item.weightKg <= 0 ||
      !Number.isInteger(item.quantity) ||
      item.quantity <= 0
    ) {
      return {
        outcome: 'INVALID_INPUT',
        policyVersion: ALLOCATION_POLICY_VERSION,
        selectedPackages: [],
        totalDeposit: 0,
        currency: input.currency,
        explanation: `SKU ${item.sku} is missing valid warehouse dimensions, weight, or quantity. Measurements must be recorded explicitly.`,
        rejections: [{ reason: `Invalid or missing measurements on SKU ${item.sku}.` }],
      };
    }
  }

  const allUnits = expandUnits(input.items);

  // Verify every individual unit can fit at least the largest standard XL package.
  const xlSpec = PACKAGING_CATALOGUE.XL;
  for (const unit of allUnits) {
    const singleFit = evaluateUnitsAgainstSpec(
      [unit],
      xlSpec.dimensionsCm,
      xlSpec.maxWeightKg,
      xlSpec.protectionCategory,
      xlSpec.supportsLiquidContainment
    );
    if (!singleFit.fits) {
      return {
        outcome: 'OVERSIZED_PRODUCT',
        policyVersion: ALLOCATION_POLICY_VERSION,
        selectedPackages: [],
        totalDeposit: 0,
        currency: input.currency,
        explanation: `SKU ${unit.sku} exceeds maximum reusable PP package capacity (XL: ${xlSpec.dimensionsCm.length}x${xlSpec.dimensionsCm.width}x${xlSpec.dimensionsCm.height}cm, ${xlSpec.maxWeightKg}kg). ${singleFit.reason}`,
        rejections: [{ packageClass: 'XL', reason: singleFit.reason! }],
      };
    }
  }

  // Attempt single-package fit across all units.
  const excludedIds = new Set<string>();
  const singleAttempt = selectBestCandidateForUnits(allUnits, input, excludedIds);
  rejections.push(...singleAttempt.rejections);

  if (singleAttempt.winner) {
    const { candidate, score, deposit } = singleAttempt.winner;
    const explanation = `Allocated ${candidate.packageClass} package (${candidate.packageId}, ${candidate.ownerType}) at ${candidate.fulfilmentLocation}: satisfies dimensions with protective clearance, ${candidate.maxWeightKg}kg weight limit, and ${input.packagingModel} ownership policy.`;
    return {
      outcome: 'ALLOCATED',
      policyVersion: ALLOCATION_POLICY_VERSION,
      selectedPackages: [
        {
          packageRefId: candidate.id,
          packageId: candidate.packageId,
          packageClass: candidate.packageClass,
          ownerType: candidate.ownerType,
          fulfilmentLocation: candidate.fulfilmentLocation,
          score: Math.round(score * 100) / 100,
          deposit,
          assignedSkus: summarizeSkus(allUnits),
          explanation,
        },
      ],
      totalDeposit: deposit.amount,
      currency: input.currency,
      explanation,
      rejections,
    };
  }

  // If multi-unit order cannot fit in a single available package, compute a split grouping
  // against actually available inventory (falling back to catalogue specs for recommendations).
  if (allUnits.length > 1) {
    const groups: UnitRequirement[][] = [];
    for (const unit of allUnits) {
      let placed = false;
      for (const grp of groups) {
        const trial = [...grp, unit];
        const trialCandidate = selectBestCandidateForUnits(trial, input, new Set());
        if (trialCandidate.winner) {
          grp.push(unit);
          placed = true;
          break;
        }
      }
      if (!placed) {
        groups.push([unit]);
      }
    }

    if (groups.length > 1) {
      const splitSelections: SelectedPackageResult[] = [];
      const splitRecommendations: NonNullable<AllocationResult['recommendedSplitGroups']> = [];
      let allGroupsAllocated = true;

      for (let i = 0; i < groups.length; i += 1) {
        const grp = groups[i];
        const grpResult = selectBestCandidateForUnits(grp, input, excludedIds);
        const skuSummary = summarizeSkus(grp);

        if (grpResult.winner) {
          excludedIds.add(grpResult.winner.candidate.id);
          const { candidate, score, deposit } = grpResult.winner;
          const grpExplanation = `Split group ${i + 1}: assigned ${candidate.packageClass} package (${candidate.packageId}).`;
          splitSelections.push({
            packageRefId: candidate.id,
            packageId: candidate.packageId,
            packageClass: candidate.packageClass,
            ownerType: candidate.ownerType,
            fulfilmentLocation: candidate.fulfilmentLocation,
            score: Math.round(score * 100) / 100,
            deposit,
            assignedSkus: skuSummary,
            explanation: grpExplanation,
          });
          splitRecommendations.push({
            groupIndex: i + 1,
            items: skuSummary,
            candidateClass: candidate.packageClass,
            availablePackageId: candidate.packageId,
          });
        } else {
          allGroupsAllocated = false;
          splitRecommendations.push({
            groupIndex: i + 1,
            items: skuSummary,
          });
          rejections.push(...grpResult.rejections);
        }
      }

      if (input.allowSplit && allGroupsAllocated) {
        const totalDeposit =
          Math.round(splitSelections.reduce((sum, s) => sum + s.deposit.amount, 0) * 100) / 100;
        return {
          outcome: 'ALLOCATED_SPLIT',
          policyVersion: ALLOCATION_POLICY_VERSION,
          selectedPackages: splitSelections,
          recommendedSplitGroups: splitRecommendations,
          totalDeposit,
          currency: input.currency,
          explanation: `Order split across ${splitSelections.length} reusable packages (${splitSelections.map((s) => `${s.packageId}:${s.packageClass}`).join(', ')}) to satisfy dimensional and weight limits.`,
          rejections,
        };
      }

      if (splitSelections.length > 0) {
        return {
          outcome: 'SPLIT_RECOMMENDED',
          policyVersion: ALLOCATION_POLICY_VERSION,
          selectedPackages: [],
          recommendedSplitGroups: splitRecommendations,
          totalDeposit: 0,
          currency: input.currency,
          explanation: allGroupsAllocated
            ? `Order cannot fit safely in a single package; split into ${groups.length} packages is recommended (re-run with allowSplit=true to allocate).`
            : `Order requires splitting across ${groups.length} packages, and at least one group lacks eligible available inventory.`,
          rejections,
        };
      }
    }
  }

  return {
    outcome: 'INSUFFICIENT_INVENTORY',
    policyVersion: ALLOCATION_POLICY_VERSION,
    selectedPackages: [],
    totalDeposit: 0,
    currency: input.currency,
    explanation: singleAttempt.fitsAnyCatalogueClass
      ? `Items fit standard PP classes, but no eligible AVAILABLE packages satisfied ownership (${input.packagingModel}) and dimensional/weight rules.`
      : `No single standardized package fits the combined order dimensions and weight.`,
    rejections,
  };
}
