import {
  AllCommunityModule,
  ModuleRegistry,
  colorSchemeDarkBlue,
  themeQuartz,
} from 'ag-grid-community';
import { useEffect, useState } from 'react';

let registered = false;

export function ensureAgGridRegistered(): void {
  if (!registered) {
    ModuleRegistry.registerModules([AllCommunityModule]);
    registered = true;
  }
}

export const reboxifyLightTheme = themeQuartz.withParams({
  accentColor: '#10b981',
  borderRadius: 10,
  headerFontSize: 12,
  fontSize: 13,
  rowHeight: 48,
  headerHeight: 42,
});

export const reboxifyDarkTheme = themeQuartz
  .withPart(colorSchemeDarkBlue)
  .withParams({
    accentColor: '#10b981',
    backgroundColor: '#0b1220',
    headerBackgroundColor: '#111a2e',
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    headerFontSize: 12,
    fontSize: 13,
    rowHeight: 48,
    headerHeight: 42,
  });

export function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState<boolean>(() =>
    typeof document !== 'undefined'
      ? document.documentElement.classList.contains('dark')
      : true
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const update = () => setIsDark(root.classList.contains('dark'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

export function statusBadgeClass(status: string | undefined): string {
  const s = (status ?? '').toUpperCase();
  if (
    [
      'AVAILABLE',
      'PAID',
      'CAPTURED',
      'APPROVED',
      'COMPLETED',
      'REFUNDED',
      'ACTIVE',
      'DELIVERED',
      'GOOD',
      'NEW',
      'PASS',
    ].includes(s)
  ) {
    return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30';
  }
  if (
    [
      'ASSIGNED',
      'RESERVED',
      'PACKED',
      'DISPATCHED',
      'IN_PROGRESS',
      'PARTIALLY_REFUNDED',
      'PICKUP_SCHEDULED',
      'DROP_OFF_SELECTED',
      'COLLECTED',
      'RECEIVED',
      'CLEANING',
    ].includes(s)
  ) {
    return 'bg-sky-500/15 text-sky-600 dark:text-sky-300 border-sky-500/30';
  }
  if (
    [
      'PENDING',
      'PAYMENT_PENDING',
      'CAPTURE_PENDING',
      'REFUND_PENDING',
      'REFUND_REQUESTED',
      'REQUESTED',
      'UNASSIGNED',
      'RESCHEDULED',
      'UNDER_INSPECTION',
      'NEEDS_REVIEW',
      'MINOR_WEAR',
      'MINOR_DAMAGE',
      'REPAIR',
      'ALLOCATED',
      'PLACED',
    ].includes(s)
  ) {
    return 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30';
  }
  if (
    [
      'CANCELLED',
      'REJECTED',
      'CAPTURE_FAILED',
      'REFUND_FAILED',
      'QUARANTINED',
      'DAMAGED',
      'MAJOR_DAMAGE',
      'CONTAMINATED',
      'UNUSABLE',
      'MISSED',
      'RETIRED',
      'REVERSED',
      'DISPUTED',
      'FAIL',
      'SUSPENDED',
    ].includes(s)
  ) {
    return 'bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/30';
  }
  return 'bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30';
}

