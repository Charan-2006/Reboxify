import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import mongoose from 'mongoose';
import { badRequest, notFound, serviceUnavailable } from '../utils/errors.js';

export const ALLOWED_EVIDENCE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024; // 5 MB MVP bound (Blueprint Section 20.1)

export interface StoredEvidenceFile {
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface RetrievedEvidenceFile {
  fileId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

export interface EvidenceStorage {
  saveEvidence(input: {
    filename: string;
    mimeType: string;
    buffer: Buffer;
    metadata?: Record<string, unknown>;
  }): Promise<StoredEvidenceFile>;
  readEvidence(fileId: string): Promise<RetrievedEvidenceFile | null>;
}

export function validateEvidenceImage(
  filename: string,
  mimeType: string,
  buffer: Buffer
): { safeFilename: string; normalizedMime: string } {
  const normalizedMime = mimeType.trim().toLowerCase();
  if (!ALLOWED_EVIDENCE_MIMES.includes(normalizedMime as (typeof ALLOWED_EVIDENCE_MIMES)[number])) {
    throw badRequest(
      `Unsupported evidence MIME type "${mimeType}". Only JPEG, PNG, and WebP images are permitted.`
    );
  }

  if (buffer.length === 0) {
    throw badRequest('Evidence file is empty.');
  }
  if (buffer.length > MAX_EVIDENCE_BYTES) {
    throw badRequest(`Evidence file exceeds ${MAX_EVIDENCE_BYTES / (1024 * 1024)} MB limit.`);
  }

  // Verify magic bytes match claimed image format to block spoofed uploads
  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng =
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  const isWebp =
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';

  if (
    (normalizedMime === 'image/jpeg' && !isJpeg) ||
    (normalizedMime === 'image/png' && !isPng) ||
    (normalizedMime === 'image/webp' && !isWebp)
  ) {
    throw badRequest('File contents do not match declared image format signature.');
  }

  const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const safeFilename = base || `evidence_${crypto.randomBytes(4).toString('hex')}`;
  return { safeFilename, normalizedMime };
}

export class GridFsEvidenceStorage implements EvidenceStorage {
  private getBucket() {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
      throw serviceUnavailable('MongoDB connection is not active for GridFS evidence storage.');
    }
    return new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: 'returnEvidence',
    });
  }

  async saveEvidence(input: {
    filename: string;
    mimeType: string;
    buffer: Buffer;
    metadata?: Record<string, unknown>;
  }): Promise<StoredEvidenceFile> {
    const { safeFilename, normalizedMime } = validateEvidenceImage(
      input.filename,
      input.mimeType,
      input.buffer
    );
    const bucket = this.getBucket();
    const uploadStream = bucket.openUploadStream(safeFilename, {
      metadata: {
        ...(input.metadata ?? {}),
        mimeType: normalizedMime,
        sizeBytes: input.buffer.length,
      },
    });

    await new Promise<void>((resolve, reject) => {
      Readable.from(input.buffer)
        .pipe(uploadStream)
        .on('error', reject)
        .on('finish', () => resolve());
    });

    return {
      fileId: uploadStream.id.toString(),
      filename: safeFilename,
      mimeType: normalizedMime,
      sizeBytes: input.buffer.length,
    };
  }

  async readEvidence(fileId: string): Promise<RetrievedEvidenceFile | null> {
    if (!mongoose.Types.ObjectId.isValid(fileId)) {
      throw notFound('Evidence file reference was not found.');
    }
    const bucket = this.getBucket();
    const objId = new mongoose.Types.ObjectId(fileId);
    const files = await bucket.find({ _id: objId }).toArray();
    if (files.length === 0) {
      return null;
    }

    const fileDoc = files[0];
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      bucket
        .openDownloadStream(objId)
        .on('data', (chunk: Buffer) => chunks.push(chunk))
        .on('error', reject)
        .on('end', () => resolve());
    });

    return {
      fileId: objId.toString(),
      filename: fileDoc.filename,
      mimeType:
        (typeof fileDoc.metadata?.mimeType === 'string' && fileDoc.metadata.mimeType) ||
        'application/octet-stream',
      buffer: Buffer.concat(chunks),
    };
  }
}

