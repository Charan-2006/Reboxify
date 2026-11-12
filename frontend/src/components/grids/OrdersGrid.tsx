import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ColDef, ICellRendererParams } from 'ag-grid-community';
import { ApiError } from '../../api/client';
import { listOrders } from '../../api/phase2';
import { searchOperationalEntity } from '../../api/searchAndAi';
import { OrderDto } from '../../types/domain';
import { DataGrid, GridStatusBadge } from './DataGrid';

const ORDER_STATUS_OPTIONS = [
  'PLACED',
  'PAYMENT_PENDING',
  'PAID',
  'ALLOCATED',
  'DISPATCHED',
  'DELIVERED',
  'CANCELLED',
];

const ORDER_SORTABLE: Record<
  string,
  'orderNumber' | 'status' | 'grandTotal' | 'depositTotal' | 'createdAt' | 'updatedAt'
> = {
  orderNumber: 'orderNumber',
  status: 'status',
  'totals.grandTotal': 'grandTotal',
  'totals.depositTotal': 'depositTotal',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
};

export interface OrdersGridProps {
  merchantId?: string;
  refreshKey?: number;
  height?: number;
  renderActions?: (order: OrderDto) => React.ReactNode;
  onRowClick?: (order: OrderDto) => void;
}

export const OrdersGrid: React.FC<OrdersGridProps> = ({
  merchantId,
  refreshKey = 0,
  height = 420,
  renderActions,
  onRowClick,
}) => {
  const [rows, setRows] = useState<OrderDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [statusFilter, setStatusFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortBy, setSortBy] = useState<
    'orderNumber' | 'status' | 'grandTotal' | 'depositTotal' | 'createdAt' | 'updatedAt' | undefined
  >('createdAt');
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

  const loadOrders = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      if (debouncedSearch) {
        const res = await searchOperationalEntity<OrderDto>('orders', {
          q: debouncedSearch,
          merchantId,
          status: statusFilter || undefined,
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
        const res = await listOrders({
          merchantId,
          status: statusFilter || undefined,
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
      setError(err instanceof ApiError ? err.message : 'Failed to load orders.');
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [merchantId, statusFilter, debouncedSearch, page, pageSize, sortBy, sortDir, refreshKey]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  const columnDefs = useMemo<ColDef<OrderDto>[]>(() => {
    const cols: ColDef<OrderDto>[] = [
      {
        field: 'orderNumber',
        headerName: 'Order #',
        sortable: true,
        minWidth: 145,
        cellClass: 'font-mono font-semibold',
      },
      {
        field: 'status',
        headerName: 'Status',
        sortable: true,
        minWidth: 140,
        cellRenderer: (p: ICellRendererParams<OrderDto, string>) => (
          <GridStatusBadge value={p.value} />
        ),
      },
      {
        headerName: 'Recipient / Zone',
        colId: 'recipient',
        minWidth: 170,
        valueGetter: (p) =>
          p.data
            ? `${p.data.shippingReference?.recipientName ?? '—'} (${p.data.shippingReference?.zone ?? '—'})`
            : '',
      },
      {
        headerName: 'Packages',
        colId: 'allocatedPackages',
        minWidth: 165,
        valueGetter: (p) =>
          p.data?.allocatedPackages?.length
            ? p.data.allocatedPackages.map((a) => `${a.packageId} (${a.packageClass})`).join(', ')
            : 'Unallocated',
      },
      {
        headerName: 'Deposit',
        colId: 'totals.depositTotal',
        sortable: true,
        minWidth: 110,
        valueGetter: (p) =>
          p.data ? `${p.data.currency} ${(p.data.totals?.depositTotal ?? 0).toFixed(2)}` : '',
      },
      {
        headerName: 'Grand Total',
        colId: 'totals.grandTotal',
        sortable: true,
        minWidth: 120,
        valueGetter: (p) =>
          p.data ? `${p.data.currency} ${(p.data.totals?.grandTotal ?? 0).toFixed(2)}` : '',
      },
      {
        field: 'createdAt',
        headerName: 'Created',
        sortable: true,
        minWidth: 155,
        valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString() : '—'),
      },
    ];

    if (renderActions) {
      cols.push({
        headerName: 'Actions',
        colId: 'actions',
        filter: false,
        sortable: false,
        minWidth: 170,
        flex: 1.2,
        cellRenderer: (p: ICellRendererParams<OrderDto>) =>
          p.data ? (
            <div className="flex items-center gap-1.5 h-full" onClick={(e) => e.stopPropagation()}>
              {renderActions(p.data)}
            </div>
          ) : null,
      });
    }
    return cols;
  }, [renderActions]);

  return (
    <DataGrid<OrderDto>
      testId="orders-ag-grid"
      rowData={rows}
      columnDefs={columnDefs}
      getRowId={(r) => r.id}
      loading={loading}
      error={error}
      onRetry={() => void loadOrders()}
      emptyMessage="No orders match the current filters."
      total={total}
      page={page}
      pageSize={pageSize}
      onPageChange={setPage}
      onPageSizeChange={(size) => {
        setPageSize(size);
        setPage(1);
      }}
      onSortChange={(colId, dir) => {
        setSortBy(colId ? ORDER_SORTABLE[colId] : undefined);
        setSortDir(dir);
        setPage(1);
      }}
      onRowClick={onRowClick}
      exportFilename="reboxify-orders.csv"
      height={height}
      toolbar={
        <>
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search order #, recipient, package..."
            className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-3 py-1.5 text-xs text-slate-900 dark:text-slate-100 min-w-[250px]"
          />
          <select
            aria-label="Filter orders by status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-3 py-1.5 text-xs text-slate-900 dark:text-slate-100"
          >
            <option value="">All Statuses</option>
            {ORDER_STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void loadOrders()}
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

