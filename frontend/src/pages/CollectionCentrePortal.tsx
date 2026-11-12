import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { listInventory } from '../api/phase2';
import {
  getPackagePassport,
  listDeliveryPartners,
  reprintQrLabel,
  revokeQrToken,
} from '../api/phase4';
import {
  approveReturnRefund,
  assignReturnPartner,
  inspectReturn,
  listReturns,
  receiveReturnAtCentre,
  reconcileReturnRefund,
  rejectReturn,
} from '../api/phase5';
import { CentreIcon } from '../components/Icons';
import { PackageScannerPanel } from '../components/PackageScannerPanel';
import { PassportViewerModal } from '../components/PassportViewerModal';
import { QrLabelModal } from '../components/QrLabelModal';
import { ReturnDetailModal } from '../components/ReturnDetailModal';
import { ReturnEvidenceUploader } from '../components/ReturnEvidenceUploader';
import { SystemStatusBanner } from '../components/SystemStatusBanner';
import { useAuth } from '../contexts/AuthContext';
import {
  DeliveryPartnerSummary,
  DigitalPassportView,
  InspectionCondition,
  PackageDto,
  QrLabelData,
  ReturnDto,
  ScanAction,
} from '../types/domain';

const CENTRE_SCAN_ACTIONS: Array<{ action: ScanAction; label: string }> = [
  { action: 'RECEIVE_CENTRE', label: 'RECEIVE_CENTRE — Intake Package at Collection Centre' },
  { action: 'INSPECT_PASS', label: 'INSPECT_PASS — Mark Structural Inspection Passed' },
  { action: 'MARK_CLEANING', label: 'MARK_CLEANING — Route Package to Cleaning' },
  { action: 'RELEASE_AVAILABLE', label: 'RELEASE_AVAILABLE — Release Cleaned Box to Inventory' },
  { action: 'QUARANTINE', label: 'QUARANTINE — Hold Damaged or Contaminated Box' },
];

const CONDITION_OPTIONS: Array<{ value: InspectionCondition; label: string }> = [
  { value: 'GOOD', label: 'GOOD — Clean & Intact (100% Refund)' },
  { value: 'MINOR_WEAR', label: 'MINOR_WEAR — Normal Wear (100% Refund)' },
  { value: 'MINOR_DAMAGE', label: 'MINOR_DAMAGE — Repairable Damage (50% Refund, Review)' },
  { value: 'MAJOR_DAMAGE', label: 'MAJOR_DAMAGE — Severe Fracture/Broken (0% Refund)' },
  { value: 'CONTAMINATED', label: 'CONTAMINATED — Spill/Chemical Contamination (0% Refund)' },
  { value: 'MISSING_PACKAGING', label: 'MISSING_PACKAGING — Box Not Returned (0% Refund)' },
  { value: 'UNUSABLE', label: 'UNUSABLE — Beyond Repair Write-Off (0% Refund)' },
  { value: 'WRONG_PACKAGE', label: 'WRONG_PACKAGE — Identity Mismatch Hold (0% Refund)' },
];

const CollectionCentrePortal: React.FC = () => {
  const navigate = useNavigate();
  const { session, logout } = useAuth();
  const user = session.user;

  const [inventory, setInventory] = useState<PackageDto[]>([]);
  const [returnsList, setReturnsList] = useState<ReturnDto[]>([]);
  const [partners, setPartners] = useState<DeliveryPartnerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedPackageId, setSelectedPackageId] = useState('');

  const [receiveQrInputs, setReceiveQrInputs] = useState<Record<string, string>>({});
  const [receiveManualReasons, setReceiveManualReasons] = useState<Record<string, string>>({});
  const [inspectFormTarget, setInspectFormTarget] = useState<ReturnDto | null>(null);
  const [inspectCondition, setInspectCondition] = useState<InspectionCondition>('GOOD');
  const [inspectChecklist, setInspectChecklist] = useState({
    identityVerified: true,
    structuralIntegrity: true,
    cleanlinessAcceptable: true,
    completeComponents: true,
  });
  const [inspectDamageReason, setInspectDamageReason] = useState('');
  const [inspectNotes, setInspectNotes] = useState('');
  const [inspectDisputed, setInspectDisputed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [activeLabel, setActiveLabel] = useState<QrLabelData | null>(null);
  const [passportModal, setPassportModal] = useState<DigitalPassportView | null>(null);
  const [passportLoading, setPassportLoading] = useState(false);
  const [passportError, setPassportError] = useState<string | null>(null);
  const [selectedReturnModal, setSelectedReturnModal] = useState<ReturnDto | null>(null);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [invRes, retRes, partnerRes] = await Promise.all([
        listInventory({ pageSize: 50 }),
        listReturns({ pageSize: 50 }),
        listDeliveryPartners().catch(() => ({ partners: [] })),
      ]);
      setInventory(invRes.items);
      setReturnsList(retRes.items);
      setPartners(partnerRes.partners);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load collection centre workspace.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'COLLECTION_CENTRE') {
      void loadWorkspace();
    }
  }, [user, loadWorkspace]);

  if (!user || user.role !== 'COLLECTION_CENTRE') {
    return null;
  }

  const handleOpenPassport = async (packageId: string) => {
    setPassportModal(null);
    setPassportError(null);
    setPassportLoading(true);
    try {
      const res = await getPackagePassport(packageId);
      setPassportModal(res.passport);
    } catch (err) {
      setPassportError(err instanceof ApiError ? err.message : 'Could not load passport.');
    } finally {
      setPassportLoading(false);
    }
  };

  const handleReceiveReturn = async (ret: ReturnDto) => {
    const qrToken = receiveQrInputs[ret.id]?.trim();
    const manualReason = receiveManualReasons[ret.id]?.trim();
    if (!qrToken && (!manualReason || manualReason.length < 8)) {
      setError(
        'Provide a signed RBXQR token or enter a supervised manual reason (min 8 chars) to confirm return receipt.'
      );
      return;
    }
    setBusyId(ret.id);
    setError(null);
    setNotice(null);
    try {
      const scanId = `centre_recv_${ret.id}_${Date.now()}`;
      const res = await receiveReturnAtCentre(ret.id, {
        scanMode: qrToken ? 'QR_TOKEN' : 'MANUAL_SUPERVISED',
        qrToken: qrToken || undefined,
        manualReason: qrToken ? undefined : manualReason,
        scanId,
        locationRef: 'Collection Centre Intake Bay',
      });
      setNotice(
        `Received ${res.returnRecord.returnNumber} at centre (${res.returnRecord.status}). Ready for inspection.`
      );
      await loadWorkspace();
    } catch (err) {
      setError(err instanceof ApiError ? `[${err.code}] ${err.message}` : 'Failed to record receipt.');
    } finally {
      setBusyId(null);
    }
  };

  const handleSubmitInspection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inspectFormTarget) return;
    setBusyId(inspectFormTarget.id);
    setError(null);
    setNotice(null);
    try {
      const res = await inspectReturn(inspectFormTarget.id, {
        condition: inspectCondition,
        checklist: inspectChecklist,
        damageReason: inspectDamageReason.trim() || undefined,
        notes: inspectNotes.trim() || undefined,
        disputed: inspectDisputed,
      });
      setNotice(
        `Inspection saved for ${res.returnRecord.returnNumber}: ${res.returnRecord.inspection?.outcome} — Backend calculated ${res.returnRecord.refundEligibility.currency} ${res.returnRecord.refundEligibility.calculatedAmount.toFixed(2)}.`
      );
      setInspectFormTarget(null);
      setInspectDamageReason('');
      setInspectNotes('');
      setInspectDisputed(false);
      await loadWorkspace();
    } catch (err) {
      setError(err instanceof ApiError ? `[${err.code}] ${err.message}` : 'Inspection submission failed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleApproveAndRefund = async (ret: ReturnDto) => {
    setBusyId(ret.id);
    setError(null);
    setNotice(null);
    try {
      const res = await approveReturnRefund(ret.id);
      setNotice(res.message);
      await loadWorkspace();
    } catch (err) {
      setError(err instanceof ApiError ? `[${err.code}] ${err.message}` : 'Refund approval failed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleReconcile = async (ret: ReturnDto) => {
    setBusyId(ret.id);
    setError(null);
    setNotice(null);
    try {
      const res = await reconcileReturnRefund(ret.id);
      setNotice(res.message);
      await loadWorkspace();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Refund reconciliation failed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (ret: ReturnDto) => {
    setBusyId(ret.id);
    setError(null);
    setNotice(null);
    try {
      await rejectReturn(ret.id, 'Rejected at collection centre following physical inspection');
      setNotice(`Return ${ret.returnNumber} rejected.`);
      await loadWorkspace();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rejection failed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleAssignPartner = async (returnId: string, partnerId: string) => {
    if (!partnerId) return;
    setBusyId(returnId);
    setError(null);
    setNotice(null);
    try {
      await assignReturnPartner(returnId, partnerId);
      setNotice('Assigned return collection partner.');
      await loadWorkspace();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Partner assignment failed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleReprint = async (packageId: string) => {
    setError(null);
    setNotice(null);
    try {
      const res = await reprintQrLabel(packageId, 'Collection centre thermal label replacement');
      setActiveLabel(res.label);
      setNotice(`Reprinted QR identity for ${packageId} (v${res.qrPayload.tokenVersion}). Prior token invalidated.`);
      await loadWorkspace();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reprint QR label.');
    }
  };

  const handleRevoke = async (packageId: string) => {
    setError(null);
    setNotice(null);
    try {
      await revokeQrToken(packageId, 'Damaged or tampered physical label flagged at centre');
      setNotice(`Revoked active QR token for ${packageId}. Further scans are blocked until reissued.`);
      await loadWorkspace();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to revoke QR token.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#020617] text-slate-900 dark:text-slate-100">
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-white/10 px-6 py-4 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 cursor-pointer" onClick={() => navigate('/')}>
            <div className="w-11 h-11 bg-teal-600 rounded-2xl flex items-center justify-center text-white shadow-lg">
              <CentreIcon />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight">Collection Centre Portal</h1>
              <p className="text-[10px] font-bold uppercase tracking-widest text-teal-600 dark:text-teal-400">
                {user.email} · {user.role}
              </p>
            </div>
          </div>
          <button
            onClick={() => void logout()}
            className="px-5 py-2.5 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-rose-600 dark:hover:bg-rose-500 dark:hover:text-white transition-colors"
          >
            Sign Out
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 md:p-10 space-y-8">
        <SystemStatusBanner />

        {error && (
          <div className="p-4 rounded-2xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-sm text-red-700 dark:text-red-300 font-semibold">
            {error}
          </div>
        )}
        {notice && (
          <div className="p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-sm text-emerald-700 dark:text-emerald-300 font-semibold">
            {notice}
          </div>
        )}

        <section className="p-6 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-black">
                Returns Intake, Inspection &amp; PayPal Partial Refund Queue ({returnsList.length})
              </h2>
              <p className="text-xs text-slate-500">
                Verify arrival via QR, complete condition inspection, upload GridFS photos, and trigger deterministic PayPal capture refunds.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadWorkspace()}
              className="text-xs font-bold text-indigo-600 hover:underline"
            >
              Refresh Queue
            </button>
          </div>

          {returnsList.length === 0 ? (
            <p className="text-sm text-slate-400">No return requests in the queue yet.</p>
          ) : (
            <div className="space-y-4">
              {returnsList.map((ret) => (
                <div
                  key={ret.id}
                  className="p-4 rounded-2xl border border-slate-200 dark:border-white/10 space-y-3 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-mono font-black text-sm">
                        {ret.returnNumber} · {ret.packageId}
                      </span>
                      <span className="ml-2 text-slate-500">Mode: {ret.mode}</span>
                      {ret.isLateReturn && (
                        <span className="ml-2 px-2 py-0.5 rounded bg-amber-500/15 text-amber-700 font-bold">
                          Late +{ret.daysLate}d
                        </span>
                      )}
                    </div>
                    <span className="px-2.5 py-0.5 rounded-full font-mono font-bold bg-teal-500/10 text-teal-700 dark:text-teal-300">
                      {ret.status}
                    </span>
                  </div>

                  <p className="text-slate-500">
                    Deposit Cap: <b>{ret.refundEligibility.currency} {ret.refundEligibility.originalDeposit.toFixed(2)}</b> · Calculated Refund:{' '}
                    <b>{ret.refundEligibility.currency} {ret.refundEligibility.calculatedAmount.toFixed(2)}</b>{' '}
                    ({ret.refundEligibility.reason})
                  </p>

                  {['REQUESTED', 'PICKUP_SCHEDULED', 'DROP_OFF_SELECTED', 'COLLECTED'].includes(ret.status) && (
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] grid sm:grid-cols-3 gap-2 items-center">
                      <input
                        placeholder="Signed RBXQR:v1... token"
                        value={receiveQrInputs[ret.id] ?? ''}
                        onChange={(e) =>
                          setReceiveQrInputs((prev) => ({ ...prev, [ret.id]: e.target.value }))
                        }
                        className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
                      />
                      <input
                        placeholder="Or supervised manual reason (min 8 chars)"
                        value={receiveManualReasons[ret.id] ?? ''}
                        onChange={(e) =>
                          setReceiveManualReasons((prev) => ({ ...prev, [ret.id]: e.target.value }))
                        }
                        className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                      />
                      <button
                        type="button"
                        disabled={busyId === ret.id}
                        onClick={() => void handleReceiveReturn(ret)}
                        className="px-3 py-1.5 rounded-lg bg-teal-600 text-white font-bold disabled:opacity-50"
                      >
                        Receive at Centre
                      </button>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedReturnModal(ret)}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 font-bold"
                    >
                      Details &amp; Refund Ledger
                    </button>

                    {partners.length > 0 && (ret.status === 'PICKUP_SCHEDULED' || ret.status === 'DROP_OFF_SELECTED') && (
                      <select
                        defaultValue=""
                        onChange={(e) => void handleAssignPartner(ret.id, e.target.value)}
                        className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                      >
                        <option value="">Assign Collection Partner...</option>
                        {partners.map((pt) => (
                          <option key={pt.id} value={pt.id}>
                            {pt.name}
                          </option>
                        ))}
                      </select>
                    )}

                    {['RECEIVED', 'UNDER_INSPECTION', 'NEEDS_REVIEW'].includes(ret.status) && !ret.refundId && (
                      <button
                        type="button"
                        onClick={() => {
                          setInspectFormTarget(ret);
                          setInspectCondition('GOOD');
                          setInspectChecklist({
                            identityVerified: true,
                            structuralIntegrity: true,
                            cleanlinessAcceptable: true,
                            completeComponents: true,
                          });
                        }}
                        className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold"
                      >
                        {ret.inspection ? 'Update Inspection' : 'Run Inspection Checklist'}
                      </button>
                    )}

                    {ret.inspection && ['UNDER_INSPECTION', 'NEEDS_REVIEW'].includes(ret.status) && (
                      <>
                        <button
                          type="button"
                          disabled={busyId === ret.id}
                          onClick={() => void handleApproveAndRefund(ret)}
                          className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-bold disabled:opacity-50"
                        >
                          Approve &amp; Issue PayPal Refund
                        </button>
                        <button
                          type="button"
                          disabled={busyId === ret.id}
                          onClick={() => void handleReject(ret)}
                          className="px-3 py-1.5 rounded-lg bg-rose-600 text-white font-bold disabled:opacity-50"
                        >
                          Reject Refund
                        </button>
                      </>
                    )}

                    {ret.status === 'APPROVED' && ret.refundId && (
                      <button
                        type="button"
                        disabled={busyId === ret.id}
                        onClick={() => void handleReconcile(ret)}
                        className="px-3 py-1.5 rounded-lg bg-amber-600 text-white font-bold disabled:opacity-50"
                      >
                        Reconcile / Retry PayPal Refund
                      </button>
                    )}

                    <ReturnEvidenceUploader
                      returnId={ret.id}
                      onUploaded={() => void loadWorkspace()}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {inspectFormTarget && (
            <form
              onSubmit={handleSubmitInspection}
              className="p-5 rounded-2xl border-2 border-indigo-500/40 bg-indigo-50/40 dark:bg-indigo-950/20 space-y-4 text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-black text-sm">
                  Inspection Checklist: {inspectFormTarget.returnNumber} ({inspectFormTarget.packageId})
                </h3>
                <button
                  type="button"
                  onClick={() => setInspectFormTarget(null)}
                  className="px-2.5 py-1 rounded-lg bg-slate-200 dark:bg-slate-800 font-bold"
                >
                  Cancel
                </button>
              </div>
              <p className="text-slate-500">
                Backend rules deterministically compute deduction breakdown and deposit refund amount (max{' '}
                {inspectFormTarget.refundEligibility.currency}{' '}
                {inspectFormTarget.refundEligibility.originalDeposit.toFixed(2)}).
              </p>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold uppercase text-[10px] text-slate-500 mb-1">
                    Physical Condition Category
                  </label>
                  <select
                    value={inspectCondition}
                    onChange={(e) => setInspectCondition(e.target.value as InspectionCondition)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  >
                    {CONDITION_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-bold uppercase text-[10px] text-slate-500 mb-1">
                    Damage / Condition Reason
                  </label>
                  <input
                    placeholder="Specific defect or normal wear note"
                    value={inspectDamageReason}
                    onChange={(e) => setInspectDamageReason(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
                {(
                  [
                    ['identityVerified', 'QR/Package Identity Verified'],
                    ['structuralIntegrity', 'Structural Integrity OK'],
                    ['cleanlinessAcceptable', 'Cleanliness Acceptable'],
                    ['completeComponents', 'Lid & Components Complete'],
                  ] as const
                ).map(([field, label]) => (
                  <label key={field} className="flex items-center gap-2 font-semibold">
                    <input
                      type="checkbox"
                      checked={inspectChecklist[field]}
                      onChange={(e) =>
                        setInspectChecklist((prev) => ({ ...prev, [field]: e.target.checked }))
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>

              <div className="grid sm:grid-cols-2 gap-3 items-center">
                <input
                  placeholder="Inspector notes..."
                  value={inspectNotes}
                  onChange={(e) => setInspectNotes(e.target.value)}
                  className="px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
                <label className="flex items-center gap-2 font-bold text-amber-700 dark:text-amber-300">
                  <input
                    type="checkbox"
                    checked={inspectDisputed}
                    onChange={(e) => setInspectDisputed(e.target.checked)}
                  />
                  Flag Dispute for Human Review
                </label>
              </div>

              <button
                type="submit"
                disabled={busyId === inspectFormTarget.id}
                className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white font-black uppercase tracking-widest disabled:opacity-50"
              >
                Save Deterministic Inspection
              </button>
            </form>
          )}
        </section>

        <PackageScannerPanel
          title="Collection Centre Intake, Cleaning & Recirculation Scanner"
          subtitle="Verify signed QR tokens or supervised fallback when receiving returned containers, marking inspections, cleaning, quarantine, or releasing to AVAILABLE (verified reuse count + 1)."
          allowedActions={CENTRE_SCAN_ACTIONS}
          initialPackageId={selectedPackageId}
          onScanComplete={() => void loadWorkspace()}
          onViewPassport={(pkgId) => void handleOpenPassport(pkgId)}
        />

        <section className="p-6 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-black">Network Packages &amp; QR Credential Controls ({inventory.length})</h2>
            <button
              type="button"
              onClick={() => void loadWorkspace()}
              className="text-xs font-bold text-indigo-600 hover:underline"
            >
              Refresh Inventory
            </button>
          </div>
          {loading ? (
            <p className="text-sm text-slate-400">Loading packages...</p>
          ) : inventory.length === 0 ? (
            <p className="text-sm text-slate-400">No packages found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase text-slate-400 border-b border-slate-200 dark:border-white/10">
                    <th className="py-2 pr-4">Package ID</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Custodian</th>
                    <th className="py-2 pr-4">QR State</th>
                    <th className="py-2 pr-4">Reuses</th>
                    <th className="py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-white/5 text-xs">
                  {inventory.map((pkg) => (
                    <tr key={pkg.id}>
                      <td className="py-2.5 pr-4 font-mono font-bold">{pkg.packageId}</td>
                      <td className="py-2.5 pr-4 font-mono">{pkg.status}</td>
                      <td className="py-2.5 pr-4">
                        {pkg.currentCustodian.custodianType} · {pkg.currentCustodian.label}
                      </td>
                      <td className="py-2.5 pr-4 font-mono">
                        v{pkg.qrTokenVersion ?? 1} · {pkg.qrRevoked ? 'REVOKED' : 'ACTIVE'}
                      </td>
                      <td className="py-2.5 pr-4 font-mono">{pkg.reuseCount}</td>
                      <td className="py-2.5 text-right space-x-1.5 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setSelectedPackageId(pkg.packageId)}
                          className="px-2.5 py-1 rounded-lg bg-teal-600 text-white font-bold"
                        >
                          Scan
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleOpenPassport(pkg.packageId)}
                          className="px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 font-bold"
                        >
                          Passport
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleReprint(pkg.packageId)}
                          className="px-2.5 py-1 rounded-lg bg-indigo-600 text-white font-bold"
                        >
                          Reprint QR
                        </button>
                        {!pkg.qrRevoked && (
                          <button
                            type="button"
                            onClick={() => void handleRevoke(pkg.packageId)}
                            className="px-2.5 py-1 rounded-lg bg-rose-600 text-white font-bold"
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="p-6 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-2">
          <span className="inline-block px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-amber-500/10 text-amber-700 dark:text-amber-400">
            Pending Phase 7 API
          </span>
          <h2 className="text-lg font-black tracking-tight">AG Grid Operational Ledger &amp; CSV Export</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            Server-side paginated AG Grid Community cleaning/quarantine/return tables with CSV export connect in Phase 7.
          </p>
        </section>
      </main>

      <QrLabelModal label={activeLabel} onClose={() => setActiveLabel(null)} />
      <PassportViewerModal
        passport={passportModal}
        loading={passportLoading}
        error={passportError}
        onClose={() => {
          setPassportModal(null);
          setPassportError(null);
        }}
      />
      <ReturnDetailModal
        returnRecord={selectedReturnModal}
        onClose={() => setSelectedReturnModal(null)}
      />
    </div>
  );
};

export default CollectionCentrePortal;
