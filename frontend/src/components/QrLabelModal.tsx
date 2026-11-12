import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { QrLabelData } from '../types/domain';

interface QrLabelModalProps {
  label: QrLabelData | null;
  onClose: () => void;
}

export const QrLabelModal: React.FC<QrLabelModalProps> = ({ label, onClose }) => {
  const [copied, setCopied] = useState(false);

  if (!label) return null;

  const handleCopyToken = async () => {
    try {
      await navigator.clipboard.writeText(label.qrToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable in restricted contexts.
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-3xl border border-slate-200 dark:border-slate-700 max-w-lg w-full p-6 shadow-2xl space-y-5 print:shadow-none print:border-black">
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
              Signed ReBoxify Passport Label · v{label.tokenVersion}
            </span>
            <h3 className="text-2xl font-black font-mono mt-1">{label.packageId}</h3>
            <p className="text-xs text-slate-500">
              Class {label.packageClass} · {label.material} · Hub {label.fulfilmentLocation}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 print:hidden"
          >
            Close
          </button>
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-6 p-5 rounded-2xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-slate-800">
          <div className="bg-white p-3 rounded-2xl border border-slate-200 shrink-0">
            <QRCodeSVG value={label.qrToken} size={156} level="M" includeMargin={false} />
          </div>
          <div className="space-y-2 text-xs flex-1">
            <p className="font-bold uppercase tracking-wider text-slate-500">
              Zero-PII Authenticated Payload
            </p>
            <p>
              <b>Owner Model:</b> {label.ownerType}
            </p>
            <p>
              <b>Max Load:</b> {label.maxWeightKg} kg ({label.dimensionsCm.length}×
              {label.dimensionsCm.width}×{label.dimensionsCm.height} cm)
            </p>
            <p>
              <b>Protection:</b> {label.protectionCategory}
              {label.supportsLiquidContainment ? ' + Liquid Seal' : ''}
            </p>
            <p>
              <b>Valid Until:</b> {new Date(label.expiresAt).toLocaleDateString()}
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            Handling Instructions
          </p>
          <ul className="text-xs text-slate-600 dark:text-slate-300 space-y-1 list-disc pl-4">
            {label.handlingInstructions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>

        <div className="space-y-2 print:hidden">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            Signed QR Token (Copy for Manual Scanner Verification)
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              value={label.qrToken}
              className="flex-1 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono text-[11px]"
            />
            <button
              type="button"
              onClick={() => void handleCopyToken()}
              className="px-4 py-2 rounded-xl bg-slate-900 dark:bg-slate-700 text-white text-xs font-bold shrink-0"
            >
              {copied ? 'Copied' : 'Copy Token'}
            </button>
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2 print:hidden">
          <button
            type="button"
            onClick={() => window.print()}
            className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-black uppercase tracking-widest hover:bg-indigo-700"
          >
            Print QR Label
          </button>
        </div>
      </div>
    </div>
  );
};

