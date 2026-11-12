import React from 'react';
import { DigitalPassportView } from '../types/domain';

interface PassportViewerModalProps {
  passport: DigitalPassportView | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
}

export const PassportViewerModal: React.FC<PassportViewerModalProps> = ({
  passport,
  loading,
  error,
  onClose,
}) => {
  if (!passport && !loading && !error) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-3xl border border-slate-200 dark:border-slate-700 max-w-3xl w-full p-6 shadow-2xl space-y-5 my-8 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
          <div>
            <span className="text-[10px] font-black uppercase tracking-widest text-indigo-600 dark:text-indigo-400">
              Digital Packaging Passport
            </span>
            <h3 className="text-2xl font-black font-mono mt-0.5">
              {passport?.packageId ?? 'Loading Passport...'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
          >
            Close
          </button>
        </div>

        {loading && <p className="text-sm text-slate-500">Verifying passport access & history...</p>}
        {error && (
          <div className="p-4 rounded-2xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-sm text-red-700 dark:text-red-300 font-semibold">
            {error}
          </div>
        )}

        {passport && (
          <>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              <div className="p-3 rounded-2xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-slate-800">
                <p className="text-slate-400 font-bold uppercase text-[10px]">Status</p>
                <p className="font-mono font-black text-sm mt-1">{passport.status}</p>
                <p className="text-slate-500 mt-0.5">Condition: {passport.condition}</p>
              </div>
              <div className="p-3 rounded-2xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-slate-800">
                <p className="text-slate-400 font-bold uppercase text-[10px]">Specs</p>
                <p className="font-bold text-sm mt-1">Class {passport.packageClass}</p>
                <p className="text-slate-500 mt-0.5">
                  {passport.dimensionsCm.length}×{passport.dimensionsCm.width}×
                  {passport.dimensionsCm.height}cm · {passport.maxWeightKg}kg
                </p>
              </div>
              <div className="p-3 rounded-2xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-slate-800">
                <p className="text-slate-400 font-bold uppercase text-[10px]">QR Security</p>
                <p className="font-bold text-sm mt-1">
                  v{passport.qrSecurity.tokenVersion} ·{' '}
                  {passport.qrSecurity.revoked ? 'REVOKED' : 'ACTIVE'}
                </p>
                <p className="text-slate-500 mt-0.5">HMAC-SHA256 Signed</p>
              </div>
              <div className="p-3 rounded-2xl bg-emerald-500/5 border border-emerald-500/20">
                <p className="text-emerald-700 dark:text-emerald-400 font-bold uppercase text-[10px]">
                  Verified Reuse
                </p>
                <p className="font-black text-sm mt-1">
                  {passport.reuseCount} / {passport.maxLifecycleLimit} cycles
                </p>
                <p className="text-slate-500 mt-0.5">
                  {passport.sustainability.verified ? 'Verified impact' : 'Pending first return'}
                </p>
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-4 text-xs">
              <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 space-y-1.5">
                <p className="font-black uppercase text-[10px] tracking-wider text-slate-400">
                  Ownership vs Custody Separation
                </p>
                <p>
                  <b>Owner:</b> {passport.ownership.ownerType} ({passport.ownership.ownerLabel})
                </p>
                <p>
                  <b>Current Custodian:</b> {passport.currentCustodian.custodianType} —{' '}
                  {passport.currentCustodian.label}
                </p>
                <p>
                  <b>Hub Location:</b> {passport.fulfilmentLocation}
                </p>
                {passport.assignedPartner && (
                  <p>
                    <b>Assigned Delivery Partner:</b> {passport.assignedPartner.name}
                  </p>
                )}
              </div>

              <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 space-y-1.5">
                <p className="font-black uppercase text-[10px] tracking-wider text-slate-400">
                  Order, Inspection &amp; Sustainability
                </p>
                {passport.activeOrder ? (
                  <p>
                    <b>Order:</b> <span className="font-mono">{passport.activeOrder.orderNumber}</span>{' '}
                    ({passport.activeOrder.status}) · Payment:{' '}
                    <span
                      className={
                        passport.activeOrder.paymentCaptured
                          ? 'text-emerald-600 font-bold'
                          : 'text-amber-600 font-bold'
                      }
                    >
                      {passport.activeOrder.paymentCaptured ? 'CAPTURED' : 'NOT CAPTURED'}
                    </span>
                  </p>
                ) : (
                  <p className="text-slate-500">No active allocated order.</p>
                )}
                <p>
                  <b>Last Inspection:</b>{' '}
                  {passport.cleaningAndInspection.lastInspectionOutcome
                    ? `${passport.cleaningAndInspection.lastInspectionOutcome} (${new Date(
                        passport.cleaningAndInspection.lastInspectionAt!
                      ).toLocaleString()})`
                    : 'Not inspected yet'}
                </p>
                <p>
                  <b>Last Cleaned:</b>{' '}
                  {passport.cleaningAndInspection.lastCleanedAt
                    ? new Date(passport.cleaningAndInspection.lastCleanedAt).toLocaleString()
                    : 'Not cleaned yet'}
                </p>
                <p className="text-slate-500">{passport.sustainability.verificationNote}</p>
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="text-xs font-black uppercase tracking-wider text-slate-500">
                Append-Only Lifecycle History ({passport.lifecycleHistory.length})
              </h4>
              {passport.lifecycleHistory.length === 0 ? (
                <p className="text-xs text-slate-400">No recorded lifecycle events yet.</p>
              ) : (
                <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                  {passport.lifecycleHistory.map((evt) => (
                    <div
                      key={evt.eventId}
                      className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 flex items-start justify-between gap-3 text-xs"
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold">{evt.type}</span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase ${
                              evt.outcome === 'ACCEPTED'
                                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                                : 'bg-rose-500/10 text-rose-700 dark:text-rose-400'
                            }`}
                          >
                            {evt.outcome}
                          </span>
                          <span className="text-slate-400">{evt.actorRole}</span>
                        </div>
                        <p className="text-slate-600 dark:text-slate-300">{evt.summary}</p>
                      </div>
                      <span className="text-[11px] text-slate-400 shrink-0">
                        {new Date(evt.occurredAt).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

