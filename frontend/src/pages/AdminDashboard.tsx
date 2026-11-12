import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BuildingIcon, DashboardIcon, PackageIcon } from '../components/Icons';
import { PackageScannerPanel } from '../components/PackageScannerPanel';
import { PassportViewerModal } from '../components/PassportViewerModal';
import { QrLabelModal } from '../components/QrLabelModal';
import { ReturnsManagementSection } from '../components/ReturnsManagementSection';
import { SystemStatusBanner } from '../components/SystemStatusBanner';
import { ApiError } from '../api/client';
import {
  createBusiness,
  listBusinesses,
  listInventory,
  registerPackage,
  updateBusinessStatus,
} from '../api/phase2';
import { listTransactions } from '../api/phase3';
import {
  getPackagePassport,
  listDeliveryPartners,
  reprintQrLabel,
  revokeQrToken,
} from '../api/phase4';
import { listReturns } from '../api/phase5';
import { useAuth } from '../contexts/AuthContext';
import {
  BusinessDto,
  DeliveryPartnerSummary,
  DigitalPassportView,
  OwnershipModel,
  PackageClass,
  PackageDto,
  PackageOwnerType,
  QrLabelData,
  ReturnDto,
  ScanAction,
  TransactionDto,
} from '../types/domain';

const ADMIN_SCAN_ACTIONS: Array<{ action: ScanAction; label: string }> = [
  { action: 'PACK', label: 'PACK — Reserved to Packed' },
  { action: 'DISPATCH', label: 'DISPATCH — Packed to Dispatched (Payment-Gated)' },
  { action: 'DELIVER', label: 'DELIVER — Dispatched to Customer' },
  { action: 'COLLECT_RETURN', label: 'COLLECT_RETURN — Return Requested to Collected' },
  { action: 'RECEIVE_CENTRE', label: 'RECEIVE_CENTRE — Intake at Collection Centre' },
  { action: 'INSPECT_PASS', label: 'INSPECT_PASS — Mark Passing Inspection' },
  { action: 'MARK_CLEANING', label: 'MARK_CLEANING — Route to Cleaning' },
  { action: 'RELEASE_AVAILABLE', label: 'RELEASE_AVAILABLE — Release to Inventory' },
  { action: 'QUARANTINE', label: 'QUARANTINE — Quarantine Container' },
];

const AdminDashboard: React.FC = () => {
  const navigate = useNavigate();
  const { session, logout } = useAuth();
  const user = session.user;

  const [businesses, setBusinesses] = useState<BusinessDto[]>([]);
  const [inventory, setInventory] = useState<PackageDto[]>([]);
  const [returnsList, setReturnsList] = useState<ReturnDto[]>([]);
  const [transactions, setTransactions] = useState<TransactionDto[]>([]);
  const [partners, setPartners] = useState<DeliveryPartnerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedScanPkgId, setSelectedScanPkgId] = useState('');
  const [activeLabel, setActiveLabel] = useState<QrLabelData | null>(null);
  const [passportModal, setPassportModal] = useState<DigitalPassportView | null>(null);
  const [passportLoading, setPassportLoading] = useState(false);
  const [passportError, setPassportError] = useState<string | null>(null);

  // Create business form
  const [bizForm, setBizForm] = useState({
    name: '',
    legalName: '',
    slug: '',
    ownerUserId: '',
    packagingModel: 'HYBRID' as OwnershipModel,
    currency: 'USD',
  });

  // Register package form
  const [pkgForm, setPkgForm] = useState({
    ownerType: 'REBOXIFY_POOL' as PackageOwnerType,
    ownerId: '',
    packageClass: 'M' as PackageClass,
    fulfilmentLocation: 'CHN-HUB-01',
    packageId: '',
  });
  const [lastLabel, setLastLabel] = useState<QrLabelData | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bizRes, invRes, retRes, txRes, partnerRes] = await Promise.all([
        listBusinesses({ pageSize: 50 }),
        listInventory({ pageSize: 50 }),
        listReturns({ pageSize: 50 }),
        listTransactions({ pageSize: 50 }),
        listDeliveryPartners().catch(() => ({ partners: [] })),
      ]);
      setBusinesses(bizRes.items);
      setInventory(invRes.items);
      setReturnsList(retRes.items);
      setTransactions(txRes.items);
      setPartners(partnerRes.partners);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load admin data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'ADMIN') {
      void loadAll();
    }
  }, [user, loadAll]);

  if (!user || user.role !== 'ADMIN') {
    return null;
  }

  const handleCreateBusiness = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await createBusiness({
        name: bizForm.name,
        legalName: bizForm.legalName,
        slug: bizForm.slug,
        ownerUserId: bizForm.ownerUserId.trim() || undefined,
        packagingModel: bizForm.packagingModel,
        currency: bizForm.currency,
      });
      setNotice(`Business "${res.business.name}" created (${res.business.status}).`);
      setBizForm({
        name: '',
        legalName: '',
        slug: '',
        ownerUserId: '',
        packagingModel: 'HYBRID',
        currency: 'USD',
      });
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create business.');
    }
  };

  const handleBusinessStatus = async (id: string, status: 'ACTIVE' | 'SUSPENDED') => {
    setError(null);
    setNotice(null);
    try {
      const res = await updateBusinessStatus(id, status);
      setNotice(`Business "${res.business.name}" status updated to ${res.business.status}.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Status update failed.');
    }
  };

  const handleRegisterPackage = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await registerPackage({
        ownerType: pkgForm.ownerType,
        ownerId: pkgForm.ownerType === 'REBOXIFY_POOL' ? undefined : pkgForm.ownerId || undefined,
        packageClass: pkgForm.packageClass,
        fulfilmentLocation: pkgForm.fulfilmentLocation,
        packageId: pkgForm.packageId.trim() || undefined,
      });
      setLastLabel(res.label);
      setActiveLabel(res.label);
      setSelectedScanPkgId(res.package.packageId);
      setNotice(
        `Registered ${res.package.packageClass} package ${res.package.packageId} (${res.package.ownerType}) with signed QR v${res.qrPayload.tokenVersion}.`
      );
      setPkgForm((prev) => ({ ...prev, packageId: '' }));
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Package registration failed.');
    }
  };

  const handleOpenPassport = async (packageId: string) => {
    setPassportModal(null);
    setPassportError(null);
    setPassportLoading(true);
    try {
      const res = await getPackagePassport(packageId);
      setPassportModal(res.passport);
    } catch (err) {
      setPassportError(err instanceof ApiError ? err.message : 'Unable to load passport.');
    } finally {
      setPassportLoading(false);
    }
  };

  const handleReprintQr = async (packageId: string) => {
    setError(null);
    setNotice(null);
    try {
      const res = await reprintQrLabel(packageId, 'Admin supervisory QR label reprint');
      setActiveLabel(res.label);
      setLastLabel(res.label);
      setNotice(`Reprinted QR label for ${packageId} (v${res.qrPayload.tokenVersion}). Prior versions invalidated.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reprint QR label.');
    }
  };

  const handleRevokeQr = async (packageId: string) => {
    setError(null);
    setNotice(null);
    try {
      await revokeQrToken(packageId, 'Revoked by ReBoxify network admin');
      setNotice(`Revoked active QR token for ${packageId}.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to revoke QR token.');
    }
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] dark:bg-[#0f172a] text-slate-900 dark:text-slate-100">
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-4 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto flex justify-between items-center gap-4">
          <div className="flex items-center gap-4 cursor-pointer" onClick={() => navigate('/')}>
            <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center text-white">
              <DashboardIcon />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">ReBoxify Admin Console</h1>
              <p className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">
                {user.email} · {user.role}
              </p>
            </div>
          </div>

          <button
            onClick={() => void logout()}
            className="px-5 py-2 text-xs font-bold text-slate-600 dark:text-slate-300 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-lg transition-all"
          >
            Sign Out
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 md:p-10 space-y-8">
        <SystemStatusBanner />

        {error && (
          <div className="p-4 rounded-2xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-700 dark:text-red-300 text-sm font-semibold">
            {error}
          </div>
        )}
        {notice && (
          <div className="p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-300 text-sm font-semibold">
            {notice}
          </div>
        )}

        <section className="grid lg:grid-cols-2 gap-8">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 space-y-5">
            <div className="flex items-center gap-3">
              <BuildingIcon />
              <h2 className="text-lg font-bold">Onboard Merchant Business</h2>
            </div>
            <form onSubmit={handleCreateBusiness} className="grid sm:grid-cols-2 gap-4">
              <input
                required
                placeholder="Business Name"
                value={bizForm.name}
                onChange={(e) => setBizForm({ ...bizForm, name: e.target.value })}
                className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm"
              />
              <input
                required
                placeholder="Legal Entity Name"
                value={bizForm.legalName}
                onChange={(e) => setBizForm({ ...bizForm, legalName: e.target.value })}
                className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm"
              />
              <input
                required
                placeholder="slug-name (e.g. green-retail)"
                value={bizForm.slug}
                onChange={(e) => setBizForm({ ...bizForm, slug: e.target.value })}
                className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm"
              />
              <input
                placeholder="Owner User ID (optional)"
                value={bizForm.ownerUserId}
                onChange={(e) => setBizForm({ ...bizForm, ownerUserId: e.target.value })}
                className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm"
              />
              <select
                value={bizForm.packagingModel}
                onChange={(e) =>
                  setBizForm({ ...bizForm, packagingModel: e.target.value as OwnershipModel })
                }
                className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm"
              >
                <option value="HYBRID">HYBRID (Own First, Shared Fallback)</option>
                <option value="SHARED_POOL">SHARED_POOL (ReBoxify Pool)</option>
                <option value="MERCHANT_OWNED">MERCHANT_OWNED (Own Only)</option>
              </select>
              <input
                maxLength={3}
                value={bizForm.currency}
                onChange={(e) => setBizForm({ ...bizForm, currency: e.target.value.toUpperCase() })}
                className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm uppercase"
              />
              <button
                type="submit"
                className="sm:col-span-2 py-3 bg-indigo-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-indigo-700"
              >
                Create Active Merchant
              </button>
            </form>
          </div>

          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 space-y-5">
            <div className="flex items-center gap-3">
              <PackageIcon />
              <h2 className="text-lg font-bold">Register Reusable PP Package</h2>
            </div>
            <form onSubmit={handleRegisterPackage} className="grid sm:grid-cols-2 gap-4">
              <select
                value={pkgForm.ownerType}
                onChange={(e) =>
                  setPkgForm({ ...pkgForm, ownerType: e.target.value as PackageOwnerType })
                }
                className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm"
              >
                <option value="REBOXIFY_POOL">REBOXIFY_POOL (Shared Pool)</option>
                <option value="MERCHANT">MERCHANT (Merchant Owned)</option>
                <option value="HYBRID">HYBRID</option>
              </select>
              <select
                value={pkgForm.packageClass}
                onChange={(e) =>
                  setPkgForm({ ...pkgForm, packageClass: e.target.value as PackageClass })
                }
                className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm"
              >
                <option value="S">S (20×15×10 cm, max 3kg)</option>
                <option value="M">M (30×25×15 cm, max 8kg)</option>
                <option value="L">L (45×35×25 cm, max 18kg)</option>
                <option value="XL">XL (60×45×35 cm, max 30kg)</option>
              </select>
              {pkgForm.ownerType !== 'REBOXIFY_POOL' && (
                <select
                  value={pkgForm.ownerId}
                  onChange={(e) => setPkgForm({ ...pkgForm, ownerId: e.target.value })}
                  required={pkgForm.ownerType === 'MERCHANT'}
                  className="sm:col-span-2 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm"
                >
                  <option value="">Select Owner Merchant...</option>
                  {businesses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.status})
                    </option>
                  ))}
                </select>
              )}
              <input
                required
                placeholder="Fulfilment Location (e.g. CHN-HUB-01)"
                value={pkgForm.fulfilmentLocation}
                onChange={(e) => setPkgForm({ ...pkgForm, fulfilmentLocation: e.target.value })}
                className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm"
              />
              <input
                placeholder="Custom RBX-... ID (optional)"
                value={pkgForm.packageId}
                onChange={(e) => setPkgForm({ ...pkgForm, packageId: e.target.value })}
                className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm font-mono"
              />
              <button
                type="submit"
                className="sm:col-span-2 py-3 bg-emerald-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-emerald-700"
              >
                Register Package &amp; Issue Signed QR Identity
              </button>
            </form>
            {lastLabel && (
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono">
                  Issued Signed QR: <b>{lastLabel.packageId}</b> (v{lastLabel.tokenVersion})
                </span>
                <button
                  type="button"
                  onClick={() => setActiveLabel(lastLabel)}
                  className="px-3 py-1 rounded-lg bg-indigo-600 text-white font-bold"
                >
                  Open Printable QR Label
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-bold">Merchant Businesses ({businesses.length})</h2>
            <button
              onClick={() => void loadAll()}
              className="text-xs font-bold text-indigo-600 hover:underline"
            >
              Refresh
            </button>
          </div>
          {loading ? (
            <p className="text-sm text-slate-400">Loading businesses...</p>
          ) : businesses.length === 0 ? (
            <p className="text-sm text-slate-400">No businesses registered in database yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase text-slate-400 border-b border-slate-100 dark:border-slate-800">
                    <th className="py-2 pr-4">Name</th>
                    <th className="py-2 pr-4">Model</th>
                    <th className="py-2 pr-4">Currency</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 text-right">Governance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {businesses.map((b) => (
                    <tr key={b.id}>
                      <td className="py-3 pr-4 font-semibold">
                        {b.name} <span className="text-xs text-slate-400">({b.slug})</span>
                      </td>
                      <td className="py-3 pr-4 text-xs font-mono">{b.packagingModel}</td>
                      <td className="py-3 pr-4 text-xs">{b.currency}</td>
                      <td className="py-3 pr-4">
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 dark:bg-slate-800">
                          {b.status}
                        </span>
                      </td>
                      <td className="py-3 text-right space-x-2">
                        {b.status !== 'ACTIVE' && (
                          <button
                            onClick={() => void handleBusinessStatus(b.id, 'ACTIVE')}
                            className="px-3 py-1 rounded-lg bg-emerald-600 text-white text-xs font-bold"
                          >
                            Approve
                          </button>
                        )}
                        {b.status === 'ACTIVE' && (
                          <button
                            onClick={() => void handleBusinessStatus(b.id, 'SUSPENDED')}
                            className="px-3 py-1 rounded-lg bg-rose-600 text-white text-xs font-bold"
                          >
                            Suspend
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

        <PackageScannerPanel
          title="Admin Supervisory QR Scanner & Lifecycle Controls"
          subtitle="Verify signed QR tokens or supervised fallback across every stage of the reusable packaging lifecycle."
          allowedActions={ADMIN_SCAN_ACTIONS}
          partners={partners}
          initialPackageId={selectedScanPkgId}
          onScanComplete={() => void loadAll()}
          onViewPassport={(pkgId) => void handleOpenPassport(pkgId)}
        />

        <section className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 space-y-4">
          <h2 className="text-lg font-bold">
            Network Packaging Inventory ({inventory.length}) — Ownership, Custody &amp; Passports
          </h2>
          {inventory.length === 0 ? (
            <p className="text-sm text-slate-400">No packages registered yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase text-slate-400 border-b border-slate-100 dark:border-slate-800">
                    <th className="py-2 pr-4">Package ID</th>
                    <th className="py-2 pr-4">Class</th>
                    <th className="py-2 pr-4">Owner</th>
                    <th className="py-2 pr-4">Current Custodian</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">QR State</th>
                    <th className="py-2 pr-4 text-right">Deposit</th>
                    <th className="py-2 text-right">Passport &amp; QR</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {inventory.map((pkg) => (
                    <tr key={pkg.id}>
                      <td className="py-3 pr-4 font-mono font-bold">{pkg.packageId}</td>
                      <td className="py-3 pr-4">{pkg.packageClass}</td>
                      <td className="py-3 pr-4 text-xs">{pkg.ownerType}</td>
                      <td className="py-3 pr-4 text-xs">
                        {pkg.currentCustodian.custodianType} · {pkg.currentCustodian.label}
                      </td>
                      <td className="py-3 pr-4 font-mono text-xs">{pkg.status}</td>
                      <td className="py-3 pr-4 font-mono text-xs">
                        v{pkg.qrTokenVersion ?? 1} · {pkg.qrRevoked ? 'REVOKED' : 'ACTIVE'}
                      </td>
                      <td className="py-3 pr-4 text-right font-semibold">
                        {pkg.currency} {pkg.depositAmount.toFixed(2)}
                      </td>
                      <td className="py-3 text-right space-x-1.5 whitespace-nowrap text-xs">
                        <button
                          type="button"
                          onClick={() => void handleOpenPassport(pkg.packageId)}
                          className="px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 font-bold"
                        >
                          Passport
                        </button>
                        <button
                          type="button"
                          onClick={() => setSelectedScanPkgId(pkg.packageId)}
                          className="px-2.5 py-1 rounded-lg bg-emerald-600 text-white font-bold"
                        >
                          Scan
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleReprintQr(pkg.packageId)}
                          className="px-2.5 py-1 rounded-lg bg-indigo-600 text-white font-bold"
                        >
                          Reprint QR
                        </button>
                        {!pkg.qrRevoked && (
                          <button
                            type="button"
                            onClick={() => void handleRevokeQr(pkg.packageId)}
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

        <ReturnsManagementSection
          title="Network Returns, Inspection Review & PayPal Refund Reconciliation"
          returnsList={returnsList}
          partners={partners}
          canApprove={true}
          onUpdated={loadAll}
        />

        <section className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 space-y-4">
          <h2 className="text-lg font-bold">
            Network PayPal Sandbox Transactions &amp; Deposit Ledger ({transactions.length})
          </h2>
          {transactions.length === 0 ? (
            <p className="text-sm text-slate-400">No transactions recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase text-slate-400 border-b border-slate-100 dark:border-slate-800">
                    <th className="py-2 pr-4">PayPal Order ID</th>
                    <th className="py-2 pr-4">Capture ID</th>
                    <th className="py-2 pr-4">State</th>
                    <th className="py-2 pr-4">Deposit Allocations</th>
                    <th className="py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {transactions.map((tx) => (
                    <tr key={tx.id}>
                      <td className="py-3 pr-4 font-mono text-xs font-bold">{tx.paypalOrderId}</td>
                      <td className="py-3 pr-4 font-mono text-xs">{tx.captureId || '—'}</td>
                      <td className="py-3 pr-4 font-mono text-xs">{tx.state}</td>
                      <td className="py-3 pr-4 text-xs">
                        {tx.depositAllocations
                          .map((d) => `${d.packageId}: ${tx.currency} ${d.allocatedDeposit.toFixed(2)}`)
                          .join(', ')}
                      </td>
                      <td className="py-3 text-right font-semibold">
                        {tx.currency} {tx.amount.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
    </div>
  );
};

export default AdminDashboard;
