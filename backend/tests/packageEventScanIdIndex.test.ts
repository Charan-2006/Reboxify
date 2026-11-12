import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PackageEventModel } from '../src/models/PackageEvent.js';

/**
 * Simulates MongoDB's unique index evaluation on serialized Mongoose PackageEvent documents
 * so index semantics are verified locally when live mongod/Docker is unavailable.
 */
class MongoUniqueIndexSimulator {
  private readonly keys = new Set<string>();

  constructor(private readonly mode: 'PARTIAL_SCAN_ID_EXISTS' | 'LEGACY_COMPOUND_SPARSE') {}

  insert(docObject: Record<string, unknown>): void {
    const pkgId = String(docObject.packageId ?? '').toUpperCase();
    const hasScanIdProp = Object.prototype.hasOwnProperty.call(docObject, 'scanId');

    if (this.mode === 'LEGACY_COMPOUND_SPARSE') {
      // Compound sparse indexes only skip documents where EVERY indexed field is missing/null.
      // Because packageId is required on PackageEvent, every doc is indexed with (packageId, null).
      const compositeKey = `${pkgId}::${hasScanIdProp ? String(docObject.scanId) : '__MISSING_OR_NULL__'}`;
      if (this.keys.has(compositeKey)) {
        const err = new Error(`E11000 duplicate key error index: packageId_1_scanId_1 dup key: { packageId: "${pkgId}", scanId: null }`) as Error & { code?: number };
        err.code = 11000;
        throw err;
      }
      this.keys.add(compositeKey);
      return;
    }

    // Partial index: partialFilterExpression: { scanId: { $exists: true } }
    // Documents omitting scanId ($exists: false) are excluded from unique key enforcement.
    if (!hasScanIdProp) {
      return;
    }

    const compositeKey = `${pkgId}::${String(docObject.scanId)}`;
    if (this.keys.has(compositeKey)) {
      const err = new Error(`E11000 duplicate key error index: packageId_1_scanId_1 dup key: { packageId: "${pkgId}", scanId: "${String(docObject.scanId)}" }`) as Error & { code?: number };
      err.code = 11000;
      throw err;
    }
    this.keys.add(compositeKey);
  }
}

function buildSerializedEvent(input: {
  packageId: string;
  type: string;
  scanId?: string | null;
}) {
  const modelDoc = new PackageEventModel({
    eventId: `evt_${crypto.randomUUID()}`,
    packageId: input.packageId,
    type: input.type,
    actor: { userId: 'user-1', role: 'MERCHANT_ADMIN' },
    outcome: 'ACCEPTED',
    evidence: [],
    ...(input.scanId !== undefined ? { scanId: input.scanId } : {}),
  });

  const validationError = modelDoc.validateSync();
  expect(validationError).toBeUndefined();
  return modelDoc.toObject({ depopulate: true }) as unknown as Record<string, unknown>;
}

describe('PackageEvent { packageId: 1, scanId: 1 } partial unique index regression suite', () => {
  it('declares { packageId: 1, scanId: 1 } with unique: true and partialFilterExpression: { scanId: { $exists: true } } (never sparse: true)', () => {
    const indexes = PackageEventModel.schema.indexes();
    const scanIdx = indexes.find(
      ([spec]) => spec.packageId === 1 && spec.scanId === 1
    );

    expect(scanIdx).toBeDefined();
    const [, options] = scanIdx!;
    expect(options.unique).toBe(true);
    expect(options.sparse).toBeUndefined();
    expect(options.partialFilterExpression).toEqual({
      scanId: { $exists: true },
    });
  });

  it('omits scanId from serialized Mongoose documents when absent, null, or whitespace-only', () => {
    const omitted = buildSerializedEvent({ packageId: 'RBX-CHN-001', type: 'PACKAGE_CREATED' });
    const explicitUndef = buildSerializedEvent({ packageId: 'RBX-CHN-001', type: 'PACKAGE_RESERVED', scanId: undefined });
    const explicitNull = buildSerializedEvent({ packageId: 'RBX-CHN-001', type: 'LABEL_REPRINTED', scanId: null });
    const blankStr = buildSerializedEvent({ packageId: 'RBX-CHN-001', type: 'QR_TOKEN_REVOKED', scanId: '   ' });
    const validScan = buildSerializedEvent({ packageId: 'RBX-CHN-001', type: 'PACKAGE_PACKED', scanId: '  scan-xyz-1  ' });

    expect(Object.prototype.hasOwnProperty.call(omitted, 'scanId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(explicitUndef, 'scanId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(explicitNull, 'scanId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(blankStr, 'scanId')).toBe(false);
    expect(validScan.scanId).toBe('scan-xyz-1');
  });

  it('proves legacy compound sparse index failed on 2nd event without scanId, while partial unique index permits multiple events on the same and different packages', () => {
    const evt1SamePkg = buildSerializedEvent({ packageId: 'RBX-CHN-001', type: 'PACKAGE_CREATED' });
    const evt2SamePkg = buildSerializedEvent({ packageId: 'RBX-CHN-001', type: 'PACKAGE_RESERVED' });
    const evt3SamePkgNull = buildSerializedEvent({ packageId: 'RBX-CHN-001', type: 'LABEL_REPRINTED', scanId: null });
    const evtDiffPkg1 = buildSerializedEvent({ packageId: 'RBX-CHN-002', type: 'PACKAGE_CREATED' });
    const evtDiffPkg2 = buildSerializedEvent({ packageId: 'RBX-CHN-002', type: 'SCAN_REJECTED' });

    // 1. Legacy compound sparse index rejects the 2nd event for RBX-CHN-001
    const legacySim = new MongoUniqueIndexSimulator('LEGACY_COMPOUND_SPARSE');
    legacySim.insert(evt1SamePkg);
    expect(() => legacySim.insert(evt2SamePkg)).toThrow(/E11000/);

    // 2. Corrected partial unique index allows unlimited omitted-scanId events for same & different packages
    const partialSim = new MongoUniqueIndexSimulator('PARTIAL_SCAN_ID_EXISTS');
    expect(() => {
      partialSim.insert(evt1SamePkg);
      partialSim.insert(evt2SamePkg);
      partialSim.insert(evt3SamePkgNull);
      partialSim.insert(evtDiffPkg1);
      partialSim.insert(evtDiffPkg2);
    }).not.toThrow();
  });

  it('enforces uniqueness for non-null scanId values per package while allowing distinct scanIds on the same package and identical scanId across different packages', () => {
    const partialSim = new MongoUniqueIndexSimulator('PARTIAL_SCAN_ID_EXISTS');

    const scanA1 = buildSerializedEvent({
      packageId: 'RBX-CHN-001',
      type: 'PACKAGE_PACKED',
      scanId: 'scan-001',
    });
    const scanA1Duplicate = buildSerializedEvent({
      packageId: 'RBX-CHN-001',
      type: 'PACKAGE_PACKED',
      scanId: 'scan-001',
    });
    const scanA2Different = buildSerializedEvent({
      packageId: 'RBX-CHN-001',
      type: 'PACKAGE_DISPATCHED',
      scanId: 'scan-002',
    });
    const scanB1DifferentPkgSameScanId = buildSerializedEvent({
      packageId: 'RBX-CHN-002',
      type: 'PACKAGE_PACKED',
      scanId: 'scan-001',
    });

    partialSim.insert(scanA1);
    partialSim.insert(scanA2Different);
    partialSim.insert(scanB1DifferentPkgSameScanId);

    expect(() => partialSim.insert(scanA1Duplicate)).toThrow(/E11000/);
  });
});

