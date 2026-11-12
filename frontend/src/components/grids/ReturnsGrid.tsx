import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ColDef, ICellRendererParams } from 'ag-grid-community';
import { ApiError } from '../../api/client';
import {
  approveReturnRefund,
  assignReturnPartner,
  listReturns,
  reconcileReturnRefund,
  rejectReturn,
} from '../../api/phase5';
import { searchOperationalEntity } from '../../api/searchAndAi';
import {
  DeliveryPartnerSummary,
  InspectionCondition,
  ReturnDto,
  ReturnMode,
} from '../../types/domain';
import { ReturnDetailModal } from '../ReturnDetailModal';
import { DataGrid, GridStatusBadge } from './DataGrid';

const RETURN_STATUS_OPTIONS = [
  'REQUESTED',
  'PICKUP_SCHEDULED',
  'DROP_OFF_SELECTED',
  'COLLECTED',
  'RECEIVED',
  'UNDER_INSPECTION',
  'APPROVED',
  'REJECTED',
  'NEEDS_REVIEW',
  'CLOSED',
];

const RETURN_MODES: ReturnMode[] = ['PICKUP', 'DROP_OFF', 'NEXT_DELIVERY_SWAP'];

const CONDITION_OPTIONS: InspectionCondition[] = [
  'GOOD',
  'MINOR_WEAR',
  'MINOR_DAMAGE',
  'MAJOR_DAMAGE',
  'CONTAMINATED',
  'MISSING_PACKAGING',
  'UNUSABLE',
  'WRONG_PACKAGE',
];

const RETURN_SORTABLE: Record<string, 'returnNumber' | 'status' | 'createdAt' | 'updatedAt'> = {
  returnNumber: 'returnNumber',
  status: 'status',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
};

export interface ReturnsGridProps {
  merchantId?: string;
  partners?: DeliveryPartnerSummary[];
  canApprove?: boolean;
  refreshKey?: number;
  height?: number;
  onUpdated?: () => Promise<void> | void;
}

export const ReturnsGrid: React.FC<ReturnsGridProps> = ({
  merchantId,
  partners = [],
  canApprove = true,
  refreshKey = 0,
  height = 440,
  onUpdated,
}) => {
  const [rows, setRows] = useState<ReturnDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [statusFilter, setStatusFilter] = useState('');
  const [modeFilter, setModeFilter] = useState<ReturnMode | ''>('');
  const [conditionFilter, setConditionFilter] = useState<InspectionCondition | ''>('');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortBy, setSortBy] = useState<
    'returnNumber' | 'status' | 'createdAt' | 'updatedAt' | undefined
  >('updatedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc' | undefined>('desc');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<ReturnDto | null>(null);
  const [searchEngine, setSearchEngine] = useState<'ELASTICSEARCH' | 'MONGODB_FALLBACK' | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const loadReturns = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      if (debouncedSearch) {
        const res = await searchOperationalEntity<ReturnDto>('returns', {
          q: debouncedSearch,
          merchantId,
          status: statusFilter || undefined,
          mode: modeFilter || undefined,
          condition: conditionFilter || undefined,
          page,
          pageSize,
          sortBy,
          sortDir,
        });
        if (seq !== seqRef.current) return;
        setRows(res.items);
        setTotal(res.total);
        setSearchEngine(res.searchEngine);
      } else {
        const res = await listReturns({
          merchantId,
          status: statusFilter || undefined,
          mode: modeFilter || undefined,
          condition: conditionFilter || undefined,
          page,
          pageSize,
          sortBy,
          sortDir,
        });
        if (seq !== seqRef.current) return;
        setRows(res.items);
        setTotal(res.total);
        setSearchEngine(null);
      }
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(err instanceof ApiError ? err.message : 'Failed to load returns.');
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [
    merchantId,
    statusFilter,
    modeFilter,
    conditionFilter,
    debouncedSearch,
    page,
    pageSize,
    sortBy,
    sortDir,
    refreshKey,
  ]);

  useEffect(() => {
    void loadReturns();
  }, [loadReturns]);

  const syncAfterAction = useCallback(async () => {
    await loadReturns();
    await onUpdated?.();
  }, [loadReturns, onUpdated]);

  const handleAssign = async (returnId: string, partnerId: string) => {
    if (!partnerId) return;
    setBusyId(returnId);
    setError(null);
    setNotice(null);
    try {
      const res = await assignReturnPartner(returnId, partnerId);
      setNotice(`Assigned partner to return ${res.returnRecord.returnNumber}.`);
      await syncAfterAction();
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
      await syncAfterAction();
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
      await syncAfterAction();
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
      await syncAfterAction();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rejection failed.');
    } finally {
      setBusyId(null);
    }
  };

  const columnDefs = useMemo<ColDef<ReturnDto>[]>(
    () => [
      {
        field: 'returnNumber',
        headerName: 'Return #',
        sortable: true,
        minWidth: 150,
        cellClass: 'font-mono font-semibold',
      },
      {
        headerName: 'Order #',
        colId: 'orderNumber',
        minWidth: 140,
        cellClass: 'font-mono text-xs',
        valueGetter: (p) => p.data?.orderNumber || p.data?.orderId || '—',
      },
      {
        field: 'packageId',
        headerName: 'Package ID',
        minWidth: 135,
        cellClass: 'font-mono',
      },
      {
        field: 'mode',
        headerName: 'Mode',
        minWidth: 135,
      },
      {
        field: 'status',
        headerName: 'Status',
        sortable: true,
        minWidth: 145,
        cellRenderer: (p: ICellRendererParams<ReturnDto, string>) => (
          <GridStatusBadge value={p.value} />
        ),
      },
      {
        headerName: 'Inspection',
        colId: 'inspection',
        minWidth: 145,
        valueGetter: (p) =>
          p.data?.inspection
            ? `${p.data.inspection.condition} (${p.data.inspection.outcome})`
            : 'Pending',
      },
      {
        headerName: 'Partner',
        colId: 'partner',
        minWidth: 175,
        cellRenderer: (p: ICellRendererParams<ReturnDto>) => {
          const ret = p.data;
          if (!ret) return null;
          if (ret.assignedPartnerName) {
            return <span className="text-xs">{ret.assignedPartnerName}</span>;
          }
          if (partners.length > 0 && ret.status !== 'CLOSED' && ret.status !== 'REJECTED') {
            return (
              <select
                aria-label={`Assign partner to ${ret.returnNumber}`}
                defaultValue=""
                disabled={busyId === ret.id}
                onChange={(e) => void handleAssign(ret.id, e.target.value)}
                className="rounded border border-slate-300 dark:border-white/20 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px]"
              >
                <option value="">Assign partner...</option>
                {partners.map((partner) => (
                  <option key={partner.id} value={partner.id}>
                    {partner.name}
                  </option>
                ))}
              </select>
            );
          }
          return <span className="text-xs opacity-60">Unassigned</span>;
        },
      },
      {
        headerName: 'Refund',
        colId: 'refund',
        minWidth: 165,
        valueGetter: (p) => {
          const r = p.data;
          if (!r) return '';
          const elig = `${r.refundEligibility.currency} ${r.refundEligibility.calculatedAmount.toFixed(
            2
          )}`;
          if (r.refundSummary) {
            return `${elig} [${r.refundSummary.state}]`;
          }
          return r.refundEligibility.eligible ? `${elig} (Eligible)` : 'Not Eligible';
        },
      },
      {
        headerName: 'Actions',
        colId: 'actions',
        filter: false,
        sortable: false,
        minWidth: 230,
        flex: 1.4,
        cellRenderer: (p: ICellRendererParams<ReturnDto>) => {
          const r = p.data;
          if (!r) return null;
          const isBusy = busyId === r.id;
          return (
            <div className="flex items-center gap-1 h-full" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={() => setSelectedDetail(r)}
                className="px-2 py-1 rounded border border-slate-300 dark:border-white/20 text-[11px] font-semibold hover:border-emerald-500"
              >
                Details
              </button>
              {canApprove &&
                (r.status === 'UNDER_INSPECTION' || r.status === 'NEEDS_REVIEW') &&
                !r.refundId &&
                r.refundEligibility.eligible && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleApproveRefund(r)}
                    className="px-2 py-1 rounded bg-emerald-500 text-white text-[11px] font-semibold hover:bg-emerald-400 disabled:opacity-50"
                  >
                    {isBusy ? 'Processing...' : 'Approve & Refund'}
                  </button>
                )}
              {canApprove && r.refundId && r.status !== 'CLOSED' && (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleReconcile(r)}
                  className="px-2 py-1 rounded border border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300 text-[11px] font-semibold hover:bg-sky-500/20 disabled:opacity-50"
                >
                  Reconcile
                </button>
              )}
              {canApprove &&
                (r.status === 'UNDER_INSPECTION' || r.status === 'NEEDS_REVIEW') &&
                !r.refundId && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleReject(r)}
                    className="px-2 py-1 rounded border border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300 text-[11px] font-semibold hover:bg-rose-500/20 disabled:opacity-50"
                  >
                    Reject
                  </button>
                )}
            </div>
          );
        },
      },
    ],
    [partners, busyId, canApprove]
  );

  return (
    <div className="space-y-3">
      {notice && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-700 dark:text-emerald-200">
          {notice}
        </div>
      )}

      <DataGrid<ReturnDto>
        testId="returns-ag-grid"
        rowData={rows}
        columnDefs={columnDefs}
        getRowId={(r) => r.id}
        loading={loading}
        error={error}
        onRetry={() => void loadReturns()}
        emptyMessage="No returns match the selected filters."
        total={total}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
        onSortChange={(colId, dir) => {
          setSortBy(colId ? RETURN_SORTABLE[colId] : undefined);
          setSortDir(dir);
          setPage(1);
        }}
        exportFilename="reboxify-returns.csv"
        height={height}
        toolbar={
          <>
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search return #, order #, package, partner..."
              className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-3 py-1.5 text-xs min-w-[220px]"
            />
            <select
              aria-label="Filter returns by status"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-2.5 py-1.5 text-xs"
            >
              <option value="">All Statuses</option>
              {RETURN_STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter returns by mode"
              value={modeFilter}
              onChange={(e) => {
                setModeFilter(e.target.value as ReturnMode | '');
                setPage(1);
              }}
              className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-2.5 py-1.5 text-xs"
            >
              <option value="">All Modes</option>
              {RETURN_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter returns by inspection condition"
              value={conditionFilter}
              onChange={(e) => {
                setConditionFilter(e.target.value as InspectionCondition | '');
                setPage(1);
              }}
              className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-2.5 py-1.5 text-xs"
            >
              <option value="">All Conditions</option>
              {CONDITION_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadReturns()}
              className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 text-xs font-semibold hover:border-emerald-500/60"
            >
              Refresh
            </button>
            {searchEngine && (
              <span className="px-2 py-1 rounded-md bg-slate-100 dark:bg-slate-800 text-[10px] font-bold text-slate-600 dark:text-slate-300">
                {searchEngine === 'ELASTICSEARCH' ? 'Elasticsearch' : 'MongoDB Fallback'}
              </span>
            )}
          </>
        }
      />

      {selectedDetail && (
        <ReturnDetailModal
          returnRecord={selectedDetail}
          onClose={() => setSelectedDetail(null)}
        />
      )}
    </div>
  );
};
