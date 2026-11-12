import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PackageIcon, QRIcon, UserIcon } from '../components/Icons';
import { PassportViewerModal } from '../components/PassportViewerModal';
import { PayPalOrderCheckout } from '../components/PayPalOrderCheckout';
import { ReturnDetailModal } from '../components/ReturnDetailModal';
import { ReturnEvidenceUploader } from '../components/ReturnEvidenceUploader';
import { SystemStatusBanner } from '../components/SystemStatusBanner';
import { ApiError } from '../api/client';
import {
  createOrder,
  listBusinesses,
  listOrders,
  listProducts,
} from '../api/phase2';
import { getPayPalPublicConfig, listTransactions } from '../api/phase3';
import { getPackagePassport } from '../api/phase4';
import { initiateReturn, listReturns } from '../api/phase5';
import { useAuth } from '../contexts/AuthContext';
import {
  BusinessDto,
  DigitalPassportView,
  OrderDto,
  PayPalPublicConfig,
  ProductDto,
  ReturnDto,
  ReturnMode,
  TransactionDto,
} from '../types/domain';

const UserPortal: React.FC = () => {
  const navigate = useNavigate();
  const { session, logout } = useAuth();
  const user = session.user;

  const [merchants, setMerchants] = useState<BusinessDto[]>([]);
  const [selectedMerchantId, setSelectedMerchantId] = useState('');
  const [products, setProducts] = useState<ProductDto[]>([]);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [recipientName, setRecipientName] = useState(user?.name || '');
  const [zone, setZone] = useState('Zone-A');
  const [addressLine, setAddressLine] = useState('42 Green Ave, Chennai');
  const [fulfilmentLocation, setFulfilmentLocation] = useState('CHN-HUB-01');
  const [orders, setOrders] = useState<OrderDto[]>([]);
  const [returnsList, setReturnsList] = useState<ReturnDto[]>([]);
  const [transactions, setTransactions] = useState<TransactionDto[]>([]);
  const [paypalConfig, setPayPalConfig] = useState<PayPalPublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [passportModal, setPassportModal] = useState<DigitalPassportView | null>(null);
  const [passportLoading, setPassportLoading] = useState(false);
  const [passportError, setPassportError] = useState<string | null>(null);
  const [selectedReturnModal, setSelectedReturnModal] = useState<ReturnDto | null>(null);
  const [returnModeByOrderPkg, setReturnModeByOrderPkg] = useState<Record<string, ReturnMode>>({});
  const [returnLocByOrderPkg, setReturnLocByOrderPkg] = useState<Record<string, string>>({});
  const [submittingReturnKey, setSubmittingReturnKey] = useState<string | null>(null);
  const [creatingOrder, setCreatingOrder] = useState(false);

  const loadOrdersAndMerchants = useCallback(async () => {
    setError(null);
    try {
      const [bizRes, ordRes, txRes, retRes, ppCfg] = await Promise.all([
        listBusinesses({ status: 'ACTIVE', pageSize: 50 }),
        listOrders({ pageSize: 50 }),
        listTransactions({ pageSize: 50 }),
        listReturns({ pageSize: 50 }),
        getPayPalPublicConfig(),
      ]);
      setMerchants(bizRes.items);
      setOrders(ordRes.items);
      setTransactions(txRes.items);
      setReturnsList(retRes.items);
      setPayPalConfig(ppCfg);
      if (bizRes.items[0]) {
        setSelectedMerchantId((prev) => prev || bizRes.items[0].id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load customer data.');
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'CUSTOMER') {
      void loadOrdersAndMerchants();
    }
  }, [user, loadOrdersAndMerchants]);

  useEffect(() => {
    if (!selectedMerchantId) {
      setProducts([]);
      return;
    }
    listProducts({ merchantId: selectedMerchantId })
      .then((res) => {
        setProducts(res.items);
        setSelectedProductId(res.items[0]?.id || '');
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : 'Could not load storefront products.');
      });
  }, [selectedMerchantId]);

  if (!user || user.role !== 'CUSTOMER') {
    return null;
  }

  const handlePlaceOrderWithAllocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMerchantId || !selectedProductId || creatingOrder) return;
    setCreatingOrder(true);
    setError(null);
    setNotice(null);
    try {
      const idempotencyKey = `ui-order-${user.userId}-${selectedProductId}-${Date.now()}`;
      const res = await createOrder(
        {
          merchantId: selectedMerchantId,
          items: [{ productId: selectedProductId, quantity: Number(quantity) }],
          shippingReference: {
            recipientName,
            zone,
            addressLine,
            fulfilmentLocation,
          },
          autoAllocate: true,
        },
        idempotencyKey
      );
      setNotice(
        `Order ${res.order.orderNumber} placed & allocated reusable packaging (${res.order.allocatedPackages.map((p) => p.packageId).join(', ')}). Proceed to PayPal Sandbox checkout below.`
      );
      await loadOrdersAndMerchants();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Order creation failed.');
    } finally {
      setCreatingOrder(false);
    }
  };

  const getLatestTransactionForOrder = (orderId: string): TransactionDto | undefined => {
    return transactions.find((t) => t.orderId === orderId);
  };

  const handleViewPassport = async (packageId: string) => {
    setPassportModal(null);
    setPassportError(null);
    setPassportLoading(true);
    try {
      const res = await getPackagePassport(packageId);
      setPassportModal(res.passport);
    } catch (err) {
      setPassportError(err instanceof ApiError ? err.message : 'Unable to load package passport.');
    } finally {
      setPassportLoading(false);
    }
  };

  const handleRequestReturn = async (ord: OrderDto, packageId: string) => {
    const key = `${ord.id}:${packageId}`;
    const mode = returnModeByOrderPkg[key] ?? 'DROP_OFF';
    const detailText = returnLocByOrderPkg[key]?.trim();
    setSubmittingReturnKey(key);
    setError(null);
    setNotice(null);
    try {
      const start = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const end = new Date(Date.now() + 26 * 3600 * 1000).toISOString();
      const res = await initiateReturn({
        orderId: ord.id,
        packageId,
        mode,
        reason: 'Customer requested reusable container return',
        ...(mode === 'DROP_OFF'
          ? { dropoffLocationLabel: detailText || `${ord.shippingReference.fulfilmentLocation} Partner Locker` }
          : mode === 'PICKUP'
            ? {
                pickupWindowStart: start,
                pickupWindowEnd: end,
                serviceZone: ord.shippingReference.zone,
                addressSummary: detailText || ord.shippingReference.addressLine,
              }
            : {
                swapOrderNumber: detailText || `SWAP-${ord.orderNumber}`,
                serviceZone: ord.shippingReference.zone,
                addressSummary: ord.shippingReference.addressLine,
              }),
      });
      setNotice(
        `Return ${res.returnRecord.returnNumber} initiated (${res.returnRecord.status}) for ${packageId}.`
      );
      await loadOrdersAndMerchants();
    } catch (err) {
      setError(err instanceof ApiError ? `[${err.code}] ${err.message}` : 'Return request failed.');
    } finally {
      setSubmittingReturnKey(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#020617] text-slate-900 dark:text-slate-100">
      <header className="sticky top-0 z-50 p-4 md:p-6">
        <div className="max-w-7xl mx-auto glass-effect dark:bg-slate-900/60 border border-slate-200 dark:border-white/10 rounded-[2rem] px-6 md:px-10 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 cursor-pointer" onClick={() => navigate('/')}>
            <div className="w-12 h-12 bg-emerald-600 rounded-2xl flex items-center justify-center text-white font-black text-xl shadow-lg">
              R
            </div>
            <div>
              <h1 className="text-xl font-black tracking-tight">Customer Portal</h1>
              <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
                {user.name} · {user.email}
              </p>
            </div>
          </div>

          <button
            onClick={() => void logout()}
            className="px-6 py-2.5 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-rose-600"
          >
            Sign Out
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 pb-16 space-y-8">
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

        <section className="grid lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 p-8 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 shadow-sm space-y-5">
            <div className="flex items-center gap-3">
              <PackageIcon />
              <h2 className="text-xl font-black tracking-tight">
                Storefront Order &amp; Packaging Allocation
              </h2>
            </div>

            {merchants.length === 0 ? (
              <p className="text-sm text-slate-400">
                No active merchants available yet. Ask an administrator to onboard an active merchant and products.
              </p>
            ) : (
              <form onSubmit={handlePlaceOrderWithAllocation} className="grid sm:grid-cols-2 gap-4 text-sm">
                <select
                  value={selectedMerchantId}
                  onChange={(e) => setSelectedMerchantId(e.target.value)}
                  className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                >
                  {merchants.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.currency})
                    </option>
                  ))}
                </select>
                <select
                  value={selectedProductId}
                  onChange={(e) => setSelectedProductId(e.target.value)}
                  className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                >
                  {products.length === 0 ? (
                    <option value="">No products in this storefront</option>
                  ) : (
                    products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.currency} {p.unitPrice}) — {p.dimensionsCm.length}×{p.dimensionsCm.width}×{p.dimensionsCm.height}cm
                      </option>
                    ))
                  )}
                </select>
                <input
                  type="number"
                  min="1"
                  required
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="Quantity"
                  className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                />
                <input
                  required
                  value={fulfilmentLocation}
                  onChange={(e) => setFulfilmentLocation(e.target.value)}
                  placeholder="Fulfilment Location"
                  className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                />
                <input
                  required
                  value={recipientName}
                  onChange={(e) => setRecipientName(e.target.value)}
                  placeholder="Recipient Name"
                  className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                />
                <input
                  required
                  value={zone}
                  onChange={(e) => setZone(e.target.value)}
                  placeholder="Delivery Zone"
                  className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                />
                <input
                  required
                  value={addressLine}
                  onChange={(e) => setAddressLine(e.target.value)}
                  placeholder="Delivery Address"
                  className="sm:col-span-2 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5"
                />
                <button
                  type="submit"
                  disabled={!selectedProductId || creatingOrder}
                  className="sm:col-span-2 py-3 bg-emerald-600 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:bg-emerald-700 disabled:opacity-50"
                >
                  {creatingOrder
                    ? 'Placing Order & Allocating Package...'
                    : 'Place Order & Allocate Reusable Package'}
                </button>
              </form>
            )}
          </div>

          <div className="space-y-6">
            <div className="p-8 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-3">
              <div className="w-11 h-11 rounded-2xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                <QRIcon />
              </div>
              <h3 className="text-lg font-black">Digital Packaging Passports &amp; Returns</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                Inspect signed QR Packaging Passports, initiate drop-off / pickup / swap returns on delivered orders, upload GridFS photo evidence, and track verified PayPal partial deposit refunds below.
              </p>
            </div>
            <div className="p-8 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-3">
              <div className="w-11 h-11 rounded-2xl bg-sky-500/10 text-sky-600 dark:text-sky-400 flex items-center justify-center">
                <UserIcon />
              </div>
              <h3 className="text-lg font-black">Gemini Assistant (Phase 8)</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                Natural-language status Q&amp;A and return drafting with user confirmation will appear here in Phase 8.
              </p>
            </div>
          </div>
        </section>

        <section className="p-8 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-4">
          <h2 className="text-xl font-black">
            Your Orders, Deposit Disclosure &amp; PayPal Sandbox Checkout ({orders.length})
          </h2>
          {orders.length === 0 ? (
            <p className="text-sm text-slate-400">You have not placed any orders yet.</p>
          ) : (
            <div className="grid md:grid-cols-2 gap-6">
              {orders.map((ord) => (
                <div
                  key={ord.id}
                  className="p-6 rounded-2xl border border-slate-200 dark:border-white/10 space-y-3"
                >
                  <div className="flex justify-between items-center">
                    <span className="font-mono font-bold">{ord.orderNumber}</span>
                    <span className="px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/10 text-emerald-600">
                      {ord.status}
                    </span>
                  </div>
                  {ord.allocatedPackages.length > 0 && (
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/5 text-xs space-y-2">
                      <p className="font-bold">
                        Allocated Package(s):{' '}
                        {ord.allocatedPackages
                          .map((p) => `${p.packageId} [${p.packageClass}]`)
                          .join(', ')}
                      </p>
                      <p className="text-slate-500">{ord.allocationMetadata?.notes}</p>
                      <div className="flex flex-wrap gap-2">
                        {ord.allocatedPackages.map((p) => {
                          const existingRet = returnsList.find(
                            (r) => r.orderId === ord.id && r.packageId === p.packageId
                          );
                          const key = `${ord.id}:${p.packageId}`;
                          const mode = returnModeByOrderPkg[key] ?? 'DROP_OFF';
                          return (
                            <div key={p.packageId} className="w-full space-y-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => void handleViewPassport(p.packageId)}
                                  className="px-3 py-1 rounded-lg bg-indigo-600 text-white text-[11px] font-bold hover:bg-indigo-700"
                                >
                                  Passport: {p.packageId}
                                </button>
                                {existingRet && (
                                  <button
                                    type="button"
                                    onClick={() => setSelectedReturnModal(existingRet)}
                                    className="px-3 py-1 rounded-lg bg-teal-600 text-white text-[11px] font-bold"
                                  >
                                    Return {existingRet.returnNumber} ({existingRet.status})
                                  </button>
                                )}
                              </div>
                              {ord.status === 'DELIVERED' && !existingRet && (
                                <div className="flex flex-wrap items-center gap-2 pt-1">
                                  <select
                                    value={mode}
                                    onChange={(e) =>
                                      setReturnModeByOrderPkg((prev) => ({
                                        ...prev,
                                        [key]: e.target.value as ReturnMode,
                                      }))
                                    }
                                    className="px-2 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px]"
                                  >
                                    <option value="DROP_OFF">Partner Locker / Store Drop-Off</option>
                                    <option value="PICKUP">Doorstep Pickup</option>
                                    <option value="NEXT_DELIVERY_SWAP">Next-Delivery Swap</option>
                                  </select>
                                  <input
                                    placeholder={
                                      mode === 'DROP_OFF'
                                        ? 'Locker / Drop-off store'
                                        : mode === 'PICKUP'
                                          ? 'Pickup address note'
                                          : 'Swap Order #'
                                    }
                                    value={returnLocByOrderPkg[key] ?? ''}
                                    onChange={(e) =>
                                      setReturnLocByOrderPkg((prev) => ({
                                        ...prev,
                                        [key]: e.target.value,
                                      }))
                                    }
                                    className="px-2 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] flex-1 min-w-[140px]"
                                  />
                                  <button
                                    type="button"
                                    disabled={submittingReturnKey === key}
                                    onClick={() => void handleRequestReturn(ord, p.packageId)}
                                    className="px-3 py-1 rounded-lg bg-emerald-600 text-white text-[11px] font-bold hover:bg-emerald-700 disabled:opacity-50"
                                  >
                                    {submittingReturnKey === key ? 'Submitting...' : 'Request Return'}
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <PayPalOrderCheckout
                    order={ord}
                    transaction={getLatestTransactionForOrder(ord.id)}
                    paypalConfig={paypalConfig}
                    onPaymentUpdated={loadOrdersAndMerchants}
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="p-8 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-4">
          <h2 className="text-xl font-black">
            Your Returns, Evidence &amp; PayPal Partial Refund Status ({returnsList.length})
          </h2>
          {returnsList.length === 0 ? (
            <p className="text-sm text-slate-400">No returns requested yet.</p>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {returnsList.map((ret) => (
                <div
                  key={ret.id}
                  className="p-5 rounded-2xl border border-slate-200 dark:border-white/10 space-y-2.5 text-xs"
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
                    Method: <b>{ret.mode}</b> · Eligible Refund:{' '}
                    <b>
                      {ret.refundEligibility.currency}{' '}
                      {ret.refundEligibility.calculatedAmount.toFixed(2)}
                    </b>{' '}
                    / {ret.refundEligibility.originalDeposit.toFixed(2)}
                  </p>
                  {ret.inspection && (
                    <p className="text-slate-500">
                      Inspection: <b>{ret.inspection.condition}</b> ({ret.inspection.outcome})
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setSelectedReturnModal(ret)}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold"
                    >
                      Refund &amp; Deduction Details
                    </button>
                    <ReturnEvidenceUploader
                      returnId={ret.id}
                      onUploaded={() => void loadOrdersAndMerchants()}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
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

export default UserPortal;
