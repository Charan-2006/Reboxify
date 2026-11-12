import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ColDef, ICellRendererParams } from 'ag-grid-community';
import { ApiError } from '../../api/client';
import { listTransactions } from '../../api/phase3';
import { searchOperationalEntity } from '../../api/searchAndAi';
import { TransactionDto } from '../../types/domain';
import { DataGrid, GridStatusBadge } from './DataGrid';

const PAYMENT_STATES = [
  'CREATED',
  'APPROVED',
  'CAPTURE_PENDING',
  'CAPTURED',
  'REFUND_REQUESTED',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'CAPTURE_FAILED',
  'REFUND_FAILED',
  'REVERSED',
  'DISPUTED',
];

const TX_SORTABLE: Record<string, 'amount' | 'state' | 'createdAt' | 'updatedAt'> = {
  amount: 'amount',
  state: 'state',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
};

export interface TransactionsGridProps {
  merchantId?: string;
  refreshKey?: number;
  height?: number;
}

export const TransactionsGrid: React.FC<TransactionsGridProps> = ({
  merchantId,
  refreshKey = 0,
  height = 420,
}) => {
  const [rows, setRows] = useState<TransactionDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [stateFilter, setStateFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortBy, setSortBy] = useState<'amount' | 'state' | 'createdAt' | 'updatedAt' | undefined>(
    'updatedAt'
  );
  const [sortDir, setSortDir] = useState<'asc' | 'desc' | undefined>('desc');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchEngine, setSearchEngine] = useState<'ELASTICSEARCH' | 'MONGODB_FALLBACK' | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const loadTransactions = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      if (debouncedSearch) {
        const res = await searchOperationalEntity<TransactionDto>('transactions', {
          q: debouncedSearch,
          merchantId,
          status: stateFilter || undefined,
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
        const res = await listTransactions({
          merchantId,
          state: stateFilter || undefined,
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
      setError(err instanceof ApiError ? err.message : 'Failed to load payment ledger.');
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [merchantId, stateFilter, debouncedSearch, page, pageSize, sortBy, sortDir, refreshKey]);

  useEffect(() => {
    void loadTransactions();
  }, [loadTransactions]);

  const columnDefs = useMemo<ColDef<TransactionDto>[]>(
    () => [
      {
        headerName: 'Order #',
        colId: 'orderNumber',
        minWidth: 145,
        cellClass: 'font-mono font-semibold',
        valueGetter: (p) => p.data?.orderNumber || p.data?.orderId || '—',
      },
      {
        field: 'state',
        headerName: 'Payment State',
        sortable: true,
        minWidth: 155,
        cellRenderer: (p: ICellRendererParams<TransactionDto, string>) => (
          <GridStatusBadge value={p.value} />
        ),
      },
      {
        field: 'amount',
        headerName: 'Amount',
        sortable: true,
        minWidth: 115,
        valueGetter: (p) => (p.data ? `${p.data.currency} ${p.data.amount.toFixed(2)}` : ''),
      },
      {
        headerName: 'Deposit Refunded',
        colId: 'refundedTotal',
        minWidth: 150,
        valueGetter: (p) => {
          const d = p.data;
          if (!d) return '';
          const allocated = d.depositAllocations.reduce((s, a) => s + a.allocatedDeposit, 0);
          const refunded =
            d.refundSummary?.refundedTotal ??
            d.depositAllocations.reduce((s, a) => s + a.refundedAmount, 0);
          const pending =
            d.refundSummary?.pendingTotal ??
            d.depositAllocations.reduce((s, a) => s + a.pendingRefundAmount, 0);
          return `${d.currency} ${refunded.toFixed(2)} / ${allocated.toFixed(2)}${
            pending > 0 ? ` (+${pending.toFixed(2)} pending)` : ''
          }`;
        },
      },
      {
        field: 'paypalOrderId',
        headerName: 'PayPal Order ID',
        minWidth: 165,
        cellClass: 'font-mono text-xs',
      },
      {
        field: 'captureId',
        headerName: 'Capture ID',
        minWidth: 165,
        cellClass: 'font-mono text-xs',
        valueGetter: (p) => p.data?.captureId || '—',
      },
      {
        field: 'providerStatus',
        headerName: 'Provider Status',
        minWidth: 130,
        valueGetter: (p) => p.data?.providerStatus || '—',
      },
      {
        field: 'updatedAt',
        headerName: 'Updated',
        sortable: true,
        minWidth: 155,
        valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString() : '—'),
      },
    ],
    []
  );

  return (
    <DataGrid<TransactionDto>
      testId="transactions-ag-grid"
      rowData={rows}
      columnDefs={columnDefs}
      getRowId={(r) => r.id}
      loading={loading}
      error={error}
      onRetry={() => void loadTransactions()}
      emptyMessage="No payment or refund transactions match the filters."
      total={total}
      page={page}
      pageSize={pageSize}
      onPageChange={setPage}
      onPageSizeChange={(size) => {
        setPageSize(size);
        setPage(1);
      }}
      onSortChange={(colId, dir) => {
        setSortBy(colId ? TX_SORTABLE[colId] : undefined);
        setSortDir(dir);
        setPage(1);
      }}
      exportFilename="reboxify-payments.csv"
      height={height}
      toolbar={
        <>
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search order #, PayPal ID, capture ID, package..."
            className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-3 py-1.5 text-xs min-w-[230px]"
          />
          <select
            aria-label="Filter transactions by payment state"
            value={stateFilter}
            onChange={(e) => {
              setStateFilter(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-2.5 py-1.5 text-xs"
          >
            <option value="">All Payment States</option>
            {PAYMENT_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void loadTransactions()}
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
  );
};

