import React, { useEffect, useState } from 'react';
import { fetchSystemHealth } from '../api/client';
import { HealthResponse } from '../types/domain';

export const SystemStatusBanner: React.FC = () => {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchSystemHealth()
      .then((data) => {
        if (active) {
          setHealth(data);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Backend health check failed');
        }
      });

    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <div className="rounded-2xl border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700/40 px-5 py-4 text-xs text-amber-900 dark:text-amber-200 flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="font-bold uppercase tracking-wider mr-2">Backend Disconnected</span>
          <span>{error}</span>
        </div>
        <span className="text-[11px] opacity-80">Auth & persistence require Express API + MongoDB</span>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-white/60 dark:bg-white/[0.03] px-5 py-3 text-xs text-slate-500 dark:text-slate-400">
        Checking backend and integration readiness...
      </div>
    );
  }

  const statuses = health.integrations.statuses;
  const geminiStatus = statuses?.gemini ?? (health.integrations.geminiConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED');
  const esStatus =
    statuses?.elasticsearch ?? (health.integrations.elasticsearchConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED');

  const badges = [
    { label: 'MongoDB', ok: health.database.connected, sub: health.database.replicaSetSupported ? 'Replica Set' : 'Standby/Unconfigured' },
    { label: 'PayPal Sandbox', ok: health.integrations.paypalSandboxConfigured, sub: health.integrations.paypalSandboxConfigured ? 'Configured' : 'Not Configured' },
    ...(health.worker
      ? [{ label: 'Worker', ok: health.worker.status === 'HEALTHY', sub: health.worker.status }]
      : []),
    {
      label: 'Gemini API',
      ok: geminiStatus === 'HEALTHY' || geminiStatus === 'CONFIGURED',
      sub: geminiStatus,
    },
    {
      label: 'Elasticsearch',
      ok: esStatus === 'CONNECTED' || esStatus === 'HEALTHY',
      sub: esStatus,
    },
    {
      label: 'Scheduler',
      ok:
        health.integrations.bryntumSchedulerMode === 'READY' ||
        health.integrations.bryntumSchedulerMode === 'CONNECTED' ||
        health.integrations.bryntumSchedulerMode === 'COMMUNITY_READY',
      sub: health.integrations.pickupSchedulerConfigured
        ? `${health.integrations.bryntumSchedulerMode}`
        : health.integrations.bryntumSchedulerMode,
    },
  ];

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-white/80 dark:bg-white/[0.03] px-5 py-4 text-xs flex flex-wrap items-center justify-between gap-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
        <span className="font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider">
          API Online ({health.currency})
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {badges.map((b) => (
          <span
            key={b.label}
            className={`px-3 py-1 rounded-full font-semibold border ${
              b.ok
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/20'
                : 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-white/5 dark:text-slate-400 dark:border-white/10'
            }`}
          >
            {b.label}: {b.sub}
          </span>
        ))}
      </div>
    </div>
  );
};

