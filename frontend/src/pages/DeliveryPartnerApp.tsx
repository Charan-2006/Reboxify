import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { getPackagePassport, listMyAssignedPackages } from '../api/phase4';
import { collectReturn, listReturns } from '../api/phase5';
import { TruckIcon } from '../components/Icons';
import { PackageScannerPanel } from '../components/PackageScannerPanel';
import { PassportViewerModal } from '../components/PassportViewerModal';
import { ReturnDetailModal } from '../components/ReturnDetailModal';
import { ReturnEvidenceUploader } from '../components/ReturnEvidenceUploader';
import { SystemStatusBanner } from '../components/SystemStatusBanner';
import { useAuth } from '../contexts/AuthContext';
import {
  DigitalPassportView,
  PackageDto,
  ReturnDto,
  ScanAction,
} from '../types/domain';

const PARTNER_SCAN_ACTIONS: Array<{ action: ScanAction; label: string }> = [
  { action: 'DISPATCH', label: 'DISPATCH — Pickup & Custody Transfer (Payment-Gated)' },
  { action: 'DELIVER', label: 'DELIVER — Confirm Handover to Customer' },
  { action: 'COLLECT_RETURN', label: 'COLLECT_RETURN — Pickup Customer Return Box' },
];

const DeliveryPartnerApp: React.FC = () => {
  const navigate = useNavigate();
  const { session, logout } = useAuth();
  const user = session.user;

  const [assignedPackages, setAssignedPackages] = useState<PackageDto[]>([]);
  const [assignedReturns, setAssignedReturns] = useState<ReturnDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedPackageId, setSelectedPackageId] = useState('');

  const [collectQrTokens, setCollectQrTokens] = useState<Record<string, string>>({});
  const [collectBusyId, setCollectBusyId] = useState<string | null>(null);

  const [passportModal, setPassportModal] = useState<DigitalPassportView | null>(null);
  const [passportLoading, setPassportLoading] = useState(false);
  const [passportError, setPassportError] = useState<string | null>(null);
  const [selectedReturnModal, setSelectedReturnModal] = useState<ReturnDto | null>(null);

  const loadAssigned = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pkgRes, retRes] = await Promise.all([
        listMyAssignedPackages({ pageSize: 50 }),
        listReturns({ pageSize: 50 }),
      ]);
      setAssignedPackages(pkgRes.items);
      setAssignedReturns(retRes.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load assigned tasks.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'DELIVERY_PARTNER') {
      void loadAssigned();
    }
  }, [user, loadAssigned]);

  if (!user || user.role !== 'DELIVERY_PARTNER') {
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
      setPassportError(err instanceof ApiError ? err.message : 'Failed to load passport.');
    } finally {
      setPassportLoading(false);
    }
  };

  const handleCollectReturn = async (ret: ReturnDto) => {
    const qrToken = collectQrTokens[ret.id]?.trim();
    if (!qrToken) {
      setError('Paste or scan the signed RBXQR token on the return box before confirming collection.');
      return;
    }
    setCollectBusyId(ret.id);
    setError(null);
    setNotice(null);
    try {
      const scanId = `ret_collect_${ret.id}_${Date.now()}`;
      const res = await collectReturn(ret.id, {
        scanMode: 'QR_TOKEN',
        qrToken,
        scanId,
        locationRef: ret.returnMethodDetails?.serviceZone || 'Doorstep / Locker',
      });
      setNotice(
        `Collected return ${res.returnRecord.returnNumber} (${res.returnRecord.packageId} -> COLLECTED).`
      );
      await loadAssigned();
    } catch (err) {
      setError(err instanceof ApiError ? `[${err.code}] ${err.message}` : 'Collection scan failed.');
    } finally {
      setCollectBusyId(null);
    }
  };

  return (
    <div className="min-h-screen bg-orange-50/30 dark:bg-[#020617] text-slate-900 dark:text-slate-100">
      <header className="bg-white dark:bg-slate-900 border-b border-orange-100 dark:border-white/10 px-6 py-4 sticky top-0 z-30">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => navigate('/')}>
            <div className="w-10 h-10 bg-orange-600 rounded-xl flex items-center justify-center text-white">
              <TruckIcon />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight">Delivery Partner App</h1>
              <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                {user.name} · {user.email}
              </p>
            </div>
          </div>

          <button
            onClick={() => void logout()}
            className="px-4 py-2 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-rose-600 dark:hover:bg-rose-500 dark:hover:text-white transition-colors"
          >
            Sign Out
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-6 space-y-6">
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

        <PackageScannerPanel
          title="Authorised Delivery & Collection QR Scanner"
          subtitle="Verify signed HMAC QR tokens for dispatch custody handover and customer delivery confirmation. Scans enforce your partner assignment and payment capture."
          allowedActions={PARTNER_SCAN_ACTIONS}
          initialPackageId={selectedPackageId}
          onScanComplete={() => void loadAssigned()}
          onViewPassport={(pkgId) => void handleOpenPassport(pkgId)}
        />

        <section className="p-6 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-black">
              Assigned Return Collections &amp; Swaps ({assignedReturns.length})
            </h2>
            <button
              type="button"
              onClick={() => void loadAssigned()}
              className="text-xs font-bold text-indigo-600 hover:underline"
            >
              Refresh
            </button>
          </div>

          {assignedReturns.length === 0 ? (
            <p className="text-sm text-slate-400">
              No return collections currently assigned to you.
            </p>
          ) : (
            <div className="space-y-4">
              {assignedReturns.map((ret) => (
                <div
                  key={ret.id}
                  className="p-4 rounded-2xl border border-slate-200 dark:border-white/10 space-y-2.5 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-black text-sm">
                      {ret.returnNumber} · {ret.packageId}
                    </span>
                    <span className="px-2.5 py-0.5 rounded-full font-mono font-bold bg-teal-500/10 text-teal-700 dark:text-teal-300">
                      {ret.status}
                    </span>
                  </div>
                  <p className="text-slate-500">
                    Mode: <b>{ret.mode}</b> · Zone:{' '}
                    {ret.returnMethodDetails?.serviceZone || ret.returnMethodDetails?.dropoffLocationLabel || '—'}
                  </p>
                  {ret.returnMethodDetails?.addressSummary && (
                    <p className="text-slate-500">Address: {ret.returnMethodDetails.addressSummary}</p>
                  )}

                  {(ret.status === 'PICKUP_SCHEDULED' || ret.status === 'DROP_OFF_SELECTED') && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <input
                        placeholder="Signed RBXQR:v1... token from package label"
                        value={collectQrTokens[ret.id] ?? ''}
                        onChange={(e) =>
                          setCollectQrTokens((prev) => ({ ...prev, [ret.id]: e.target.value }))
                        }
                        className="flex-1 min-w-[220px] px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 font-mono"
                      />
                      <button
                        type="button"
                        disabled={collectBusyId === ret.id}
                        onClick={() => void handleCollectReturn(ret)}
                        className="px-3 py-1.5 rounded-lg bg-orange-600 text-white font-bold disabled:opacity-50"
                      >
                        {collectBusyId === ret.id ? 'Verifying QR...' : 'Confirm Return Collection'}
                      </button>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedReturnModal(ret)}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 font-bold"
                    >
                      View Return Details
                    </button>
                    <ReturnEvidenceUploader
                      returnId={ret.id}
                      onUploaded={() => void loadAssigned()}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="p-6 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-black">
              My Assigned Reusable Packages ({assignedPackages.length})
            </h2>
          </div>

          {loading ? (
            <p className="text-sm text-slate-400">Loading assigned deliveries...</p>
          ) : assignedPackages.length === 0 ? (
            <p className="text-sm text-slate-400">
              No packages currently assigned to your partner account. Merchants or administrators assign you before dispatch.
            </p>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {assignedPackages.map((pkg) => (
                <div
                  key={pkg.id}
                  className="p-4 rounded-2xl border border-slate-200 dark:border-white/10 space-y-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-black text-sm">{pkg.packageId}</span>
                    <span className="px-2.5 py-0.5 rounded-full font-mono font-bold bg-orange-500/10 text-orange-700 dark:text-orange-300">
                      {pkg.status}
                    </span>
                  </div>
                  <p className="text-slate-500">
                    Class {pkg.packageClass} · Location: {pkg.fulfilmentLocation}
                  </p>
                  <p className="text-slate-500">
                    Custodian: {pkg.currentCustodian.custodianType} — {pkg.currentCustodian.label}
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setSelectedPackageId(pkg.packageId)}
                      className="px-3 py-1.5 rounded-lg bg-orange-600 text-white font-bold"
                    >
                      Select to Scan
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleOpenPassport(pkg.packageId)}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 font-bold"
                    >
                      View Passport
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="bg-white dark:bg-white/[0.03] p-6 rounded-3xl border border-slate-200 dark:border-white/10 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-black">Assigned Pickup Slots &amp; Schedule Sync</h2>
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest bg-amber-500/10 text-amber-700 dark:text-amber-400">
              Pending Phase 7 API
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            Scheduled customer return pickup slots, Bryntum-compatible time windows, and doorstep exception reporting connect via <code className="font-mono">GET /api/pickups</code> in Phase 7.
          </p>
        </div>
      </main>

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

export default DeliveryPartnerApp;
