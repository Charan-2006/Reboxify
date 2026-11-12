import React, { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { fetchAuthorizedEvidenceBlobUrl, getReturnRefund } from '../api/phase5';
import { RefundDto, ReturnDto } from '../types/domain';

interface ReturnDetailModalProps {
  returnRecord: ReturnDto | null;
  onClose: () => void;
}

export const ReturnDetailModal: React.FC<ReturnDetailModalProps> = ({
  returnRecord,
  onClose,
}) => {
  const [refund, setRefund] = useState<RefundDto | null>(null);
  const [refundLoading, setRefundLoading] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!returnRecord) {
      setRefund(null);
      return;
    }
    let active = true;
    setRefundLoading(true);
    setRefundError(null);

    getReturnRefund(returnRecord.id)
      .then((res) => {
        if (active) setRefund(res.refund);
      })
      .catch((err) => {
        if (active) {
          setRefundError(err instanceof ApiError ? err.message : 'Could not load refund status.');
        }
      })
      .finally(() => {
        if (active) setRefundLoading(false);
      });

    return () => {
      active = false;
    };
  }, [returnRecord]);

  useEffect(() => {
    return () => {
      Object.values(previewUrls).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [previewUrls]);

  if (!returnRecord) return null;

  const handleLoadPreview = async (fileId: string) => {
    if (previewUrls[fileId]) return;
    try {
      const objUrl = await fetchAuthorizedEvidenceBlobUrl(returnRecord.id, fileId);
      setPreviewUrls((prev) => ({ ...prev, [fileId]: objUrl }));
    } catch {
      // Ignore inline preview error
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-3xl border border-slate-200 dark:border-slate-700 max-w-3xl w-full p-6 shadow-2xl space-y-5 my-8 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
          <div>
            <span className="text-[10px] font-black uppercase tracking-widest text-teal-600 dark:text-teal-400">
              Return &amp; Partial Refund Ledger
            </span>
            <h3 className="text-2xl font-black font-mono mt-0.5">
              {returnRecord.returnNumber} · {returnRecord.packageId}
            </h3>
            <p className="text-xs text-slate-500">
              Mode: {returnRecord.mode} · Status: <b>{returnRecord.status}</b>
              {returnRecord.isLateReturn ? ` · Late (${returnRecord.daysLate}d)` : ' · On Time'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
          >
            Close
          </button>
        </div>

        <div className="grid md:grid-cols-2 gap-4 text-xs">
          <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 space-y-1.5">
            <p className="font-black uppercase text-[10px] tracking-wider text-slate-400">
              Reverse Logistics &amp; Method
            </p>
            <p>
              <b>Reason:</b> {returnRecord.reason || '—'}
            </p>
            {returnRecord.returnMethodDetails?.dropoffLocationLabel && (
              <p>
                <b>Drop-Off Point:</b> {returnRecord.returnMethodDetails.dropoffLocationLabel}
              </p>
            )}
            {returnRecord.returnMethodDetails?.serviceZone && (
              <p>
                <b>Service Zone:</b> {returnRecord.returnMethodDetails.serviceZone}
              </p>
            )}
            {returnRecord.returnMethodDetails?.swapOrderNumber && (
              <p>
                <b>Swap Reference:</b> {returnRecord.returnMethodDetails.swapOrderNumber}
              </p>
            )}
            {returnRecord.assignedPartnerName && (
              <p>
                <b>Assigned Partner:</b> {returnRecord.assignedPartnerName}
              </p>
            )}
            <p>
              <b>Collected:</b>{' '}
              {returnRecord.collectedAt ? new Date(returnRecord.collectedAt).toLocaleString() : '—'}
            </p>
            <p>
              <b>Received at Centre:</b>{' '}
              {returnRecord.receivedAt ? new Date(returnRecord.receivedAt).toLocaleString() : '—'}
            </p>
          </div>

          <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 space-y-1.5">
            <p className="font-black uppercase text-[10px] tracking-wider text-slate-400">
              Deterministic Inspection &amp; Eligibility
            </p>
            {returnRecord.inspection ? (
              <>
                <p>
                  <b>Condition:</b> {returnRecord.inspection.condition} ·{' '}
                  <b>Outcome:</b> {returnRecord.inspection.outcome}
                </p>
                <p>
                  <b>Damage Reason:</b> {returnRecord.inspection.damageReason || 'None'}
                </p>
                <p>
                  <b>Notes:</b> {returnRecord.inspection.notes || '—'}
                </p>
              </>
            ) : (
              <p className="text-slate-500">Pending collection-centre inspection.</p>
            )}
            <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-1">
              <p>
                <b>Original Deposit:</b> {returnRecord.refundEligibility.currency}{' '}
                {returnRecord.refundEligibility.originalDeposit.toFixed(2)}
              </p>
              <p>
                <b>Total Deductions:</b> {returnRecord.refundEligibility.currency}{' '}
                {returnRecord.refundEligibility.totalDeductions.toFixed(2)}
              </p>
              <p className="font-bold text-emerald-700 dark:text-emerald-400">
                Calculated Eligible Refund: {returnRecord.refundEligibility.currency}{' '}
                {returnRecord.refundEligibility.calculatedAmount.toFixed(2)}
              </p>
            </div>
          </div>
        </div>

        {returnRecord.refundEligibility.deductionBreakdown.length > 0 && (
          <div className="p-4 rounded-2xl border border-amber-200 dark:border-amber-800/40 bg-amber-50/50 dark:bg-amber-950/20 space-y-2 text-xs">
            <p className="font-black uppercase text-[10px] tracking-wider text-amber-700 dark:text-amber-300">
              Auditable Deduction Breakdown ({returnRecord.refundEligibility.ruleVersion})
            </p>
            {returnRecord.refundEligibility.deductionBreakdown.map((item) => (
              <div key={item.code} className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-bold">{item.label}</p>
                  <p className="text-slate-500">{item.reason}</p>
                </div>
                <span className="font-mono font-bold text-rose-600">
                  -{returnRecord.refundEligibility.currency} {item.amount.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 space-y-2 text-xs">
          <p className="font-black uppercase text-[10px] tracking-wider text-slate-400">
            PayPal Capture Partial Refund Status
          </p>
          {refundLoading && <p className="text-slate-400">Loading refund record...</p>}
          {refundError && <p className="text-rose-600">{refundError}</p>}
          {!refundLoading && !refund && (
            <p className="text-slate-500">No PayPal refund executed yet for this return.</p>
          )}
          {refund && (
            <div className="space-y-1">
              <p>
                <b>State:</b> <span className="font-mono font-bold">{refund.state}</span> ·{' '}
                <b>Provider Status:</b> {refund.providerStatus || '—'}
              </p>
              <p>
                <b>PayPal Refund ID:</b>{' '}
                <span className="font-mono">{refund.providerRefundId || 'Pending response'}</span>
              </p>
              <p>
                <b>Original Capture ID:</b> <span className="font-mono">{refund.captureId}</span>
              </p>
              <p>
                <b>Refunded Amount:</b> {refund.currency} {refund.amount.toFixed(2)}
              </p>
              {refund.failureReason && (
                <p className="text-rose-600 font-semibold">Failure Reason: {refund.failureReason}</p>
              )}
            </div>
          )}
        </div>

        <div className="space-y-2 text-xs">
          <p className="font-black uppercase text-[10px] tracking-wider text-slate-400">
            Private Evidence Photos (GridFS · {returnRecord.evidenceFiles.length})
          </p>
          {returnRecord.evidenceFiles.length === 0 ? (
            <p className="text-slate-400">No evidence photos attached.</p>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3">
              {returnRecord.evidenceFiles.map((f) => (
                <div
                  key={f.fileId}
                  className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono truncate">{f.filename}</span>
                    {!previewUrls[f.fileId] && (
                      <button
                        type="button"
                        onClick={() => void handleLoadPreview(f.fileId)}
                        className="px-2.5 py-1 rounded-lg bg-indigo-600 text-white font-bold shrink-0"
                      >
                        Load Image
                      </button>
                    )}
                  </div>
                  {previewUrls[f.fileId] && (
                    <img
                      src={previewUrls[f.fileId]}
                      alt={f.filename}
                      className="rounded-xl max-h-48 w-full object-contain bg-slate-100 dark:bg-slate-950"
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

