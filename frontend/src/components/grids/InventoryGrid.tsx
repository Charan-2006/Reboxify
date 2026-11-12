import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ColDef, ICellRendererParams } from 'ag-grid-community';
import { ApiError } from '../../api/client';
import { listInventory } from '../../api/phase2';
import { searchOperationalEntity } from '../../api/searchAndAi';
import { PackageClass, PackageDto, PackageOwnerType } from '../../types/domain';
import { DataGrid, GridStatusBadge } from './DataGrid';

const STATUS_OPTIONS = [
  'AVAILABLE',
  'RESERVED',
  'PACKED',
  'DISPATCHED',
  'WITH_CUSTOMER',
  'RETURN_REQUESTED',
  'COLLECTED',
  'AT_CENTRE',
  'INSPECTED',
  'CLEANING',
  'REPAIR',
  'QUARANTINED',
  'UNDER_INVESTIGATION',
  'RETIRED',
];

const CLASS_OPTIONS: PackageClass[] = ['S', 'M', 'L', 'XL'];
const OWNER_OPTIONS: PackageOwnerType[] = ['REBOXIFY_POOL', 'MERCHANT', 'HYBRID'];
const CONDITION_OPTIONS = ['NEW', 'GOOD', 'MINOR_WEAR', 'DAMAGED', 'CONTAMINATED'];

const INVENTORY_SORTABLE: Record<
  string,
  'packageId' | 'packageClass' | 'status' | 'condition' | 'reuseCount' | 'updatedAt'
> = {
  packageId: 'packageId',
  packageClass: 'packageClass',
  status: 'status',
  condition: 'condition',
  reuseCount: 'reuseCount',
  updatedAt: 'updatedAt',
};

export interface InventoryGridProps {
  merchantId?: string;
  refreshKey?: number;
  height?: number;
  onViewPassport?: (packageId: string) => void;
  onSelectForScan?: (packageId: string) => void;
}

export const InventoryGrid: React.FC<InventoryGridProps> = ({
  merchantId,
  refreshKey = 0,
  height = 420,
  onViewPassport,
  onSelectForScan,
}) => {
  const [rows, setRows] = useState<PackageDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [statusFilter, setStatusFilter] = useState('');
  const [classFilter, setClassFilter] = useState<PackageClass | ''>('');
  const [ownerFilter, setOwnerFilter] = useState<PackageOwnerType | ''>('');
  const [conditionFilter, setConditionFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortBy, setSortBy] = useState<
    'packageId' | 'packageClass' | 'status' | 'condition' | 'reuseCount' | 'updatedAt' | undefined
  >('updatedAt');
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

  const loadInventory = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      if (debouncedSearch) {
        const res = await searchOperationalEntity<PackageDto>('inventory', {
          q: debouncedSearch,
          merchantId,
          status: statusFilter || undefined,
          packageClass: classFilter || undefined,
          ownerType: ownerFilter || undefined,
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
        const res = await listInventory({
          merchantId,
          status: statusFilter || undefined,
          packageClass: classFilter || undefined,
          ownerType: ownerFilter || undefined,
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
      setError(err instanceof ApiError ? err.message : 'Failed to load packaging inventory.');
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [
    merchantId,
    statusFilter,
    classFilter,
    ownerFilter,
    conditionFilter,
    debouncedSearch,
    page,
    pageSize,
    sortBy,
    sortDir,
    refreshKey,
  ]);

  useEffect(() => {
    void loadInventory();
  }, [loadInventory]);

  const columnDefs = useMemo<ColDef<PackageDto>[]>(() => {
    const cols: ColDef<PackageDto>[] = [
      {
        field: 'packageId',
        headerName: 'Package ID',
        sortable: true,
        minWidth: 145,
        cellClass: 'font-mono font-semibold',
      },
      {
        field: 'packageClass',
        headerName: 'Class',
        sortable: true,
        minWidth: 85,
      },
      {
        field: 'ownerType',
        headerName: 'Owner Model',
        minWidth: 135,
      },
      {
        field: 'status',
        headerName: 'Status',
        sortable: true,
        minWidth: 145,
        cellRenderer: (p: ICellRendererParams<PackageDto, string>) => (
          <GridStatusBadge value={p.value} />
        ),
      },
      {
        field: 'condition',
        headerName: 'Condition',
        sortable: true,
        minWidth: 125,
        cellRenderer: (p: ICellRendererParams<PackageDto, string>) => (
          <GridStatusBadge value={p.value} />
        ),
      },
      {
        field: 'reuseCount',
        headerName: 'Reuse / Limit',
        sortable: true,
        minWidth: 115,
        valueGetter: (p) =>
          p.data ? `${p.data.reuseCount} / ${p.data.maxLifecycleLimit}` : '0',
      },
      {
        headerName: 'Deposit',
        colId: 'depositAmount',
        minWidth: 100,
        valueGetter: (p) =>
          p.data ? `${p.data.currency} ${p.data.depositAmount.toFixed(2)}` : '',
      },
      {
        field: 'fulfilmentLocation',
        headerName: 'Location',
        minWidth: 140,
      },
      {
        headerName: 'Custodian',
        colId: 'custodian',
        minWidth: 165,
        valueGetter: (p) =>
          p.data ? `${p.data.currentCustodian?.label ?? '—'} (${p.data.currentCustodian?.custodianType ?? ''})` : '',
      },
    ];

    if (onViewPassport || onSelectForScan) {
      cols.push({
        headerName: 'Actions',
        colId: 'actions',
        filter: false,
        sortable: false,
        minWidth: 165,
        cellRenderer: (p: ICellRendererParams<PackageDto>) =>
          p.data ? (
            <div className="flex items-center gap-1.5 h-full" onClick={(e) => e.stopPropagation()}>
              {onViewPassport && (
                <button
                  type="button"
                  onClick={() => onViewPassport(p.data!.packageId)}
                  className="px-2 py-1 rounded-md border border-slate-300 dark:border-white/20 text-[11px] font-semibold hover:border-emerald-500"
                >
                  Passport
                </button>
              )}
              {onSelectForScan && (
                <button
                  type="button"
                  onClick={() => onSelectForScan(p.data!.packageId)}
                  className="px-2 py-1 rounded-md bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 text-[11px] font-semibold hover:bg-emerald-500/25"
                >
                  Scan
                </button>
              )}
            </div>
          ) : null,
      });
    }

    return cols;
  }, [onViewPassport, onSelectForScan]);

  return (
    <DataGrid<PackageDto>
      testId="inventory-ag-grid"
      rowData={rows}
      columnDefs={columnDefs}
      getRowId={(r) => r.packageId}
      loading={loading}
      error={error}
      onRetry={() => void loadInventory()}
      emptyMessage="No packaging inventory units match the filters."
      total={total}
      page={page}
      pageSize={pageSize}
      onPageChange={setPage}
      onPageSizeChange={(size) => {
        setPageSize(size);
        setPage(1);
      }}
      onSortChange={(colId, dir) => {
        setSortBy(colId ? INVENTORY_SORTABLE[colId] : undefined);
        setSortDir(dir);
        setPage(1);
      }}
      exportFilename="reboxify-inventory.csv"
      height={height}
      toolbar={
        <>
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search package ID, hub, custodian..."
            className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-3 py-1.5 text-xs min-w-[200px]"
          />
          <select
            aria-label="Filter inventory by status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-2.5 py-1.5 text-xs"
          >
            <option value="">All Statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter inventory by class"
            value={classFilter}
            onChange={(e) => {
              setClassFilter(e.target.value as PackageClass | '');
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-2.5 py-1.5 text-xs"
          >
            <option value="">All Classes</option>
            {CLASS_OPTIONS.map((c) => (
              <option key={c} value={c}>
                Class {c}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter inventory by owner"
            value={ownerFilter}
            onChange={(e) => {
              setOwnerFilter(e.target.value as PackageOwnerType | '');
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-2.5 py-1.5 text-xs"
          >
            <option value="">All Owners</option>
            {OWNER_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter inventory by condition"
            value={conditionFilter}
            onChange={(e) => {
              setConditionFilter(e.target.value);
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
            onClick={() => void loadInventory()}
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

