import React, { useRef, useState } from 'react';
import { PayPalButtons, PayPalScriptProvider } from '@paypal/react-paypal-js';
import { ApiError } from '../api/client';
import {
  cancelPayPalCheckoutOrder,
  capturePayPalCheckoutOrder,
  createPayPalCheckoutOrder,
} from '../api/phase3';
import { OrderDto, PayPalPublicConfig, TransactionDto } from '../types/domain';

interface PayPalOrderCheckoutProps {
  order: OrderDto;
  transaction?: TransactionDto;
  paypalConfig: PayPalPublicConfig | null;
  onPaymentUpdated: () => Promise<void> | void;
}

export const PayPalOrderCheckout: React.FC<PayPalOrderCheckoutProps> = ({
  order,
  transaction,
  paypalConfig,
  onPaymentUpdated,
}) => {
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activePayPalOrderRef = useRef<string | null>(
    transaction && transaction.state !== 'CAPTURE_FAILED' ? transaction.paypalOrderId : null
  );
  const createAttemptKeyRef = useRef<string | null>(null);

  const clientId =
    paypalConfig?.paypalClientId || import.meta.env.VITE_PAYPAL_CLIENT_ID || null;
  const serverPayPalReady = Boolean(paypalConfig?.paypalConfigured);

  const isPaid =
    order.status === 'PAID' ||
    order.status === 'DISPATCHED' ||
    order.status === 'DELIVERED' ||
    transaction?.state === 'CAPTURED' ||
    transaction?.state === 'PARTIALLY_REFUNDED' ||
    transaction?.state === 'REFUNDED';

  const isPending = transaction?.state === 'CAPTURE_PENDING';
  const canInitiateCheckout =
    !isPaid &&
    !isPending &&
    order.allocatedPackages.length > 0 &&
    order.status !== 'CANCELLED';

  const handleReconcile = async () => {
    if (!transaction?.paypalOrderId) return;
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const res = await capturePayPalCheckoutOrder(transaction.paypalOrderId);
      setStatusMessage(res.message);
      await onPaymentUpdated();
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : 'Reconciliation failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 pt-4 border-t border-slate-200 dark:border-white/10 space-y-3 text-xs">
      <div className="rounded-xl bg-slate-50 dark:bg-white/5 p-3 space-y-2">
        <div className="flex items-center justify-between font-bold text-slate-800 dark:text-slate-200">
          <span>Itemised Payment &amp; Refundable Deposit Disclosure</span>
          {transaction && (
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
              Payment: {transaction.state}
            </span>
          )}
        </div>
        <div className="space-y-1 text-slate-600 dark:text-slate-300">
          <div className="flex justify-between">
            <span>Product Subtotal</span>
            <span>
              {order.currency} {order.totals.productSubtotal.toFixed(2)}
            </span>
          </div>
          {order.allocatedPackages.map((pkg) => (
            <div key={pkg.packageId} className="flex justify-between text-emerald-700 dark:text-emerald-400">
              <span>
                Refundable Deposit — {pkg.packageId} (Class {pkg.packageClass})
              </span>
              <span>
                {order.currency} {pkg.depositAmount.toFixed(2)}
              </span>
            </div>
          ))}
          <div className="flex justify-between">
            <span>Shipping &amp; Tax</span>
            <span>
              {order.currency} {(order.totals.shippingTotal + order.totals.taxTotal).toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between font-black text-slate-900 dark:text-white pt-1 border-t border-slate-200 dark:border-white/10">
            <span>Total Payable</span>
            <span>
              {order.currency} {order.totals.grandTotal.toFixed(2)}
            </span>
          </div>
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
          Refund policy: Full package deposit is eligible for a PayPal partial refund against the original capture after on-time return{' '}
          {order.returnDeadlineAt
            ? `(by ${new Date(order.returnDeadlineAt).toLocaleDateString()}) `
            : ''}
          and passing collection-centre inspection. Late, damaged, or disputed returns are routed to policy review.
        </p>
      </div>

      {isPaid && transaction && (
        <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-emerald-800 dark:text-emerald-300 space-y-1">
          <div className="font-bold uppercase tracking-wider text-[10px]">
            Verified PayPal Capture Completed
          </div>
          <div className="font-mono text-[11px] break-all">
            PayPal Order: {transaction.paypalOrderId} · Capture ID: {transaction.captureId || 'Confirmed'}
          </div>
        </div>
      )}

      {isPending && transaction && (
        <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700/40 text-amber-800 dark:text-amber-200 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-bold">Capture Pending Verification ({transaction.paypalOrderId})</div>
            <div className="text-[11px]">
              Dispatch remains blocked until PayPal confirms CAPTURED state.
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleReconcile()}
            className="px-3 py-1.5 rounded-lg bg-amber-600 text-white font-bold uppercase text-[10px] disabled:opacity-50"
          >
            Reconcile Status
          </button>
        </div>
      )}

      {statusMessage && (
        <div className="p-2.5 rounded-xl bg-sky-50 dark:bg-sky-500/10 border border-sky-200 dark:border-sky-500/20 text-sky-700 dark:text-sky-300 font-semibold">
          {statusMessage}
        </div>
      )}

      {errorMessage && (
        <div className="p-2.5 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-700 dark:text-red-300 font-semibold">
          {errorMessage}
        </div>
      )}

      {canInitiateCheckout && (!serverPayPalReady || !clientId) && (
        <div className="p-3 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300">
          PayPal Sandbox checkout is unavailable until <code className="font-mono">PAYPAL_CLIENT_ID</code> and{' '}
          <code className="font-mono">PAYPAL_CLIENT_SECRET</code> are configured in the backend environment.
        </div>
      )}

      {canInitiateCheckout && serverPayPalReady && clientId && (
        <PayPalScriptProvider
          options={{
            clientId,
            currency: order.currency,
            intent: 'capture',
            components: 'buttons',
          }}
        >
          <PayPalButtons
            style={{ layout: 'horizontal', height: 38, tagline: false }}
            disabled={busy}
            createOrder={async () => {
              setBusy(true);
              setErrorMessage(null);
              setStatusMessage(null);
              try {
                if (
                  !createAttemptKeyRef.current ||
                  transaction?.state === 'CAPTURE_FAILED'
                ) {
                  createAttemptKeyRef.current = `ui-create-${order.id}-${Date.now()}`;
                }
                const res = await createPayPalCheckoutOrder(
                  order.id,
                  createAttemptKeyRef.current
                );
                activePayPalOrderRef.current = res.paypalOrderId;
                return res.paypalOrderId;
              } catch (err) {
                createAttemptKeyRef.current = null;
                const msg =
                  err instanceof ApiError ? err.message : 'Unable to initialize PayPal order.';
                setErrorMessage(msg);
                throw err;
              } finally {
                setBusy(false);
              }
            }}
            onApprove={async (data) => {
              setBusy(true);
              setErrorMessage(null);
              try {
                const res = await capturePayPalCheckoutOrder(
                  data.orderID,
                  `ui-cap-${data.orderID}`
                );
                createAttemptKeyRef.current = null;
                setStatusMessage(res.message);
                await onPaymentUpdated();
              } catch (err) {
                createAttemptKeyRef.current = null;
                setErrorMessage(
                  err instanceof ApiError ? err.message : 'PayPal payment capture failed.'
                );
                await onPaymentUpdated();
              } finally {
                setBusy(false);
              }
            }}
            onCancel={async (data) => {
              const ppId =
                (typeof data?.orderID === 'string' && data.orderID) ||
                activePayPalOrderRef.current;
              createAttemptKeyRef.current = null;
              activePayPalOrderRef.current = null;
              setErrorMessage(null);
              if (ppId) {
                try {
                  await cancelPayPalCheckoutOrder(ppId);
                  await onPaymentUpdated();
                } catch {
                  // Ignore cancel sync failure cleanly
                }
              }
              setStatusMessage(
                'PayPal checkout was cancelled before capture. No funds were charged.'
              );
            }}
            onError={(err) => {
              createAttemptKeyRef.current = null;
              activePayPalOrderRef.current = null;
              setErrorMessage(
                err instanceof Error
                  ? err.message
                  : 'PayPal checkout encountered an error. No payment was confirmed.'
              );
            }}
          />
        </PayPalScriptProvider>
      )}
    </div>
  );
};

