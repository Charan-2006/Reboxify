import React, { useEffect, useId, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { ApiError } from '../api/client';
import { extractPackageIdFromQrInput, scanPackage } from '../api/phase4';
import { DeliveryPartnerSummary, DigitalPassportView, ScanAction } from '../types/domain';

interface PackageScannerPanelProps {
  title: string;
  subtitle: string;
  allowedActions: Array<{ action: ScanAction; label: string }>;
  partners?: DeliveryPartnerSummary[];
  initialPackageId?: string;
  onScanComplete?: (passport: DigitalPassportView) => void;
  onViewPassport?: (packageId: string) => void;
}

export const PackageScannerPanel: React.FC<PackageScannerPanelProps> = ({
  title,
  subtitle,
  allowedActions,
  partners = [],
  initialPackageId = '',
  onScanComplete,
  onViewPassport,
}) => {
  const scannerRegionId = useId().replace(/:/g, '_');
  const scannerRef = useRef<Html5Qrcode | null>(null);

  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const [scanMode, setScanMode] = useState<'QR_TOKEN' | 'MANUAL_SUPERVISED'>('QR_TOKEN');
  const [action, setAction] = useState<ScanAction>(allowedActions[0]?.action ?? 'PACK');
  const [packageId, setPackageId] = useState(initialPackageId);
  const [qrToken, setQrToken] = useState('');
  const [assignedPartnerUserId, setAssignedPartnerUserId] = useState('');
  const [locationRef, setLocationRef] = useState('');
  const [manualReason, setManualReason] = useState('');
  const [notes, setNotes] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanSuccess, setScanSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (initialPackageId) {
      setPackageId(initialPackageId);
    }
  }, [initialPackageId]);

  const stopCamera = async () => {
    const instance = scannerRef.current;
    scannerRef.current = null;
    if (instance) {
      try {
        await instance.stop();
      } catch {
        // Scanner may already be stopped.
      }
      try {
        instance.clear();
      } catch {
        // Ignore DOM clear errors.
      }
    }
    setCameraActive(false);
  };

  useEffect(() => {
    return () => {
      const instance = scannerRef.current;
      scannerRef.current = null;
      if (instance) {
        instance
          .stop()
          .then(() => {
            try {
              instance.clear();
            } catch {
              // Ignore
            }
          })
          .catch(() => {});
      }
    };
  }, []);

  const startCamera = async () => {
    setCameraError(null);
    if (cameraActive) {
      await stopCamera();
      return;
    }

    try {
      const qr = new Html5Qrcode(scannerRegionId);
      scannerRef.current = qr;
      setCameraActive(true);
      await qr.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decodedText) => {
          setQrToken(decodedText);
          const extracted = extractPackageIdFromQrInput(decodedText);
          if (extracted) {
            setPackageId(extracted);
          }
          setScanMode('QR_TOKEN');
          setScanSuccess('Camera decoded QR payload. Verify action and submit scan.');
          void stopCamera();
        },
        () => {
          // Frame without QR code; keep scanning.
        }
      );
    } catch (err) {
      setCameraActive(false);
      scannerRef.current = null;
      setCameraError(
        err instanceof Error
          ? `Camera unavailable (${err.message}). Paste signed QR token or use supervised fallback.`
          : 'Camera permission unavailable. Paste signed QR token or use supervised fallback.'
      );
    }
  };

  const handleTokenInputChange = (val: string) => {
    setQrToken(val);
    const extracted = extractPackageIdFromQrInput(val);
    if (extracted && !packageId.trim()) {
      setPackageId(extracted);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setScanError(null);
    setScanSuccess(null);

    const targetId = packageId.trim().toUpperCase() || extractPackageIdFromQrInput(qrToken) || '';
    if (!targetId) {
      setScanError('Package ID (RBX-...) is required.');
      return;
    }

    setSubmitting(true);
    try {
      const scanId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const res = await scanPackage(targetId, {
        action,
        scanMode,
        qrToken: scanMode === 'QR_TOKEN' ? qrToken.trim() : undefined,
        scanId,
        assignedPartnerUserId:
          (action === 'PACK' || action === 'DISPATCH') && assignedPartnerUserId
            ? assignedPartnerUserId
            : undefined,
        locationRef: locationRef.trim() || undefined,
        notes: notes.trim() || undefined,
        manualReason: scanMode === 'MANUAL_SUPERVISED' ? manualReason.trim() : undefined,
      });

      setScanSuccess(
        `Scan ACCEPTED (${res.scanMode}): ${res.package.packageId} -> ${res.package.status}` +
          (res.orderUpdated ? ' (Order status synchronized)' : '')
      );
      if (onScanComplete) {
        onScanComplete(res.passport);
      }
    } catch (err) {
      setScanError(
        err instanceof ApiError
          ? `[${err.code}] ${err.message}`
          : 'Scan verification failed.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-6 rounded-3xl bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black">{title}</h2>
          <p className="text-xs text-slate-500">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => void startCamera()}
          className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider shrink-0 ${
            cameraActive
              ? 'bg-rose-600 text-white'
              : 'bg-indigo-600 text-white hover:bg-indigo-700'
          }`}
        >
          {cameraActive ? 'Stop Camera' : 'Start Camera QR Scan'}
        </button>
      </div>

      <div
        id={scannerRegionId}
        className={
          cameraActive
            ? 'w-full max-w-sm mx-auto rounded-2xl overflow-hidden border border-indigo-400/50 bg-black min-h-[240px]'
            : 'hidden'
        }
      />

      {cameraError && (
        <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 text-xs text-amber-800 dark:text-amber-300">
          {cameraError}
        </div>
      )}

      {scanError && (
        <div className="p-3 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-xs font-semibold text-red-700 dark:text-red-300">
          {scanError}
        </div>
      )}

      {scanSuccess && (
        <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-xs font-semibold text-emerald-700 dark:text-emerald-300 flex items-center justify-between gap-2">
          <span>{scanSuccess}</span>
          {onViewPassport && packageId.trim() && (
            <button
              type="button"
              onClick={() => onViewPassport(packageId.trim().toUpperCase())}
              className="px-2.5 py-1 rounded-lg bg-emerald-700 text-white text-[11px] font-bold shrink-0"
            >
              View Passport
            </button>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3 text-sm">
        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-400 mb-1">
              Verification Mode
            </label>
            <select
              value={scanMode}
              onChange={(e) => setScanMode(e.target.value as 'QR_TOKEN' | 'MANUAL_SUPERVISED')}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-900"
            >
              <option value="QR_TOKEN">Signed QR Token (Default)</option>
              <option value="MANUAL_SUPERVISED">Manual Supervised Fallback</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-400 mb-1">
              Custody / State Action
            </label>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as ScanAction)}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-900"
            >
              {allowedActions.map((opt) => (
                <option key={opt.action} value={opt.action}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-400 mb-1">
              Package ID
            </label>
            <input
              required
              placeholder="RBX-..."
              value={packageId}
              onChange={(e) => setPackageId(e.target.value.toUpperCase())}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-900 font-mono"
            />
          </div>
        </div>

        {scanMode === 'QR_TOKEN' ? (
          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-400 mb-1">
              Signed QR Payload (RBXQR:v1....)
            </label>
            <input
              required
              placeholder="Paste decoded RBXQR:v1... token or scan via camera"
              value={qrToken}
              onChange={(e) => handleTokenInputChange(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-900 font-mono text-xs"
            />
          </div>
        ) : (
          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-400 mb-1">
              Manual Fallback Reason (Logged to Append-Only Audit Ledger)
            </label>
            <input
              required
              minLength={8}
              placeholder="e.g. Thermal label scuffed during transit; verified ID visually"
              value={manualReason}
              onChange={(e) => setManualReason(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-900"
            />
          </div>
        )}

        <div className="grid sm:grid-cols-2 gap-3">
          {(action === 'PACK' || action === 'DISPATCH') && partners.length > 0 && (
            <div>
              <label className="block text-[11px] font-bold uppercase text-slate-400 mb-1">
                Delivery Partner (Optional on PACK, Required on DISPATCH)
              </label>
              <select
                value={assignedPartnerUserId}
                onChange={(e) => setAssignedPartnerUserId(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-900"
              >
                <option value="">Use pre-assigned partner...</option>
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.email})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-400 mb-1">
              Location / Checkpoint (Optional)
            </label>
            <input
              placeholder="e.g. CHN-HUB-01 Bay 4"
              value={locationRef}
              onChange={(e) => setLocationRef(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-900"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-400 mb-1">
              Operator Notes (Optional)
            </label>
            <input
              placeholder="Operational note..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-900"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="px-5 py-2.5 rounded-xl bg-emerald-600 text-white text-xs font-black uppercase tracking-widest hover:bg-emerald-700 disabled:opacity-50"
          >
            {submitting ? 'Verifying Scan...' : `Submit ${action} Scan`}
          </button>

          {onViewPassport && packageId.trim() && (
            <button
              type="button"
              onClick={() => onViewPassport(packageId.trim().toUpperCase())}
              className="px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Inspect Passport
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

