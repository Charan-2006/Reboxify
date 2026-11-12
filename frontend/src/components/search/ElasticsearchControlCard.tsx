import React, { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { getSearchStatus, triggerSearchReindex } from '../../api/searchAndAi';
import { SearchStatusSnapshot } from '../../types/domain';

export const ElasticsearchControlCard: React.FC<{ onReindexed?: () => void }> = ({
  onReindexed,
}) => {
  const [status, setStatus] = useState<SearchStatusSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [reindexing, setReindexing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getSearchStatus();
      setStatus(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to read Elasticsearch status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleReindex = async (resumeJobId?: string) => {
    setReindexing(true);
    setError(null);
    setMessage(null);
    try {
      const res = await triggerSearchReindex({
        batchSize: 100,
        ...(resumeJobId ? { resumeJobId } : {}),
      });
      setMessage(
        `Reindex job ${res.reindex.jobId} finished (${res.reindex.status}): orders=${res.reindex.processedCounts.orders ?? 0}, packages=${res.reindex.processedCounts.packages ?? 0}, returns=${res.reindex.processedCounts.returns ?? 0}, transactions=${res.reindex.processedCounts.transactions ?? 0}.`
      );
      await loadStatus();
      onReindexed?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Elasticsearch reindex failed.');
    } finally {
      setReindexing(false);
    }
  };

  return (
    <section
      data-testid="elasticsearch-control-card"
      className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">
            Derived Search Index (Elasticsearch &amp; SearchOutbox)
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            MongoDB remains authoritative. SearchOutbox indexes orders, packages, returns, events, and transactions idempotently with bounded backoff.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status && (
            <span
              className={`px-2.5 py-1 rounded-full text-xs font-bold border ${
                status.elasticsearch.status === 'CONNECTED'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  : 'bg-amber-50 border-amber-200 text-amber-800'
              }`}
            >
              {status.elasticsearch.status}
            </span>
          )}
          <button
            type="button"
            onClick={() => void loadStatus()}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void handleReindex()}
            disabled={reindexing || status?.elasticsearch.status !== 'CONNECTED'}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-bold disabled:opacity-40"
          >
            {reindexing ? 'Reindexing...' : 'Rebuild Derived Index'}
          </button>
          {status?.latestReindexJob?.status === 'FAILED' && (
            <button
              type="button"
              onClick={() => void handleReindex(status.latestReindexJob?.jobId)}
              disabled={reindexing || status?.elasticsearch.status !== 'CONNECTED'}
              className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-bold disabled:opacity-40"
            >
              Resume Failed Job
            </button>
          )}
        </div>
      </div>

      {message && (
        <div className="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 text-xs text-emerald-700 dark:text-emerald-300 font-semibold">
          {message}
        </div>
      )}
      {error && (
        <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 text-xs text-rose-700 dark:text-rose-300 font-semibold">
          {error}
        </div>
      )}

      {status && (
        <div className="flex flex-wrap gap-4 text-xs text-slate-600 dark:text-slate-300">
          <span>
            Outbox Queue: <strong>{status.outbox.pending}</strong> pending •{' '}
            <strong>{status.outbox.failed}</strong> retrying •{' '}
            <strong>{status.outbox.completed}</strong> synced
          </span>
          {status.elasticsearch.status === 'NOT_CONFIGURED' && (
            <span className="text-amber-700 dark:text-amber-300">
              ELASTICSEARCH_URL not configured — operational grids automatically use MongoDB search fallback.
            </span>
          )}
          {status.latestReindexJob && (
            <span>
              Last Reindex ({status.latestReindexJob.jobId}):{' '}
              <strong>{status.latestReindexJob.status}</strong>
            </span>
          )}
        </div>
      )}
    </section>
  );
};

