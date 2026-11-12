import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BuildingIcon, PackageIcon } from '../components/Icons';
import { PackageScannerPanel } from '../components/PackageScannerPanel';
import { PassportViewerModal } from '../components/PassportViewerModal';
import { QrLabelModal } from '../components/QrLabelModal';
import { ReturnsManagementSection } from '../components/ReturnsManagementSection';
import { SystemStatusBanner } from '../components/SystemStatusBanner';
import { ApiError } from '../api/client';
import {
  allocateOrderPackage,
  createOrder,
  listBusinesses,
  listInventory,
  listOrders,
  listProducts,
  registerPackage,
  updateBusinessPolicies,
  upsertProduct,
} from '../api/phase2';
import { listTransactions } from '../api/phase3';
import {
  assignDeliveryPartner,
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
  OrderDto,
  OwnershipModel,
  PackageClass,
  PackageDto,
  ProductDto,
  QrLabelData,
  ReturnDto,
  ScanAction,
  TransactionDto,
} from '../types/domain';

const MERCHANT_SCAN_ACTIONS: Array<{ action: ScanAction; label: string }> = [
  { action: 'PACK', label: 'PACK — Mark Reserved Package Packed' },
  { action: 'DISPATCH', label: 'DISPATCH — Handover to Assigned Partner (Payment-Gated)' },
  { action: 'QUARANTINE', label: 'QUARANTINE — Hold Packed Package Due to Issue' },
];

const CompanyAdminPortal: React.FC = () => {
  const navigate = useNavigate();
  const { session, logout } = useAuth();
  const user = session.user;

  const [business, setBusiness] = useState<BusinessDto | null>(null);
  const [products, setProducts] = useState<ProductDto[]>([]);
  const [inventory, setInventory] = useState<PackageDto[]>([]);
  const [orders, setOrders] = useState<OrderDto[]>([]);
  const [returnsList, setReturnsList] = useState<ReturnDto[]>([]);
  const [transactions, setTransactions] = useState<TransactionDto[]>([]);
  const [partners, setPartners] = useState<DeliveryPartnerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [splitOrderPromptId, setSplitOrderPromptId] = useState<string | null>(null);
  const [selectedScanPkgId, setSelectedScanPkgId] = useState('');
  const [activeLabel, setActiveLabel] = useState<QrLabelData | null>(null);
  const [passportModal, setPassportModal] = useState<DigitalPassportView | null>(null);
  const [passportLoading, setPassportLoading] = useState(false);
  const [passportError, setPassportError] = useState<string | null>(null);

  // SKU Form
  const [skuForm, setSkuForm] = useState({
    sku: '',
    name: '',
    length: '16',
    width: '12',
    height: '8',
    weightKg: '1.2',
    rotatable: true,
    fragility: 'LOW' as 'LOW' | 'MEDIUM' | 'HIGH',
    liquidContainment: false,
    unitPrice: '25',
  });

  // Merchant Package Form
  const [pkgForm, setPkgForm] = useState({
    packageClass: 'M' as PackageClass,
    fulfilmentLocation: 'CHN-HUB-01',
    packageId: '',
  });

  // Order Form
  const [orderForm, setOrderForm] = useState({
    customerId: '',
    productId: '',
    quantity: '1',
    recipientName: 'Demo Recipient',
    zone: 'Zone-A',
    addressLine: '100 Circular Way',
    fulfilmentLocation: 'CHN-HUB-01',
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bizRes, prodRes, invRes, ordRes, retRes, txRes, partnerRes] = await Promise.all([
        listBusinesses(),
        listProducts(),
        listInventory({ pageSize: 50 }),
        listOrders({ pageSize: 50 }),
        listReturns({ pageSize: 50 }),
        listTransactions({ pageSize: 50 }),
        listDeliveryPartners().catch(() => ({ partners: [] })),
      ]);
      const myBiz = bizRes.items[0] ?? null;
      setBusiness(myBiz);
      setProducts(prodRes.items);
      setInventory(invRes.items);
      setOrders(ordRes.items);
      setReturnsList(retRes.items);
      setTransactions(txRes.items);
      setPartners(partnerRes.partners);
      if (prodRes.items[0]) {
        setOrderForm((prev) => (prev.productId ? prev : { ...prev, productId: prodRes.items[0].id }));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load merchant workspace.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user && (user.role === 'MERCHANT_ADMIN' || user.role === 'MERCHANT_STAFF')) {
      void loadData();
    }
  }, [user, loadData]);

  if (!user || (user.role !== 'MERCHANT_ADMIN' && user.role !== 'MERCHANT_STAFF')) {
    return null;
  }

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await upsertProduct({
        sku: skuForm.sku,
        name: skuForm.name,
        dimensionsCm: {
          length: Number(skuForm.length),
          width: Number(skuForm.width),
          height: Number(skuForm.height),
        },
        weightKg: Number(skuForm.weightKg),
        rotatable: skuForm.rotatable,
        fragility: skuForm.fragility,
        restrictions: { liquidContainment: skuForm.liquidContainment },
        unitPrice: Number(skuForm.unitPrice),
      });
      setNotice(`Saved product SKU ${res.product.sku}.`);
      setSkuForm((prev) => ({ ...prev, sku: '', name: '' }));
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save product.');
    }
  };

  const handleRegisterMerchantBox = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await registerPackage({
        ownerType: 'MERCHANT',
        packageClass: pkgForm.packageClass,
        fulfilmentLocation: pkgForm.fulfilmentLocation,
        packageId: pkgForm.packageId.trim() || undefined,
      });
      setActiveLabel(res.label);
      setSelectedScanPkgId(res.package.packageId);
      setNotice(`Registered merchant-owned box ${res.package.packageId} with signed QR label v${res.qrPayload.tokenVersion}.`);
      setPkgForm((prev) => ({ ...prev, packageId: '' }));
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to register package.');
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
      setPassportError(err instanceof ApiError ? err.message : 'Could not load passport.');
    } finally {
      setPassportLoading(false);
    }
  };

  const handleReprintQr = async (packageId: string) => {
    setError(null);
    setNotice(null);
    try {
      const res = await reprintQrLabel(packageId, 'Merchant fulfilment label reprint');
      setActiveLabel(res.label);
      setNotice(`Issued new signed QR label v${res.qrPayload.tokenVersion} for ${packageId}.`);
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reprint QR label.');
    }
  };

  const handleRevokeQr = async (packageId: string) => {
    setError(null);
    setNotice(null);
    try {
      await revokeQrToken(packageId, 'Revoked by merchant administrator');
      setNotice(`Revoked active QR token for ${packageId}.`);
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to revoke QR token.');
    }
  };

  const handleAssignPartner = async (packageId: string, partnerUserId: string) => {
    if (!partnerUserId) return;
    setError(null);
    setNotice(null);
    try {
      const res = await assignDeliveryPartner(packageId, partnerUserId);
      setNotice(`Assigned ${res.partner.name} to ${packageId}.`);
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign partner.');
    }
  };

  const handleCreateOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!business) return;
    setError(null);
    setNotice(null);
    try {
      const res = await createOrder({
        merchantId: business.id,
        customerId: orderForm.customerId.trim(),
        items: [{ productId: orderForm.productId, quantity: Number(orderForm.quantity) }],
        shippingReference: {
          recipientName: orderForm.recipientName,
          zone: orderForm.zone,
          addressLine: orderForm.addressLine,
          fulfilmentLocation: orderForm.fulfilmentLocation,
        },
      });
      setNotice(`Order ${res.order.orderNumber} created in PLACED state.`);
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create order.');
    }
  };

  const handleAllocate = async (orderId: string, allowSplit = false) => {
    setError(null);
    setNotice(null);
    setSplitOrderPromptId(null);
    try {
      const res = await allocateOrderPackage(orderId, allowSplit);
      setNotice(
        res.alreadyAllocated
          ? `Order ${res.order.orderNumber} already allocated (${res.order.allocatedPackages.map((p) => p.packageId).join(', ')}).`
          : `Allocated ${res.order.allocatedPackages.map((p) => `${p.packageId} (${p.packageClass})`).join(', ')} — Deposit: ${res.order.currency} ${res.order.totals.depositTotal.toFixed(2)}.`
      );
      await loadData();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SPLIT_RECOMMENDED') {
        setSplitOrderPromptId(orderId);
      }
      setError(err instanceof ApiError ? err.message : 'Allocation failed.');
    }
  };

  const handleUpdateModel = async (packagingModel: OwnershipModel) => {
    if (!business) return;
    setError(null);
    try {
      const res = await updateBusinessPolicies(business.id, { packagingModel });
      setBusiness(res.business);
      setNotice(`Updated packaging ownership policy to ${res.business.packagingModel}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update policy.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#020617] text-slate-900 dark:text-slate-100">
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-white/10 px-6 py-4 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 cursor-pointer" onClick={() => navigate('/')}>
            <div className="w-11 h-11 bg-indigo-600 rounded-2xl flex items-center justify-center text-white shadow-lg">
              <BuildingIcon />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight">
                {business ? business.name : 'Merchant Dashboard'}
              </h1>
              <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-600 dark:text-indigo-400">
                {user.email} · {user.role} {business ? `· ${business.packagingModel}` : ''}
              </p>
            </div>
          </div>

          <button
            onClick={() => void logout()}
            className="px-5 py-2.5 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-rose-600"
          >
            Sign Out
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 md:p-10 space-y-8">
        <SystemStatusBanner />

        {error && (
          <div className="p-4 rounded-2xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-700 dark:text-red-300 text-sm font-semibold flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            {splitOrderPromptId && (
              <button
                onClick={() => void handleAllocate(splitOrderPromptId, true)}
                className="px-4 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-bold uppercase"
              >
                Confirm Split Allocation
              </button>
            )}
          </div>
        )}
        {notice && (
          <div className="p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-300 text-sm font-semibold">
            {notice}
          </div>
        )}

        {!loading && !business && (
          <div className="p-6 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700/40 text-sm">
            No active merchant business linked to your account yet. Contact a ReBoxify Administrator to link and approve your business.
          </div>
        )}

        {business && (
          <>
            <section className="p-6 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-black">Packaging Policy &amp; Ownership Mode</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Currency: {business.currency} · Return Window: {business.policies.returnWindowDays} days · Deposit Multiplier: {business.policies.depositMultiplier}x
                </p>
              </div>
              {user.role === 'MERCHANT_ADMIN' && (
                <div className="flex items-center gap-2">
                  {(['HYBRID', 'SHARED_POOL', 'MERCHANT_OWNED'] as OwnershipModel[]).map((m) => (
                    <button
                      key={m}
                      onClick={() => void handleUpdateModel(m)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold border ${
                        business.packagingModel === m
                          ? 'bg-indigo-600 text-white border-indigo-600'
                          : 'bg-slate-50 dark:bg-white/5 border-slate-200 dark:border-white/10'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="grid lg:grid-cols-2 gap-8">
              <div className="p-6 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-4">
                <h2 className="text-lg font-black flex items-center gap-2">
                  <PackageIcon /> Add / Update Product SKU
                </h2>
                <form onSubmit={handleSaveProduct} className="grid sm:grid-cols-2 gap-3 text-sm">
                  <input
                    required
                    placeholder="SKU (e.g. SKU-MUG-01)"
                    value={skuForm.sku}
                    onChange={(e) => setSkuForm({ ...skuForm, sku: e.target.value })}
                    className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                  />
                  <input
                    required
                    placeholder="Product Name"
                    value={skuForm.name}
                    onChange={(e) => setSkuForm({ ...skuForm, name: e.target.value })}
                    className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                  />
                  <input
                    required
                    type="number"
                    step="0.1"
                    min="0.1"
                    placeholder="Length (cm)"
                    value={skuForm.length}
                    onChange={(e) => setSkuForm({ ...skuForm, length: e.target.value })}
                    className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                  />
                  <input
                    required
                    type="number"
                    step="0.1"
                    min="0.1"
                    placeholder="Width (cm)"
                    value={skuForm.width}
                    onChange={(e) => setSkuForm({ ...skuForm, width: e.target.value })}
                    className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                  />
                  <input
                    required
                    type="number"
                    step="0.1"
                    min="0.1"
                    placeholder="Height (cm)"
                    value={skuForm.height}
                    onChange={(e) => setSkuForm({ ...skuForm, height: e.target.value })}
                    className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                  />
                  <input
                    required
                    type="number"
                    step="0.1"
                    min="0.05"
                    placeholder="Weight (kg)"
                    value={skuForm.weightKg}
                    onChange={(e) => setSkuForm({ ...skuForm, weightKg: e.target.value })}
                    className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                  />
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Unit Price"
                    value={skuForm.unitPrice}
                    onChange={(e) => setSkuForm({ ...skuForm, unitPrice: e.target.value })}
                    className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                  />
                  <select
                    value={skuForm.fragility}
                    onChange={(e) =>
                      setSkuForm({ ...skuForm, fragility: e.target.value as 'LOW' | 'MEDIUM' | 'HIGH' })
                    }
                    className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                  >
                    <option value="LOW">Fragility: LOW (1cm clearance)</option>
                    <option value="MEDIUM">Fragility: MEDIUM (2cm clearance)</option>
                    <option value="HIGH">Fragility: HIGH (3cm + Reinforced)</option>
                  </select>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={skuForm.rotatable}
                      onChange={(e) => setSkuForm({ ...skuForm, rotatable: e.target.checked })}
                    />
                    3D Rotatable
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={skuForm.liquidContainment}
                      onChange={(e) => setSkuForm({ ...skuForm, liquidContainment: e.target.checked })}
                    />
                    Requires Liquid Containment
                  </label>
                  <button
                    type="submit"
                    className="sm:col-span-2 py-2.5 bg-indigo-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest"
                  >
                    Save Product SKU
                  </button>
                </form>
              </div>

              <div className="p-6 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-6">
                {user.role === 'MERCHANT_ADMIN' && (
                  <form onSubmit={handleRegisterMerchantBox} className="space-y-3 pb-5 border-b border-slate-200 dark:border-white/10">
                    <h2 className="text-lg font-black">Register Merchant-Owned PP Box</h2>
                    <div className="grid sm:grid-cols-3 gap-2 text-sm">
                      <select
                        value={pkgForm.packageClass}
                        onChange={(e) =>
                          setPkgForm({ ...pkgForm, packageClass: e.target.value as PackageClass })
                        }
                        className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                      >
                        <option value="S">Class S</option>
                        <option value="M">Class M</option>
                        <option value="L">Class L</option>
                        <option value="XL">Class XL</option>
                      </select>
                      <input
                        required
                        placeholder="Fulfilment Location"
                        value={pkgForm.fulfilmentLocation}
                        onChange={(e) =>
                          setPkgForm({ ...pkgForm, fulfilmentLocation: e.target.value })
                        }
                        className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                      />
                      <button
                        type="submit"
                        className="py-2 bg-emerald-600 text-white rounded-xl font-bold text-xs uppercase"
                      >
                        Add Owned Box
                      </button>
                    </div>
                  </form>
                )}

                <form onSubmit={handleCreateOrder} className="space-y-3 text-sm">
                  <h2 className="text-lg font-black">Create Customer Order</h2>
                  <div className="grid sm:grid-cols-2 gap-2">
                    <input
                      required
                      placeholder="Customer User ID"
                      value={orderForm.customerId}
                      onChange={(e) => setOrderForm({ ...orderForm, customerId: e.target.value })}
                      className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                    />
                    <select
                      required
                      value={orderForm.productId}
                      onChange={(e) => setOrderForm({ ...orderForm, productId: e.target.value })}
                      className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                    >
                      <option value="">Select Product...</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.sku} — {p.name} ({p.currency} {p.unitPrice})
                        </option>
                      ))}
                    </select>
                    <input
                      required
                      type="number"
                      min="1"
                      placeholder="Quantity"
                      value={orderForm.quantity}
                      onChange={(e) => setOrderForm({ ...orderForm, quantity: e.target.value })}
                      className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                    />
                    <input
                      required
                      placeholder="Fulfilment Location"
                      value={orderForm.fulfilmentLocation}
                      onChange={(e) =>
                        setOrderForm({ ...orderForm, fulfilmentLocation: e.target.value })
                      }
                      className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={products.length === 0}
                    className="w-full py-2.5 bg-slate-900 dark:bg-indigo-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest disabled:opacity-50"
                  >
                    Create Order (PLACED)
                  </button>
                </form>
              </div>
            </section>

            <section className="p-6 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-4">
              <h2 className="text-lg font-black">Orders &amp; Deterministic Package Allocation ({orders.length})</h2>
              {orders.length === 0 ? (
                <p className="text-sm text-slate-400">No merchant orders yet.</p>
              ) : (
                <div className="space-y-3">
                  {orders.map((ord) => (
                    <div
                      key={ord.id}
                      className="p-4 rounded-2xl border border-slate-200 dark:border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-4"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-3">
                          <span className="font-mono font-bold">{ord.orderNumber}</span>
                          <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
                            {ord.status}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500">
                          Product Subtotal: {ord.currency} {ord.totals.productSubtotal.toFixed(2)} · Deposit: {ord.currency} {ord.totals.depositTotal.toFixed(2)} · Grand Total: <b>{ord.currency} {ord.totals.grandTotal.toFixed(2)}</b>
                        </p>
                        {ord.allocatedPackages.length > 0 && (
                          <div className="space-y-1.5">
                            <p className="text-xs text-emerald-600 dark:text-emerald-400">
                              Allocated: {ord.allocatedPackages.map((p) => `${p.packageId} (${p.packageClass}, ${p.ownerType})`).join(', ')} — {ord.allocationMetadata?.notes}
                            </p>
                            <div className="flex flex-wrap items-center gap-2">
                              {ord.allocatedPackages.map((p) => (
                                <React.Fragment key={p.packageId}>
                                  <button
                                    type="button"
                                    onClick={() => setSelectedScanPkgId(p.packageId)}
                                    className="px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-[11px] font-bold"
                                  >
                                    Scan {p.packageId}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleOpenPassport(p.packageId)}
                                    className="px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 text-[11px] font-bold"
                                  >
                                    Passport
                                  </button>
                                  {partners.length > 0 && (
                                    <select
                                      defaultValue=""
                                      onChange={(e) => void handleAssignPartner(p.packageId, e.target.value)}
                                      className="px-2 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-[11px]"
                                    >
                                      <option value="">Assign Partner...</option>
                                      {partners.map((pt) => (
                                        <option key={pt.id} value={pt.id}>
                                          {pt.name}
                                        </option>
                                      ))}
                                    </select>
                                  )}
                                </React.Fragment>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      {ord.allocatedPackages.length === 0 && (
                        <button
                          onClick={() => void handleAllocate(ord.id)}
                          className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-bold uppercase tracking-wider shrink-0"
                        >
                          Allocate Package
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="p-6 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-4">
              <h2 className="text-lg font-black">
                PayPal Sandbox Transactions &amp; Deposit Allocations ({transactions.length})
              </h2>
              {transactions.length === 0 ? (
                <p className="text-sm text-slate-400">No PayPal transactions recorded yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="text-xs uppercase text-slate-400 border-b border-slate-200 dark:border-white/10">
                        <th className="py-2 pr-4">PayPal Order ID</th>
                        <th className="py-2 pr-4">Capture ID</th>
                        <th className="py-2 pr-4">State</th>
                        <th className="py-2 pr-4">Deposit Allocation</th>
                        <th className="py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                      {transactions.map((tx) => (
                        <tr key={tx.id}>
                          <td className="py-2 pr-4 font-mono text-xs font-bold">{tx.paypalOrderId}</td>
                          <td className="py-2 pr-4 font-mono text-xs">{tx.captureId || '—'}</td>
                          <td className="py-2 pr-4 font-mono text-xs">{tx.state}</td>
                          <td className="py-2 pr-4 text-xs">
                            {tx.depositAllocations
                              .map((d) => `${d.packageId}: ${tx.currency} ${d.allocatedDeposit.toFixed(2)}`)
                              .join(', ')}
                          </td>
                          <td className="py-2 text-right font-semibold">
                            {tx.currency} {tx.amount.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <PackageScannerPanel
              title="Merchant Fulfilment QR Scanner (Pack & Payment-Gated Dispatch)"
              subtitle="Scan reserved or packed containers to confirm packing, bind delivery partner custody, and enforce captured-payment dispatch verification."
              allowedActions={MERCHANT_SCAN_ACTIONS}
              partners={partners}
              initialPackageId={selectedScanPkgId}
              onScanComplete={() => void loadData()}
              onViewPassport={(pkgId) => void handleOpenPassport(pkgId)}
            />

            <section className="p-6 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-4">
              <h2 className="text-lg font-black">Eligible Inventory &amp; Digital Passports ({inventory.length})</h2>
              {inventory.length === 0 ? (
                <p className="text-sm text-slate-400">No eligible inventory found.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="text-xs uppercase text-slate-400 border-b border-slate-200 dark:border-white/10">
                        <th className="py-2 pr-4">Package ID</th>
                        <th className="py-2 pr-4">Class</th>
                        <th className="py-2 pr-4">Owner</th>
                        <th className="py-2 pr-4">Custodian</th>
                        <th className="py-2 pr-4">Status</th>
                        <th className="py-2 pr-4">QR State</th>
                        <th className="py-2 text-right">Passport &amp; QR</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                      {inventory.map((pkg) => (
                        <tr key={pkg.id}>
                          <td className="py-2 pr-4 font-mono font-bold">{pkg.packageId}</td>
                          <td className="py-2 pr-4">{pkg.packageClass}</td>
                          <td className="py-2 pr-4 text-xs">{pkg.ownerType}</td>
                          <td className="py-2 pr-4 text-xs">{pkg.currentCustodian.label}</td>
                          <td className="py-2 pr-4 font-mono text-xs">{pkg.status}</td>
                          <td className="py-2 pr-4 font-mono text-xs">
                            v{pkg.qrTokenVersion ?? 1} · {pkg.qrRevoked ? 'REVOKED' : 'ACTIVE'}
                          </td>
                          <td className="py-2 text-right space-x-1.5 whitespace-nowrap text-xs">
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
                            {user.role === 'MERCHANT_ADMIN' && (
                              <>
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
                              </>
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
              title="Merchant Returns, Inspection Outcomes & Partial Deposit Refunds"
              returnsList={returnsList}
              partners={partners}
              canApprove={user.role === 'MERCHANT_ADMIN'}
              onUpdated={loadData}
            />
          </>
        )}
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

export default CompanyAdminPortal;
