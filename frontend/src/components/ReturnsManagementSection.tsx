import React, { useState } from 'react';
import { ApiError } from '../api/client';
import {
  approveReturnRefund,
  assignReturnPartner,
  reconcileReturnRefund,
  rejectReturn,
} from '../api/phase5';
import { DeliveryPartnerSummary, ReturnDto } from '../types/domain';
import { ReturnDetailModal } from './ReturnDetailModal';

interface ReturnsManagementSectionProps {
  title: string;
  returnsList: ReturnDto[];
  partners?: DeliveryPartnerSummary[];
  canApprove?: boolean;
  onUpdated: () => Promise<void> | void;
}

export const ReturnsManagementSection: React.FC<ReturnsManagementSectionProps> = ({
  title,
  returnsList,
  partners = [],
  canApprove = true,
  onUpdated,
}) => {
  const [selectedDetail, setSelectedDetail] = useState<ReturnDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleAssign = async (returnId: string, partnerId: string) => {
    if (!partnerId) return;
    setBusyId(returnId);
    setError(null);
    setNotice(null);
    try {
      const res = await assignReturnPartner(returnId, partnerId);
      setNotice(`Assigned partner to return ${res.returnRecord.returnNumber}.`);
      await onUpdated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign partner.');
    } finally {
      setBusyId(null);
    }
  };

  const handleApproveRefund = async (ret: ReturnDto) => {
    setBusyId(ret.id);
    setError(null);
    setNotice(null);
    try {
      const res = await approveReturnRefund(ret.id);
      setNotice(res.message);
      await onUpdated();
    } catch (err) {
      setError(err instanceof ApiError ? `[${err.code}] ${err.message}` : 'Approval failed.');
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
      await onUpdated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reconciliation failed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (ret: ReturnDto) => {
    setBusyId(ret.id);
    setError(null);
    setNotice(null);
    try {
      await rejectReturn(ret.id, 'Rejected during policy/dispute review');
      setNotice(`Return ${ret.returnNumber} marked REJECTED.`);
      await onUpdated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rejection failed.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="p-6 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-black">
          {title} ({returnsList.length})
        </h2>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-xs font-semibold text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      )}

      {returnsList.length === 0 ? (
        <p className="text-sm text-slate-400">No returns recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase text-slate-400 border-b border-slate-200 dark:border-white/10">
                <th className="py-2 pr-4">Return #</th>
                <th className="py-2 pr-4">Package</th>
                <th className="py-2 pr-4">Mode</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Inspection</th>
                <th className="py-2 pr-4">Calculated Refund</th>
                <th className="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/5 text-xs">
              {returnsList.map((ret) => (
                <tr key={ret.id}>
                  <td className="py-2.5 pr-4 font-mono font-bold">
                    {ret.returnNumber}
                    {ret.isLateReturn && (
                      <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 text-[10px]">
                        +{ret.daysLate}d
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 font-mono">{ret.packageId}</td>
                  <td className="py-2.5 pr-4">{ret.mode}</td>
                  <td className="py-2.5 pr-4 font-mono">{ret.status}</td>
                  <td className="py-2.5 pr-4">
                    {ret.inspection
                      ? `${ret.inspection.condition} (${ret.inspection.outcome})`
                      : 'Pending intake/inspect'}
                  </td>
                  <td className="py-2.5 pr-4 font-semibold">
                    {ret.refundEligibility.currency}{' '}
                    {ret.refundEligibility.calculatedAmount.toFixed(2)} /{' '}
                    {ret.refundEligibility.originalDeposit.toFixed(2)}
                  </td>
                  <td className="py-2.5 text-right space-x-1.5 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => setSelectedDetail(ret)}
                      className="px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 font-bold"
                    >
                      Details
                    </button>

                    {partners.length > 0 &&
                      !['CLOSED', 'REJECTED', 'COLLECTED', 'RECEIVED', 'UNDER_INSPECTION', 'APPROVED'].includes(
                        ret.status
                      ) && (
                        <select
                          defaultValue=""
                          disabled={busyId === ret.id}
                          onChange={(e) => void handleAssign(ret.id, e.target.value)}
                          className="px-2 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900"
                        >
                          <option value="">Assign Partner...</option>
                          {partners.map((pt) => (
                            <option key={pt.id} value={pt.id}>
                              {pt.name}
                            </option>
                          ))}
                        </select>
                      )}

                    {canApprove &&
                      ret.inspection &&
                      (ret.status === 'UNDER_INSPECTION' || ret.status === 'NEEDS_REVIEW') && (
                        <>
                          <button
                            type="button"
                            disabled={busyId === ret.id}
                            onClick={() => void handleApproveRefund(ret)}
                            className="px-2.5 py-1 rounded-lg bg-emerald-600 text-white font-bold disabled:opacity-50"
                          >
                            Approve &amp; Refund
                          </button>
                          <button
                            type="button"
                            disabled={busyId === ret.id}
                            onClick={() => void handleReject(ret)}
                            className="px-2.5 py-1 rounded-lg bg-rose-600 text-white font-bold disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </>
                      )}

                    {canApprove && ret.status === 'APPROVED' && ret.refundId && (
                      <button
                        type="button"
                        disabled={busyId === ret.id}
                        onClick={() => void handleReconcile(ret)}
                        className="px-2.5 py-1 rounded-lg bg-amber-600 text-white font-bold disabled:opacity-50"
                      >
                        Reconcile Refund
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ReturnDetailModal
        returnRecord={selectedDetail}
        onClose={() => setSelectedDetail(null)}
      />
    </section>
  );
};

