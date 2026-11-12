import React, { useMemo, useRef } from 'react';
import {
  ColDef,
  GridApi,
  GridReadyEvent,
  RowClickedEvent,
  SelectionChangedEvent,
  SortChangedEvent,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import {
  ensureAgGridRegistered,
  reboxifyDarkTheme,
  reboxifyLightTheme,
  statusBadgeClass,
  useIsDarkMode,
} from './agGridSetup';

ensureAgGridRegistered();

export const GridStatusBadge: React.FC<{ value?: string }> = ({ value }) => (
  <div className="flex items-center h-full">
    <span
      className={`inline-flex items-center leading-tight px-2.5 py-0.5 rounded-full border text-[11px] font-semibold ${statusBadgeClass(
        value
      )}`}
    >
      {value}
    </span>
  </div>
);

export interface DataGridProps<T extends object> {
  rowData: T[];
  columnDefs: ColDef<T>[];
  getRowId: (data: T) => string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyMessage?: string;
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (nextPage: number) => void;
  onPageSizeChange: (nextPageSize: number) => void;
  onSortChange?: (sortBy?: string, sortDir?: 'asc' | 'desc') => void;
  onRowClick?: (row: T) => void;
  onSelectionChange?: (rows: T[]) => void;
  selectionMode?: 'singleRow' | 'multiRow';
  toolbar?: React.ReactNode;
  exportFilename?: string;
  height?: number;
  testId?: string;
}

export function DataGrid<T extends object>({
  rowData,
  columnDefs,
  getRowId,
  loading = false,
  error = null,
  onRetry,
  emptyMessage = 'No matching records found.',
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  onSortChange,
  onRowClick,
  onSelectionChange,
  selectionMode,
  toolbar,
  exportFilename,
  height = 440,
  testId,
}: DataGridProps<T>) {
  const isDark = useIsDarkMode();
  const gridApiRef = useRef<GridApi<T> | null>(null);

  const defaultColDef = useMemo<ColDef<T>>(
    () => ({
      resizable: true,
      sortable: false,
      filter: true,
      minWidth: 100,
      flex: 1,
    }),
    []
  );

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const startItem = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endItem = Math.min(total, page * pageSize);

  const handleGridReady = (event: GridReadyEvent<T>) => {
    gridApiRef.current = event.api;
  };

  const handleSortChanged = (event: SortChangedEvent<T>) => {
    if (!onSortChange) return;
    const colState = event.api.getColumnState().find((c) => c.sort);
    if (!colState || !colState.sort) {
      onSortChange(undefined, undefined);
      return;
    }
    onSortChange(colState.colId, colState.sort);
  };

  const handleRowClicked = (event: RowClickedEvent<T>) => {
    if (onRowClick && event.data) {
      onRowClick(event.data);
    }
  };

  const handleSelectionChanged = (event: SelectionChangedEvent<T>) => {
    if (!onSelectionChange) return;
    onSelectionChange(event.api.getSelectedRows());
  };

  const handleExportCsv = () => {
    gridApiRef.current?.exportDataAsCsv({
      fileName: exportFilename || 'reboxify-export.csv',
    });
  };

  return (
    <div data-testid={testId} className="space-y-3">
      {(toolbar || exportFilename) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 flex-1">{toolbar}</div>
          {exportFilename && (
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={loading || rowData.length === 0}
              className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/60 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-emerald-500/60 disabled:opacity-40"
            >
              Export CSV
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-700 dark:text-rose-200 flex items-center justify-between gap-3">
          <span>{error}</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="px-3 py-1 rounded-lg bg-rose-500 text-white font-semibold hover:bg-rose-400"
            >
              Retry
            </button>
          )}
        </div>
      )}

      <div
        className="relative rounded-xl overflow-hidden border border-slate-200 dark:border-white/10"
        style={{ height }}
      >
        <AgGridReact<T>
          theme={isDark ? reboxifyDarkTheme : reboxifyLightTheme}
          rowData={rowData}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={(params) => getRowId(params.data)}
          onGridReady={handleGridReady}
          onSortChanged={handleSortChanged}
          onRowClicked={handleRowClicked}
          onSelectionChanged={handleSelectionChanged}
          rowSelection={selectionMode ? { mode: selectionMode } : undefined}
          animateRows={false}
          suppressCellFocus={false}
          loading={loading}
          overlayNoRowsTemplate={`<span class="text-xs font-medium opacity-75">${emptyMessage}</span>`}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400 pt-1">
        <div className="flex items-center gap-2">
          <span>
            Showing <strong className="text-slate-900 dark:text-slate-100">{startItem}</strong>–
            <strong className="text-slate-900 dark:text-slate-100">{endItem}</strong> of{' '}
            <strong className="text-slate-900 dark:text-slate-100">{total}</strong>
          </span>
          <label className="flex items-center gap-1.5 ml-2">
            <span>Rows:</span>
            <select
              aria-label="Rows per page"
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900 px-2 py-1 text-xs font-semibold text-slate-800 dark:text-slate-200"
            >
              {[10, 25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={loading || page <= 1}
            onClick={() => onPageChange(page - 1)}
            className="px-3 py-1 rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900 font-semibold text-slate-700 dark:text-slate-200 hover:border-emerald-500/60 disabled:opacity-40"
          >
            Prev
          </button>
          <span className="font-mono font-semibold">
            Page {page} / {totalPages}
          </span>
          <button
            type="button"
            disabled={loading || page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            className="px-3 py-1 rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900 font-semibold text-slate-700 dark:text-slate-200 hover:border-emerald-500/60 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

