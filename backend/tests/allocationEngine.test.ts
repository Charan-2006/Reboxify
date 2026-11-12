import { describe, expect, it } from 'vitest';
import {
  CandidatePackage,
  evaluatePackagingAllocation,
} from '../src/services/allocationEngine.js';
import {
  calculateConfiguredDeposit,
  PACKAGING_CATALOGUE,
} from '../src/services/packagingCatalogue.js';
import { PackageClass } from '../src/types/domain.js';

function makeCandidate(
  overrides: Partial<CandidatePackage> & { id: string; packageId: string; packageClass: PackageClass }
): CandidatePackage {
  const spec = PACKAGING_CATALOGUE[overrides.packageClass];
  return {
    ownerType: 'REBOXIFY_POOL',
    dimensionsCm: spec.dimensionsCm,
    maxWeightKg: spec.maxWeightKg,
    protectionCategory: spec.protectionCategory,
    supportsLiquidContainment: spec.supportsLiquidContainment,
    replacementValue: spec.replacementValueByCurrency.USD,
    depositAmount: spec.baseDepositByCurrency.USD,
    currency: 'USD',
    status: 'AVAILABLE',
    condition: 'NEW',
    reuseCount: 0,
    maxLifecycleLimit: 50,
    fulfilmentLocation: 'CHN-HUB-01',
    ...overrides,
  };
}

describe('Deterministic Packaging Allocation Engine', () => {
  it('rejects missing or non-positive SKU measurements without guessing', () => {
    const res = evaluatePackagingAllocation({
      merchantId: 'm1',
      packagingModel: 'SHARED_POOL',
      allowCrossMerchantPool: false,
      fulfilmentLocation: 'CHN-HUB-01',
      currency: 'USD',
      items: [
        {
          sku: 'BAD-SKU',
          name: 'Unmeasured Item',
          quantity: 1,
          dimensionsCm: { length: 0, width: 10, height: 5 },
          weightKg: 1,
          rotatable: true,
          fragility: 'LOW',
        },
      ],
      candidates: [makeCandidate({ id: 'p1', packageId: 'RBX-CHN-001', packageClass: 'S' })],
    });

    expect(res.outcome).toBe('INVALID_INPUT');
    expect(res.selectedPackages).toHaveLength(0);
  });

  it('rejects volume-only illusions (long rod skips S and picks M)', () => {
    const candidates = [
      makeCandidate({ id: 'pS', packageId: 'RBX-CHN-S01', packageClass: 'S' }),
      makeCandidate({ id: 'pM', packageId: 'RBX-CHN-M01', packageClass: 'M' }),
    ];

    // Volume = 88 cm3 (tiny compared to S 3000 cm3), but length 22cm > S max 20cm!
    const res = evaluatePackagingAllocation({
      merchantId: 'm1',
      packagingModel: 'SHARED_POOL',
      allowCrossMerchantPool: false,
      fulfilmentLocation: 'CHN-HUB-01',
      currency: 'USD',
      items: [
        {
          sku: 'ROD-22',
          name: 'Tripod Rod',
          quantity: 1,
          dimensionsCm: { length: 22, width: 2, height: 2 },
          weightKg: 0.5,
          rotatable: true,
          fragility: 'LOW',
        },
      ],
      candidates,
    });

    expect(res.outcome).toBe('ALLOCATED');
    expect(res.selectedPackages[0].packageId).toBe('RBX-CHN-M01');
    expect(res.selectedPackages[0].packageClass).toBe('M');
  });

  it('respects upright-only orientation, fragility protection, liquid containment, and weight limits', () => {
    const candidates = [
      makeCandidate({ id: 'pS', packageId: 'RBX-CHN-S01', packageClass: 'S' }),
      makeCandidate({ id: 'pM', packageId: 'RBX-CHN-M01', packageClass: 'M' }),
      makeCandidate({ id: 'pL', packageId: 'RBX-CHN-L01', packageClass: 'L' }),
    ];

    // 1. Height 16cm upright-only cannot rotate sideways into M (height 15cm); must pick L (height 25cm)
    const uprightRes = evaluatePackagingAllocation({
      merchantId: 'm1',
      packagingModel: 'SHARED_POOL',
      allowCrossMerchantPool: false,
      fulfilmentLocation: 'CHN-HUB-01',
      currency: 'USD',
      items: [
        {
          sku: 'VASE-UP',
          name: 'Glass Vase',
          quantity: 1,
          dimensionsCm: { length: 10, width: 10, height: 16 },
          weightKg: 1.5,
          rotatable: false,
          allowedOrientations: ['UPRIGHT'],
          fragility: 'HIGH', // +3cm clearance => height req = 19cm
        },
      ],
      candidates,
    });
    expect(uprightRes.outcome).toBe('ALLOCATED');
    expect(uprightRes.selectedPackages[0].packageClass).toBe('L');

    // 2. Tiny item that is 4kg (> S 3kg weight limit) must skip S and pick M
    const heavyRes = evaluatePackagingAllocation({
      merchantId: 'm1',
      packagingModel: 'SHARED_POOL',
      allowCrossMerchantPool: false,
      fulfilmentLocation: 'CHN-HUB-01',
      currency: 'USD',
      items: [
        {
          sku: 'DUMBBELL',
          name: 'Compact Weight',
          quantity: 1,
          dimensionsCm: { length: 10, width: 8, height: 5 },
          weightKg: 4,
          rotatable: true,
          fragility: 'LOW',
        },
      ],
      candidates,
    });
    expect(heavyRes.outcome).toBe('ALLOCATED');
    expect(heavyRes.selectedPackages[0].packageClass).toBe('M');

    // 3. Small liquid container skips S (supportsLiquidContainment: false) and picks M
    const liquidRes = evaluatePackagingAllocation({
      merchantId: 'm1',
      packagingModel: 'SHARED_POOL',
      allowCrossMerchantPool: false,
      fulfilmentLocation: 'CHN-HUB-01',
      currency: 'USD',
      items: [
        {
          sku: 'SERUM',
          name: 'Liquid Bottle',
          quantity: 1,
          dimensionsCm: { length: 8, width: 5, height: 5 },
          weightKg: 0.4,
          rotatable: true,
          fragility: 'MEDIUM',
          restrictions: { liquidContainment: true },
        },
      ],
      candidates,
    });
    expect(liquidRes.outcome).toBe('ALLOCATED');
    expect(liquidRes.selectedPackages[0].packageClass).toBe('M');
  });

  it('never allocates quarantined, reserved, damaged, contaminated, or retired packages', () => {
    const res = evaluatePackagingAllocation({
      merchantId: 'm1',
      packagingModel: 'SHARED_POOL',
      allowCrossMerchantPool: false,
      fulfilmentLocation: 'CHN-HUB-01',
      currency: 'USD',
      items: [
        {
          sku: 'SMALL-1',
          name: 'Accessory',
          quantity: 1,
          dimensionsCm: { length: 10, width: 10, height: 5 },
          weightKg: 0.5,
          rotatable: true,
          fragility: 'LOW',
        },
      ],
      candidates: [
        makeCandidate({ id: 'p1', packageId: 'RBX-1', packageClass: 'S', status: 'QUARANTINED' }),
        makeCandidate({ id: 'p2', packageId: 'RBX-2', packageClass: 'S', status: 'RESERVED' }),
        makeCandidate({ id: 'p3', packageId: 'RBX-3', packageClass: 'S', condition: 'DAMAGED' }),
        makeCandidate({ id: 'p4', packageId: 'RBX-4', packageClass: 'S', reuseCount: 50, maxLifecycleLimit: 50 }),
      ],
    });

    expect(res.outcome).toBe('INSUFFICIENT_INVENTORY');
    expect(res.selectedPackages).toHaveLength(0);
    expect(res.rejections.length).toBe(4);
  });

  it('enforces SHARED_POOL, MERCHANT_OWNED, and HYBRID ownership rules strictly', () => {
    const ownBox = makeCandidate({
      id: 'own',
      packageId: 'RBX-OWN-01',
      packageClass: 'M',
      ownerType: 'MERCHANT',
      ownerId: 'm1',
    });
    const otherMerchantBox = makeCandidate({
      id: 'other',
      packageId: 'RBX-OTH-01',
      packageClass: 'S',
      ownerType: 'MERCHANT',
      ownerId: 'm2',
    });
    const sharedBox = makeCandidate({
      id: 'shared',
      packageId: 'RBX-SHD-01',
      packageClass: 'S',
      ownerType: 'REBOXIFY_POOL',
    });

    const smallItem = [
      {
        sku: 'ACC-1',
        name: 'Small Gadget',
        quantity: 1,
        dimensionsCm: { length: 10, width: 8, height: 4 },
        weightKg: 0.4,
        rotatable: true,
        fragility: 'LOW' as const,
      },
    ];

    // HYBRID prefers merchant-owned first even though sharedBox is class S!
    const hybridRes = evaluatePackagingAllocation({
      merchantId: 'm1',
      packagingModel: 'HYBRID',
      allowCrossMerchantPool: false,
      fulfilmentLocation: 'CHN-HUB-01',
      currency: 'USD',
      items: smallItem,
      candidates: [otherMerchantBox, sharedBox, ownBox],
    });
    expect(hybridRes.outcome).toBe('ALLOCATED');
    expect(hybridRes.selectedPackages[0].packageId).toBe('RBX-OWN-01');

    // HYBRID falls back to sharedBox when merchant-owned is unavailable
    const hybridFallback = evaluatePackagingAllocation({
      merchantId: 'm1',
      packagingModel: 'HYBRID',
      allowCrossMerchantPool: false,
      fulfilmentLocation: 'CHN-HUB-01',
      currency: 'USD',
      items: smallItem,
      candidates: [otherMerchantBox, sharedBox],
    });
    expect(hybridFallback.outcome).toBe('ALLOCATED');
    expect(hybridFallback.selectedPackages[0].packageId).toBe('RBX-SHD-01');

    // MERCHANT_OWNED refuses sharedBox & otherMerchantBox
    const merchantOnlyFail = evaluatePackagingAllocation({
      merchantId: 'm1',
      packagingModel: 'MERCHANT_OWNED',
      allowCrossMerchantPool: false,
      fulfilmentLocation: 'CHN-HUB-01',
      currency: 'USD',
      items: smallItem,
      candidates: [otherMerchantBox, sharedBox],
    });
    expect(merchantOnlyFail.outcome).toBe('INSUFFICIENT_INVENTORY');
  });

  it('handles oversized items and split shipments cleanly', () => {
    const oversized = evaluatePackagingAllocation({
      merchantId: 'm1',
      packagingModel: 'SHARED_POOL',
      allowCrossMerchantPool: false,
      fulfilmentLocation: 'CHN-HUB-01',
      currency: 'USD',
      items: [
        {
          sku: 'SOFA-PART',
          name: 'Oversized Frame',
          quantity: 1,
          dimensionsCm: { length: 80, width: 40, height: 20 },
          weightKg: 10,
          rotatable: true,
          fragility: 'LOW',
        },
      ],
      candidates: [makeCandidate({ id: 'xl', packageId: 'RBX-XL-1', packageClass: 'XL' })],
    });
    expect(oversized.outcome).toBe('OVERSIZED_PRODUCT');

    // Two M-sized items where no L/XL exists -> SPLIT_RECOMMENDED then ALLOCATED_SPLIT when allowSplit=true
    const twoItems = [
      {
        sku: 'SHOES',
        name: 'Sneakers Box',
        quantity: 2,
        dimensionsCm: { length: 26, width: 20, height: 12 },
        weightKg: 1.5,
        rotatable: true,
        fragility: 'LOW' as const,
      },
    ];
    const mBoxes = [
      makeCandidate({ id: 'm1', packageId: 'RBX-M-01', packageClass: 'M' }),
      makeCandidate({ id: 'm2', packageId: 'RBX-M-02', packageClass: 'M' }),
    ];

    const recommend = evaluatePackagingAllocation({
      merchantId: 'm1',
      packagingModel: 'SHARED_POOL',
      allowCrossMerchantPool: false,
      fulfilmentLocation: 'CHN-HUB-01',
      currency: 'USD',
      allowSplit: false,
      items: twoItems,
      candidates: mBoxes,
    });
    expect(recommend.outcome).toBe('SPLIT_RECOMMENDED');
    expect(recommend.recommendedSplitGroups).toHaveLength(2);

    const splitAllocated = evaluatePackagingAllocation({
      merchantId: 'm1',
      packagingModel: 'SHARED_POOL',
      allowCrossMerchantPool: false,
      fulfilmentLocation: 'CHN-HUB-01',
      currency: 'USD',
      allowSplit: true,
      items: twoItems,
      candidates: mBoxes,
    });
    expect(splitAllocated.outcome).toBe('ALLOCATED_SPLIT');
    expect(splitAllocated.selectedPackages).toHaveLength(2);
    expect(splitAllocated.totalDeposit).toBe(10); // 2 x $5.00 USD
  });

  it('computes configurable deposits bounded by replacement value', () => {
    const usdStd = calculateConfiguredDeposit({ packageClass: 'L', currency: 'USD', depositMultiplier: 1.5 });
    expect(usdStd.amount).toBe(12); // $8 * 1.5 = $12 (<= $32 replacement)
    expect(usdStd.breakdown.ruleVersion).toBe('v2.0-deterministic');

    const capped = calculateConfiguredDeposit({ packageClass: 'S', currency: 'INR', depositMultiplier: 2.5 });
    expect(capped.amount).toBe(100); // 50 * 2.5 = 125 capped at 100 replacementValue
  });
});

