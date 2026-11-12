import React, { useState } from 'react';
import { ApiError } from '../api/client';
import { uploadReturnEvidence } from '../api/phase5';
import { ReturnDto } from '../types/domain';

interface ReturnEvidenceUploaderProps {
  returnId: string;
  onUploaded: (updated: ReturnDto) => void;
}

export const ReturnEvidenceUploader: React.FC<ReturnEvidenceUploaderProps> = ({
  returnId,
  onUploaded,
}) => {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setOkMsg(null);

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Only JPEG, PNG, or WebP evidence images are supported.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Evidence file exceeds the 5 MB maximum limit.');
      return;
    }

    setUploading(true);
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read file.'));
        reader.onload = () => {
          const result = String(reader.result || '');
          const commaIdx = result.indexOf(',');
          resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
        };
        reader.readAsDataURL(file);
      });

      const res = await uploadReturnEvidence(returnId, {
        filename: file.name,
        mimeType: file.type,
        contentBase64,
      });
      setOkMsg(`Uploaded ${file.name} securely to GridFS.`);
      onUploaded(res.returnRecord);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Evidence upload failed.');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-1.5 text-xs">
      <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 font-bold cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800">
        <span>{uploading ? 'Uploading Photo...' : 'Upload Evidence Photo (GridFS)'}</span>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={uploading}
          onChange={(e) => void handleFileChange(e)}
          className="hidden"
        />
      </label>
      {error && <p className="text-rose-600 font-semibold">{error}</p>}
      {okMsg && <p className="text-emerald-600 font-semibold">{okMsg}</p>}
    </div>
  );
};

