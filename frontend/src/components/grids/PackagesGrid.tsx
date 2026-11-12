import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ColDef, ICellRendererParams } from 'ag-grid-community';
import { ApiError } from '../../api/client';
import { listInventory } from '../../api/phase2';
import { searchOperationalEntity } from '../../api/searchAndAi';
import { PackageClass, PackageDto } from '../../types/domain';
import { DataGrid, GridStatusBadge } from './DataGrid';

const PACKAGE_STATUSES = [
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

const SORT_FIELDS: Record<
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

export interface PackagesGridProps {
  refreshKey?: number;
  height?: number;
  defaultStatus?: string;
  onViewPassport: (packageId: string) => void;
  onSelectForScan?: (packageId: string) => void;
}

export const PackagesGrid: React.FC<PackagesGridProps> = ({
  refreshKey = 0,
  height = 420,
  defaultStatus = '',
  onViewPassport,
  onSelectForScan,
}) => {
  const [rows, setRows] = useState<PackageDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [statusFilter, setStatusFilter] = useState(defaultStatus);
  const [classFilter, setClassFilter] = useState<PackageClass | ''>('');
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

  const loadPackages = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      if (debouncedSearch) {
        const res = await searchOperationalEntity<PackageDto>('packages', {
          q: debouncedSearch,
          status: statusFilter || undefined,
          packageClass: classFilter || undefined,
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
          status: statusFilter || undefined,
          packageClass: classFilter || undefined,
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
      setError(err instanceof ApiError ? err.message : 'Failed to load package registry.');
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [statusFilter, classFilter, debouncedSearch, page, pageSize, sortBy, sortDir, refreshKey]);

  useEffect(() => {
    void loadPackages();
  }, [loadPackages]);

  const columnDefs = useMemo<ColDef<PackageDto>[]>(
    () => [
      {
        field: 'packageId',
        headerName: 'Package ID',
        sortable: true,
        minWidth: 145,
        cellClass: 'font-mono font-semibold',
      },
      {
        field: 'status',
        headerName: 'Lifecycle State',
        sortable: true,
        minWidth: 150,
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
        headerName: 'Custodian',
        colId: 'custodian',
        minWidth: 185,
        valueGetter: (p) =>
          p.data
            ? `${p.data.currentCustodian?.label ?? '—'} [${p.data.currentCustodian?.custodianType ?? ''}]`
            : '',
      },
      {
        headerName: 'Assigned Partner',
        colId: 'assignedPartnerName',
        minWidth: 140,
        valueGetter: (p) => p.data?.assignedPartnerName || 'Unassigned',
      },
      {
        headerName: 'QR Version',
        colId: 'qrStatus',
        minWidth: 115,
        valueGetter: (p) =>
          p.data ? `v${p.data.qrTokenVersion ?? 1}${p.data.qrRevoked ? ' (REVOKED)' : ''}` : 'v1',
      },
      {
        headerName: 'Last Inspection',
        colId: 'lastInspection',
        minWidth: 145,
        valueGetter: (p) =>
          p.data?.lastInspectionOutcome
            ? `${p.data.lastInspectionOutcome}${
                p.data.lastInspectionAt
                  ? ` (${new Date(p.data.lastInspectionAt).toLocaleDateString()})`
                  : ''
              }`
            : 'None',
      },
      {
        field: 'reuseCount',
        headerName: 'Cycles',
        sortable: true,
        minWidth: 95,
        valueGetter: (p) => (p.data ? `${p.data.reuseCount}/${p.data.maxLifecycleLimit}` : '0'),
      },
      {
        headerName: 'Actions',
        colId: 'actions',
        filter: false,
        sortable: false,
        minWidth: 165,
        cellRenderer: (p: ICellRendererParams<PackageDto>) =>
          p.data ? (
            <div className="flex items-center gap-1.5 h-full" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={() => onViewPassport(p.data!.packageId)}
                className="px-2 py-1 rounded-md border border-slate-300 dark:border-white/20 text-[11px] font-semibold hover:border-emerald-500"
              >
                Passport
              </button>
              {onSelectForScan && (
                <button
                  type="button"
                  onClick={() => onSelectForScan(p.data!.packageId)}
                  className="px-2 py-1 rounded-md bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 text-[11px] font-semibold hover:bg-emerald-500/25"
                >
                  Inspect / Scan
                </button>
              )}
            </div>
          ) : null,
      },
    ],
    [onViewPassport, onSelectForScan]
  );

  return (
    <DataGrid<PackageDto>
      testId="packages-ag-grid"
      rowData={rows}
      columnDefs={columnDefs}
      getRowId={(r) => r.packageId}
      loading={loading}
      error={error}
      onRetry={() => void loadPackages()}
      emptyMessage="No packages match the selected lifecycle filters."
      total={total}
      page={page}
      pageSize={pageSize}
      onPageChange={setPage}
      onPageSizeChange={(size) => {
        setPageSize(size);
        setPage(1);
      }}
      onSortChange={(colId, dir) => {
        setSortBy(colId ? SORT_FIELDS[colId] : undefined);
        setSortDir(dir);
        setPage(1);
      }}
      exportFilename="reboxify-packages.csv"
      height={height}
      toolbar={
        <>
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Filter package ID, location, custodian..."
            className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-3 py-1.5 text-xs min-w-[210px]"
          />
          <select
            aria-label="Filter packages by lifecycle state"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-2.5 py-1.5 text-xs"
          >
            <option value="">All Lifecycle States</option>
            {PACKAGE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter packages by class"
            value={classFilter}
            onChange={(e) => {
              setClassFilter(e.target.value as PackageClass | '');
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-2.5 py-1.5 text-xs"
          >
            <option value="">All Classes</option>
            {(['S', 'M', 'L', 'XL'] as PackageClass[]).map((c) => (
              <option key={c} value={c}>
                Class {c}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void loadPackages()}
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

