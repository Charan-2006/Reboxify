import React, { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { askAiInsights, getAiStatus, getAiSummary } from '../../api/searchAndAi';
import { OperationalInsightsResponse } from '../../types/domain';

interface OperationalAiPanelProps {
  title?: string;
  merchantId?: string;
}

const SUGGESTED_QUESTIONS = [
  'How many returns are pending inspection?',
  'Which packages are unavailable or in cleaning?',
  'Which partners have high pickup workloads?',
  'How many packages are ready for reuse?',
  'What are the common return issues?',
];

export const OperationalAiPanel: React.FC<OperationalAiPanelProps> = ({
  title = 'Gemini Operational Insights Assistant',
  merchantId,
}) => {
  const [aiStatusInfo, setAiStatusInfo] = useState<{
    status: string;
    model: string;
    message?: string;
  } | null>(null);
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latestResponse, setLatestResponse] = useState<OperationalInsightsResponse | null>(null);
  const [history, setHistory] = useState<
    Array<{ role: 'user' | 'assistant'; content: string; aiGenerated?: boolean }>
  >([]);

  useEffect(() => {
    let active = true;
    getAiStatus()
      .then((res) => {
        if (active) {
          setAiStatusInfo({
            status: res.gemini.status,
            model: res.gemini.model,
            message: res.gemini.message,
          });
        }
      })
      .catch(() => {
        if (active) {
          setAiStatusInfo({ status: 'DEGRADED', model: 'gemini-2.5-flash' });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const submitQuestion = async (promptText: string) => {
    const clean = promptText.trim();
    if (!clean || loading) return;
    setLoading(true);
    setError(null);
    try {
      const apiHistory = history.slice(-6).map((h) => ({
        role: h.role,
        content: h.content,
      }));
      const res = await askAiInsights({
        question: clean,
        merchantId,
        history: apiHistory,
      });
      setLatestResponse(res);
      const replyText =
        res.answer ??
        `Gemini API disabled on backend — Live facts: ${res.measuredFacts.packages.availableForReuse} available packages, ${res.measuredFacts.returns.pendingInspectionCount} returns pending inspection, ${res.measuredFacts.packages.cleaningCount} in cleaning.`;
      setHistory((prev) => [
        ...prev.slice(-8),
        { role: 'user', content: clean },
        { role: 'assistant', content: replyText, aiGenerated: res.aiGenerated },
      ]);
      setQuestion('');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to query Gemini Operational Insights Assistant.'
      );
    } finally {
      setLoading(false);
    }
  };

  const runFocusSummary = async (focus: 'OVERVIEW' | 'REUSE' | 'RETURNS' | 'PICKUPS') => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getAiSummary({ focus, merchantId });
      setLatestResponse(res);
      const replyText =
        res.answer ??
        `Gemini API disabled — Live ${focus} metrics loaded from MongoDB.`;
      setHistory((prev) => [
        ...prev.slice(-8),
        { role: 'user', content: `Executive ${focus} Summary` },
        { role: 'assistant', content: replyText, aiGenerated: res.aiGenerated },
      ]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to generate operational summary.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section
      data-testid="gemini-operational-ai-panel"
      className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold tracking-tight">{title}</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Audited read-only assistant powered by live MongoDB operational aggregates. Refunds and PayPal remain strictly deterministic.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className={`px-2.5 py-1 rounded-full font-bold border ${
              aiStatusInfo?.status === 'HEALTHY'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950/40 dark:border-emerald-800 dark:text-emerald-300'
                : 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-200'
            }`}
          >
            Gemini: {aiStatusInfo ? `${aiStatusInfo.status} (${aiStatusInfo.model})` : 'Checking...'}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ['OVERVIEW', 'Overview Summary'],
            ['REUSE', 'Reuse & Inventory'],
            ['RETURNS', 'Returns & Damage'],
            ['PICKUPS', 'Partner Workloads'],
          ] as const
        ).map(([focus, label]) => (
          <button
            key={focus}
            type="button"
            disabled={loading}
            onClick={() => void runFocusSummary(focus)}
            className="px-3 py-1.5 rounded-lg bg-indigo-600/10 hover:bg-indigo-600/20 text-indigo-700 dark:text-indigo-300 text-xs font-bold disabled:opacity-50"
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {SUGGESTED_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            disabled={loading}
            onClick={() => void submitQuestion(q)}
            className="px-2.5 py-1 rounded-full border border-slate-200 dark:border-slate-700 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:border-emerald-500/60 disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submitQuestion(question);
        }}
        className="flex flex-wrap gap-2"
      >
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask an operational question (e.g., How many boxes need cleaning?)"
          maxLength={800}
          className="flex-1 min-w-[240px] rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-xs"
        />
        <button
          type="submit"
          disabled={loading || question.trim().length < 3}
          className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 disabled:opacity-50"
        >
          {loading ? 'Analyzing...' : 'Ask Gemini'}
        </button>
      </form>

      {error && (
        <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-xs text-rose-700 dark:text-rose-300 font-semibold">
          {error}
        </div>
      )}

      {latestResponse && (
        <div className="grid lg:grid-cols-2 gap-4 pt-2 border-t border-slate-200 dark:border-slate-800">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-black uppercase tracking-wider text-slate-500">
                {latestResponse.aiGenerated
                  ? `AI-Generated Response (${latestResponse.modelName})`
                  : 'Gemini Disabled — Measured Metrics Fallback'}
              </span>
            </div>
            {latestResponse.answer ? (
              <p className="text-xs leading-relaxed text-slate-800 dark:text-slate-200 bg-slate-50 dark:bg-slate-950/60 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800">
                {latestResponse.answer}
              </p>
            ) : (
              <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3.5 rounded-xl border border-amber-200 dark:border-amber-800">
                GEMINI_API_KEY is not configured on the backend; showing verified MongoDB operational metrics only.
              </p>
            )}

            {latestResponse.recommendations.length > 0 && (
              <div className="space-y-1.5">
                <h4 className="text-[11px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
                  AI Recommendations (Advisory)
                </h4>
                <ul className="space-y-1 text-xs text-slate-700 dark:text-slate-300 list-disc pl-4">
                  {latestResponse.recommendations.map((rec, idx) => (
                    <li key={idx}>{rec}</li>
                  ))}
                </ul>
              </div>
            )}

            {latestResponse.caveats.length > 0 && (
              <p className="text-[11px] text-slate-500">
                Caveats: {latestResponse.caveats.join(' • ')}
              </p>
            )}
          </div>

          <div className="space-y-2 bg-slate-50 dark:bg-slate-950/60 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
            <h4 className="text-[11px] font-black uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
              Measured Facts ({latestResponse.measuredFacts.scope})
            </h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <div className="p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <div className="text-[10px] text-slate-500">Ready for Reuse</div>
                <div className="font-black text-base">
                  {latestResponse.measuredFacts.packages.availableForReuse}
                </div>
              </div>
              <div className="p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <div className="text-[10px] text-slate-500">In Cleaning</div>
                <div className="font-black text-base">
                  {latestResponse.measuredFacts.packages.cleaningCount}
                </div>
              </div>
              <div className="p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <div className="text-[10px] text-slate-500">Repair/Quarantine</div>
                <div className="font-black text-base">
                  {latestResponse.measuredFacts.packages.repairOrQuarantineCount}
                </div>
              </div>
              <div className="p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <div className="text-[10px] text-slate-500">Pending Inspection</div>
                <div className="font-black text-base">
                  {latestResponse.measuredFacts.returns.pendingInspectionCount}
                </div>
              </div>
              <div className="p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <div className="text-[10px] text-slate-500">Unassigned Pickups</div>
                <div className="font-black text-base">
                  {latestResponse.measuredFacts.pickups.unassignedCount}
                </div>
              </div>
              <div className="p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <div className="text-[10px] text-slate-500">Avg Reuse Cycles</div>
                <div className="font-black text-base">
                  {latestResponse.measuredFacts.packages.averageReuseCycles}
                </div>
              </div>
            </div>
            <p className="text-[10px] text-slate-500 pt-1">{latestResponse.disclaimer}</p>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="space-y-1.5 pt-2 border-t border-slate-200 dark:border-slate-800 max-h-40 overflow-y-auto">
          {history.map((turn, idx) => (
            <div key={idx} className="text-[11px] flex gap-2">
              <span className="font-bold uppercase text-slate-500 shrink-0">
                {turn.role === 'user' ? 'You:' : turn.aiGenerated ? 'Gemini:' : 'Facts:'}
              </span>
              <span className="text-slate-700 dark:text-slate-300">{turn.content}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

