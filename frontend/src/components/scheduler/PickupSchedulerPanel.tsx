import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@bryntum/core-community/fontawesome/css/fontawesome.css';
import '@bryntum/core-community/fontawesome/css/solid.css';
import '@bryntum/scheduler-community/scheduler.css';
import '@bryntum/scheduler-community/svalbard.css';
import { BryntumScheduler } from '@bryntum/scheduler-react-community';
import { ApiError } from '../../api/client';
import {
  assignPickup,
  cancelPickup,
  completePickup,
  createPickup,
  listPickupResources,
  listPickups,
  reschedulePickup,
  updatePartnerSchedule,
  updatePickup,
} from '../../api/pickups';
import { listReturns } from '../../api/phase5';
import {
  CollectionCentreDto,
  PartnerScheduleDto,
  PickupDto,
  PickupStatus,
  ReturnDto,
} from '../../types/domain';
import { statusBadgeClass } from '../grids/agGridSetup';

type ViewPresetOption = 'hourAndDay' | 'dayAndWeek' | 'weekAndDay';

export interface PickupSchedulerPanelProps {
  mode: 'ADMIN' | 'COLLECTION_CENTRE' | 'MERCHANT' | 'DELIVERY_PARTNER';
  merchantId?: string;
  currentUserId?: string;
  refreshKey?: number;
  title?: string;
  onPickupChanged?: () => Promise<void> | void;
}

const UNASSIGNED_RESOURCE_ID = '__UNASSIGNED__';

const EVENT_COLOR_BY_STATUS: Record<PickupStatus, string> = {
  UNASSIGNED: 'orange',
  ASSIGNED: 'blue',
  IN_PROGRESS: 'indigo',
  RESCHEDULED: 'amber',
  COMPLETED: 'green',
  MISSED: 'red',
  CANCELLED: 'gray',
};

function toLocalDateTimeInput(isoOrDate: Date | string): string {
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export const PickupSchedulerPanel: React.FC<PickupSchedulerPanelProps> = ({
  mode,
  merchantId,
  currentUserId,
  refreshKey = 0,
  title = 'Return Pickup Scheduler & Dispatch Timeline',
  onPickupChanged,
}) => {
  const [anchorDate, setAnchorDate] = useState<Date>(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
  });
  const [viewPreset, setViewPreset] = useState<ViewPresetOption>('hourAndDay');
  const [statusFilter, setStatusFilter] = useState<PickupStatus | ''>('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const [pickups, setPickups] = useState<PickupDto[]>([]);
  const [partners, setPartners] = useState<PartnerScheduleDto[]>([]);
  const [centres, setCentres] = useState<CollectionCentreDto[]>([]);
  const [eligibleReturns, setEligibleReturns] = useState<ReturnDto[]>([]);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedPickup, setSelectedPickup] = useState<PickupDto | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPartnerModal, setShowPartnerModal] = useState(false);

  // Create pickup form state
  const [newReturnId, setNewReturnId] = useState('');
  const [newPartnerId, setNewPartnerId] = useState('');
  const [newCentreId, setNewCentreId] = useState('');
  const [newSlotStart, setNewSlotStart] = useState(() => {
    const d = new Date(Date.now() + 2 * 60 * 60 * 1000);
    d.setMinutes(0, 0, 0);
    return toLocalDateTimeInput(d);
  });
  const [newSlotEnd, setNewSlotEnd] = useState(() => {
    const d = new Date(Date.now() + 4 * 60 * 60 * 1000);
    d.setMinutes(0, 0, 0);
    return toLocalDateTimeInput(d);
  });
  const [newZone, setNewZone] = useState('CENTRAL');
  const [newAddress, setNewAddress] = useState('');
  const [newNotes, setNewNotes] = useState('');

  // Detail modal form state
  const [editPartnerId, setEditPartnerId] = useState('');
  const [editCentreId, setEditCentreId] = useState('');
  const [editSlotStart, setEditSlotStart] = useState('');
  const [editSlotEnd, setEditSlotEnd] = useState('');
  const [rescheduleReason, setRescheduleReason] = useState('Dispatcher schedule adjustment');
  const [cancelReason, setCancelReason] = useState('Cancelled by operations');
  const [qrMode, setQrMode] = useState<'QR_TOKEN' | 'MANUAL_SUPERVISED'>('QR_TOKEN');
  const [qrTokenInput, setQrTokenInput] = useState('');
  const [manualReasonInput, setManualReasonInput] = useState('');

  // Partner availability editor state
  const [targetSchedulePartnerId, setTargetSchedulePartnerId] = useState('');
  const [schedStartHour, setSchedStartHour] = useState(8);
  const [schedEndHour, setSchedEndHour] = useState(20);
  const [schedDailyCap, setSchedDailyCap] = useState(15);
  const [schedConcurrentCap, setSchedConcurrentCap] = useState(1);
  const [schedZones, setSchedZones] = useState('');
  const [schedStatus, setSchedStatus] = useState<'ACTIVE' | 'UNAVAILABLE' | 'SUSPENDED'>('ACTIVE');

  const schedulerRef = useRef<any>(null);
  const reqSeqRef = useRef(0);
  const pickupsRef = useRef<PickupDto[]>([]);
  pickupsRef.current = pickups;

  const canManageDispatch = mode === 'ADMIN' || mode === 'COLLECTION_CENTRE' || mode === 'MERCHANT';
  const canDragDrop = canManageDispatch;
  const canComplete = mode === 'ADMIN' || mode === 'DELIVERY_PARTNER';
  const canEditSchedule =
    mode === 'ADMIN' || mode === 'COLLECTION_CENTRE' || mode === 'DELIVERY_PARTNER';

  const { rangeStart, rangeEnd } = useMemo(() => {
    const start = new Date(anchorDate);
    start.setHours(0, 0, 0, 0);
    if (viewPreset === 'hourAndDay') {
      const s = new Date(start);
      s.setHours(6, 0, 0, 0);
      const e = new Date(start);
      e.setDate(e.getDate() + 1);
      e.setHours(0, 0, 0, 0);
      return { rangeStart: s, rangeEnd: e };
    }
    if (viewPreset === 'dayAndWeek') {
      return { rangeStart: start, rangeEnd: addDays(start, 7) };
    }
    return { rangeStart: start, rangeEnd: addDays(start, 14) };
  }, [anchorDate, viewPreset]);

  const activeViewPreset = useMemo(
    () => (viewPreset === 'hourAndDay' ? { base: 'hourAndDay', tickWidth: 46 } : viewPreset),
    [viewPreset]
  );

  useEffect(() => {
    const inst = schedulerRef.current?.instance;
    if (!inst) return;
    if (typeof inst.setViewPreset === 'function') {
      inst.setViewPreset(activeViewPreset, rangeStart, rangeEnd);
    } else if (typeof inst.setTimeSpan === 'function') {
      inst.setTimeSpan(rangeStart, rangeEnd);
    }
  }, [activeViewPreset, rangeStart, rangeEnd]);

  const loadData = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const [pickupsRes, resourcesRes] = await Promise.all([
        listPickups({
          merchantId,
          status: statusFilter || undefined,
          serviceZone: zoneFilter.trim() || undefined,
          search: searchInput.trim() || undefined,
          from: addDays(rangeStart, -2).toISOString(),
          to: addDays(rangeEnd, 2).toISOString(),
          page: 1,
          pageSize: 200,
          sortBy: 'slotStart',
          sortDir: 'asc',
        }),
        listPickupResources({
          serviceZone: zoneFilter.trim() || undefined,
        }),
      ]);
      if (seq !== reqSeqRef.current) return;
      setPickups(pickupsRes.items);
      setPartners(resourcesRes.partners);
      setCentres(resourcesRes.collectionCentres);

      if (selectedPickup) {
        const refreshed = pickupsRes.items.find((p) => p.id === selectedPickup.id);
        if (refreshed) setSelectedPickup(refreshed);
      }
    } catch (err) {
      if (seq !== reqSeqRef.current) return;
      setError(err instanceof ApiError ? err.message : 'Failed to load pickup schedule.');
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [
    merchantId,
    statusFilter,
    zoneFilter,
    searchInput,
    rangeStart,
    rangeEnd,
    refreshKey,
    selectedPickup?.id,
  ]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const openScheduleModal = async (prefillPartnerId?: string, prefillStart?: Date) => {
    setError(null);
    setShowCreateModal(true);
    if (prefillPartnerId && prefillPartnerId !== UNASSIGNED_RESOURCE_ID) {
      setNewPartnerId(prefillPartnerId);
    }
    if (prefillStart) {
      setNewSlotStart(toLocalDateTimeInput(prefillStart));
      setNewSlotEnd(toLocalDateTimeInput(new Date(prefillStart.getTime() + 2 * 60 * 60 * 1000)));
    }
    try {
      const retRes = await listReturns({ merchantId, page: 1, pageSize: 50 });
      const candidates = retRes.items.filter(
        (r) => !['COLLECTED', 'RECEIVED', 'UNDER_INSPECTION', 'APPROVED', 'REJECTED', 'CLOSED'].includes(r.status)
      );
      setEligibleReturns(candidates);
      if (candidates[0] && !newReturnId) {
        setNewReturnId(candidates[0].id);
        setNewZone(candidates[0].returnMethodDetails?.serviceZone || 'CENTRAL');
        setNewAddress(candidates[0].returnMethodDetails?.addressSummary || 'Customer Pickup Address');
      }
    } catch {
      // keep modal usable even if return lookup returns empty
    }
  };

  const openPickupModal = (pickup: PickupDto) => {
    setSelectedPickup(pickup);
    setEditPartnerId(pickup.partnerId ?? '');
    setEditCentreId(pickup.collectionCenterId ?? '');
    setEditSlotStart(toLocalDateTimeInput(pickup.slotStart));
    setEditSlotEnd(toLocalDateTimeInput(pickup.slotEnd));
    setQrTokenInput('');
    setManualReasonInput('');
    setError(null);
  };

  const openPartnerScheduleModal = (partner?: PartnerScheduleDto) => {
    const chosen =
      partner ||
      partners.find((p) => p.userId === currentUserId) ||
      partners[0];
    if (!chosen) {
      setError('No active delivery partner profiles loaded yet.');
      return;
    }
    setTargetSchedulePartnerId(chosen.userId);
    setSchedStartHour(chosen.workingHours.startHour);
    setSchedEndHour(chosen.workingHours.endHour);
    setSchedDailyCap(chosen.dailyCapacity);
    setSchedConcurrentCap(chosen.maxConcurrentCapacity);
    setSchedZones(chosen.serviceZones.join(', '));
    setSchedStatus(chosen.status);
    setShowPartnerModal(true);
  };

  const schedulerResources = useMemo(() => {
    const list: Array<{
      id: string;
      name: string;
      zonesLabel: string;
      capacityLabel: string;
    }> = [];

    if (canManageDispatch) {
      list.push({
        id: UNASSIGNED_RESOURCE_ID,
        name: 'Unassigned Queue',
        zonesLabel: 'Pending Partner',
        capacityLabel: `${pickups.filter((p) => !p.partnerId && p.status !== 'CANCELLED').length} open`,
      });
    }

    for (const p of partners) {
      const assignedCount = pickups.filter(
        (pk) => pk.partnerId === p.userId && pk.status !== 'CANCELLED'
      ).length;
      list.push({
        id: p.userId,
        name: p.displayName,
        zonesLabel: p.serviceZones.length > 0 ? p.serviceZones.join(', ') : 'All Zones',
        capacityLabel: `${assignedCount}/${p.dailyCapacity} • ${p.workingHours.startHour}:00-${p.workingHours.endHour}:00`,
      });
    }
    return list;
  }, [partners, pickups, canManageDispatch]);

  const schedulerEvents = useMemo(
    () =>
      pickups.map((p) => ({
        id: p.id,
        resourceId: p.partnerId || UNASSIGNED_RESOURCE_ID,
        startDate: new Date(p.slotStart),
        endDate: new Date(p.slotEnd),
        name: `${p.returnNumber || p.packageId} • ${p.serviceZone} (${p.status})`,
        eventColor: EVENT_COLOR_BY_STATUS[p.status] || 'blue',
        draggable: canDragDrop && p.status !== 'COMPLETED' && p.status !== 'CANCELLED',
        resizable: canDragDrop && p.status !== 'COMPLETED' && p.status !== 'CANCELLED',
      })),
    [pickups, canDragDrop]
  );

  const schedulerColumns = useMemo(
    () => [
      { text: 'Delivery Resource', field: 'name', width: 170 },
      { text: 'Zones', field: 'zonesLabel', width: 110 },
      { text: 'Load / Hours', field: 'capacityLabel', width: 120 },
    ],
    []
  );

  const handleBeforeEventDropFinalize = useCallback(
    (ev: any) => {
      const context = ev?.context;
      if (!context) return;

      const pickupId = String(context.eventRecord?.id ?? '');
      const existing = pickupsRef.current.find((p) => p.id === pickupId);
      if (!existing || !canDragDrop) {
        context.valid = false;
        return;
      }

      context.async = true;
      const targetResourceId = String(context.newResource?.id ?? UNASSIGNED_RESOURCE_ID);
      const nextPartnerId = targetResourceId === UNASSIGNED_RESOURCE_ID ? null : targetResourceId;

      void (async () => {
        try {
          setError(null);
          setNotice(null);
          const res = await updatePickup(existing.id, {
            slotStart: new Date(context.startDate).toISOString(),
            slotEnd: new Date(context.endDate).toISOString(),
            partnerId: nextPartnerId,
            expectedVersion: existing.version,
            reason: 'Rescheduled / reassigned via Bryntum Scheduler drag-and-drop',
          });
          context.finalize(true);
          setNotice(
            `Saved pickup ${res.pickup.returnNumber || res.pickup.packageId} (${
              res.pickup.assignedPartnerName || 'UNASSIGNED'
            } • ${res.pickup.status}).`
          );
          await loadData();
          await onPickupChanged?.();
        } catch (err) {
          context.finalize(false);
          setError(
            err instanceof ApiError
              ? `Schedule conflict — reverted: ${err.message}`
              : 'Server rejected schedule change; reverted.'
          );
        }
      })();
    },
    [canDragDrop, loadData, onPickupChanged]
  );

  const handleBeforeEventResizeFinalize = useCallback(
    async (ev: any): Promise<void> => {
      const target = ev?.context ?? ev;
      if (!target) return;
      const pickupId = String(target.eventRecord?.id ?? ev?.eventRecord?.id ?? '');
      const existing = pickupsRef.current.find((p) => p.id === pickupId);
      if (!existing || !canDragDrop) {
        target.valid = false;
        return;
      }

      target.async = true;
      const startDate = target.startDate ?? ev.startDate;
      const endDate = target.endDate ?? ev.endDate;

      try {
        setError(null);
        setNotice(null);
        const res = await updatePickup(existing.id, {
          slotStart: new Date(startDate).toISOString(),
          slotEnd: new Date(endDate).toISOString(),
          expectedVersion: existing.version,
          reason: 'Window resized via Bryntum Scheduler',
        });
        target.finalize(true);
        setNotice(
          `Updated pickup window for ${res.pickup.returnNumber || res.pickup.packageId}.`
        );
        await loadData();
        await onPickupChanged?.();
      } catch (err) {
        target.finalize(false);
        setError(
          err instanceof ApiError
            ? `Window conflict — reverted: ${err.message}`
            : 'Server rejected window resize; reverted.'
        );
      }
    },
    [canDragDrop, loadData, onPickupChanged]
  );

  const handleEventClick = useCallback((ev: any) => {
    const id = String(ev?.eventRecord?.id ?? '');
    const found = pickupsRef.current.find((p) => p.id === id);
    if (found) openPickupModal(found);
  }, []);

  const handleScheduleDblClick = useCallback(
    (ev: any) => {
      if (!canManageDispatch) return;
      const rId = ev?.resourceRecord?.id ? String(ev.resourceRecord.id) : undefined;
      const date = ev?.date ? new Date(ev.date) : undefined;
      void openScheduleModal(rId, date);
    },
    [canManageDispatch]
  );

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newReturnId) {
      setError('Select a return record to schedule.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await createPickup({
        returnId: newReturnId,
        ...(newPartnerId ? { partnerId: newPartnerId } : {}),
        ...(newCentreId ? { collectionCenterId: newCentreId } : {}),
        slotStart: new Date(newSlotStart).toISOString(),
        slotEnd: new Date(newSlotEnd).toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        serviceZone: newZone,
        addressSummary: newAddress,
        ...(newNotes ? { notes: newNotes } : {}),
      });
      setNotice(`Scheduled pickup ${res.pickup.id} (${res.pickup.status}).`);
      setShowCreateModal(false);
      await loadData();
      await onPickupChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create pickup appointment.');
    } finally {
      setBusy(false);
    }
  };

  const handleAssignSave = async () => {
    if (!selectedPickup) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await assignPickup(selectedPickup.id, {
        partnerId: editPartnerId || undefined,
        collectionCenterId: editCentreId || undefined,
        expectedVersion: selectedPickup.version,
      });
      setSelectedPickup(res.pickup);
      setNotice(`Updated assignment for ${res.pickup.returnNumber || res.pickup.packageId}.`);
      await loadData();
      await onPickupChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign partner.');
    } finally {
      setBusy(false);
    }
  };

  const handleRescheduleSave = async () => {
    if (!selectedPickup) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await reschedulePickup(selectedPickup.id, {
        slotStart: new Date(editSlotStart).toISOString(),
        slotEnd: new Date(editSlotEnd).toISOString(),
        partnerId: editPartnerId ? editPartnerId : null,
        reason: rescheduleReason,
        expectedVersion: selectedPickup.version,
      });
      setSelectedPickup(res.pickup);
      setNotice(`Rescheduled ${res.pickup.returnNumber || res.pickup.packageId}.`);
      await loadData();
      await onPickupChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reschedule pickup.');
    } finally {
      setBusy(false);
    }
  };

  const handleStatusChange = async (nextStatus: PickupStatus) => {
    if (!selectedPickup) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await updatePickup(selectedPickup.id, {
        status: nextStatus,
        ...(nextStatus === 'MISSED' ? { missedReason: 'Partner reported missed pickup window' } : {}),
        expectedVersion: selectedPickup.version,
      });
      setSelectedPickup(res.pickup);
      setNotice(`Pickup marked ${res.pickup.status}.`);
      await loadData();
      await onPickupChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Status transition rejected.');
    } finally {
      setBusy(false);
    }
  };

  const handleCancelPickup = async () => {
    if (!selectedPickup) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await cancelPickup(selectedPickup.id, {
        reason: cancelReason,
        expectedVersion: selectedPickup.version,
      });
      setSelectedPickup(res.pickup);
      setNotice(`Pickup cancelled.`);
      await loadData();
      await onPickupChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cancellation failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleCompletePickup = async () => {
    if (!selectedPickup) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await completePickup(selectedPickup.id, {
        scanMode: qrMode,
        ...(qrMode === 'QR_TOKEN'
          ? { qrToken: qrTokenInput.trim() }
          : { manualReason: manualReasonInput.trim() }),
      });
      setSelectedPickup(res.pickup);
      setNotice(`Collection completed & return ${res.returnRecord.returnNumber} marked COLLECTED.`);
      await loadData();
      await onPickupChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Collection completion failed.');
    } finally {
      setBusy(false);
    }
  };

  const handlePartnerScheduleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetSchedulePartnerId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const zones = schedZones
        .split(',')
        .map((z) => z.trim())
        .filter(Boolean);
      const res = await updatePartnerSchedule(targetSchedulePartnerId, {
        workingHours: {
          startHour: schedStartHour,
          endHour: schedEndHour,
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        },
        serviceZones: zones,
        dailyCapacity: schedDailyCap,
        maxConcurrentCapacity: schedConcurrentCap,
        status: schedStatus,
      });
      setNotice(`Saved availability profile for ${res.partner.displayName}.`);
      setShowPartnerModal(false);
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save partner schedule.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="pickup-scheduler-panel" className="space-y-4 scroll-mt-28">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold tracking-tight">{title}</h3>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Powered by Bryntum Scheduler &bull; Drag pickups across partner lanes or resize slots (server-validated).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canManageDispatch && (
            <button
              type="button"
              onClick={() => void openScheduleModal()}
              className="px-3.5 py-2 rounded-xl bg-emerald-500 text-white text-xs font-bold hover:bg-emerald-400"
            >
              + Schedule Pickup
            </button>
          )}
          {canEditSchedule && (
            <button
              type="button"
              onClick={() => openPartnerScheduleModal()}
              className="px-3 py-2 rounded-xl border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 text-xs font-semibold hover:border-emerald-500/60"
            >
              Partner Availability
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadData()}
            disabled={loading}
            className="px-3 py-2 rounded-xl border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 text-xs font-semibold hover:border-emerald-500/60"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Filter & Navigation Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 dark:border-white/10 bg-white/70 dark:bg-white/[0.03] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setAnchorDate((d) => addDays(d, viewPreset === 'hourAndDay' ? -1 : -7))
            }
            className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-white/15 text-xs font-semibold"
          >
            &larr; Prev
          </button>
          <button
            type="button"
            onClick={() => {
              const now = new Date();
              now.setHours(0, 0, 0, 0);
              setAnchorDate(now);
            }}
            className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-white/15 text-xs font-semibold"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() =>
              setAnchorDate((d) => addDays(d, viewPreset === 'hourAndDay' ? 1 : 7))
            }
            className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-white/15 text-xs font-semibold"
          >
            Next &rarr;
          </button>
          <span className="text-xs font-mono font-semibold px-2">
            {rangeStart.toLocaleDateString()} &ndash; {rangeEnd.toLocaleDateString()}
          </span>

          <div className="inline-flex rounded-lg border border-slate-300 dark:border-white/15 overflow-hidden ml-2">
            {(
              [
                ['hourAndDay', 'Day'],
                ['dayAndWeek', 'Week'],
                ['weekAndDay', '2 Weeks'],
              ] as Array<[ViewPresetOption, string]>
            ).map(([preset, label]) => (
              <button
                key={preset}
                type="button"
                onClick={() => setViewPreset(preset)}
                className={`px-3 py-1 text-xs font-semibold ${
                  viewPreset === preset
                    ? 'bg-emerald-500 text-white'
                    : 'bg-white dark:bg-slate-900/60 text-slate-700 dark:text-slate-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search return #, package, address..."
            className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-3 py-1.5 text-xs min-w-[180px]"
          />
          <input
            type="text"
            value={zoneFilter}
            onChange={(e) => setZoneFilter(e.target.value)}
            placeholder="Zone (e.g. CENTRAL)"
            className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-2.5 py-1.5 text-xs w-[130px]"
          />
          <select
            aria-label="Filter pickups by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as PickupStatus | '')}
            className="rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900/70 px-2.5 py-1.5 text-xs"
          >
            <option value="">All Statuses</option>
            {(['UNASSIGNED', 'ASSIGNED', 'IN_PROGRESS', 'RESCHEDULED', 'MISSED', 'COMPLETED', 'CANCELLED'] as PickupStatus[]).map(
              (s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              )
            )}
          </select>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-700 dark:text-rose-200 flex items-center justify-between gap-2">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="underline font-semibold"
          >
            Dismiss
          </button>
        </div>
      )}

      {notice && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-700 dark:text-emerald-200">
          {notice}
        </div>
      )}

      {/* Official Bryntum Scheduler React Component */}
      <div className="rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10 shadow-sm">
        <BryntumScheduler
          ref={schedulerRef}
          height={460}
          startDate={rangeStart}
          endDate={rangeEnd}
          viewPreset={activeViewPreset}
          rowHeight={56}
          barMargin={6}
          resources={schedulerResources}
          events={schedulerEvents}
          columns={schedulerColumns}
          eventEditFeature={false}
          eventDragFeature={{
            constrainDragToTimeline: true,
          }}
          eventResizeFeature={true}
          eventTooltipFeature={{
            template: (data: any) => {
              const p = pickupsRef.current.find((pk) => pk.id === String(data?.eventRecord?.id));
              if (!p) return String(data?.eventRecord?.name ?? '');
              return `
                <div style="font-size:12px;line-height:1.45;">
                  <strong>${p.returnNumber || p.packageId}</strong> (${p.status})<br/>
                  <span>Package: ${p.packageId}</span><br/>
                  <span>Zone: ${p.serviceZone} &bull; ${p.addressSummary}</span><br/>
                  <span>Partner: ${p.assignedPartnerName || 'UNASSIGNED'}</span><br/>
                  <span>Window: ${new Date(p.slotStart).toLocaleTimeString()} – ${new Date(
                p.slotEnd
              ).toLocaleTimeString()}</span>
                </div>
              `;
            },
          }}
          onBeforeEventDropFinalize={handleBeforeEventDropFinalize}
          onBeforeEventResizeFinalize={handleBeforeEventResizeFinalize}
          onEventClick={handleEventClick}
          onScheduleDblClick={handleScheduleDblClick}
        />
      </div>

      {/* Compact Upcoming Pickups List below timeline for quick keyboard/accessibility access */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {pickups.slice(0, 6).map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => openPickupModal(p)}
            className="text-left rounded-xl border border-slate-200 dark:border-white/10 bg-white/80 dark:bg-white/[0.03] p-3 hover:border-emerald-500/60 transition"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-bold">{p.returnNumber || p.packageId}</span>
              <span
                className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${statusBadgeClass(
                  p.status
                )}`}
              >
                {p.status}
              </span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 truncate">
              {p.serviceZone} &bull; {p.addressSummary}
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              {new Date(p.slotStart).toLocaleString()} &bull; {p.assignedPartnerName || 'Unassigned'}
            </p>
          </button>
        ))}
      </div>

      {/* Create Pickup Modal */}
      {showCreateModal && (
        <div
          data-testid="pickup-create-modal"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
        >
          <form
            onSubmit={handleCreateSubmit}
            className="w-full max-w-lg rounded-2xl border border-slate-200 dark:border-white/15 bg-white dark:bg-slate-900 p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h4 className="text-base font-bold">Schedule Return Pickup</h4>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="text-xs font-semibold opacity-70 hover:opacity-100"
              >
                Close
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <label className="block space-y-1">
                <span className="font-semibold">Return Record</span>
                {eligibleReturns.length > 0 ? (
                  <select
                    value={newReturnId}
                    onChange={(e) => {
                      const val = e.target.value;
                      setNewReturnId(val);
                      const chosen = eligibleReturns.find((r) => r.id === val);
                      if (chosen) {
                        setNewZone(chosen.returnMethodDetails?.serviceZone || newZone);
                        setNewAddress(
                          chosen.returnMethodDetails?.addressSummary || newAddress
                        );
                      }
                    }}
                    className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                    required
                  >
                    <option value="">Select eligible return...</option>
                    {eligibleReturns.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.returnNumber} &bull; {r.packageId} ({r.status})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={newReturnId}
                    onChange={(e) => setNewReturnId(e.target.value)}
                    placeholder="Return ObjectId"
                    className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                    required
                  />
                )}
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="font-semibold">Window Start</span>
                  <input
                    type="datetime-local"
                    value={newSlotStart}
                    onChange={(e) => setNewSlotStart(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                    required
                  />
                </label>
                <label className="block space-y-1">
                  <span className="font-semibold">Window End</span>
                  <input
                    type="datetime-local"
                    value={newSlotEnd}
                    onChange={(e) => setNewSlotEnd(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                    required
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="font-semibold">Assign Delivery Partner</span>
                  <select
                    value={newPartnerId}
                    onChange={(e) => setNewPartnerId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                  >
                    <option value="">Leave Unassigned</option>
                    {partners.map((p) => (
                      <option key={p.userId} value={p.userId}>
                        {p.displayName} ({p.serviceZones.join(',') || 'All'})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="font-semibold">Collection Centre</span>
                  <select
                    value={newCentreId}
                    onChange={(e) => setNewCentreId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                  >
                    <option value="">Auto / None</option>
                    {centres.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.status})
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="font-semibold">Service Zone</span>
                  <input
                    type="text"
                    value={newZone}
                    onChange={(e) => setNewZone(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                    required
                  />
                </label>
                <label className="block space-y-1">
                  <span className="font-semibold">Notes</span>
                  <input
                    type="text"
                    value={newNotes}
                    onChange={(e) => setNewNotes(e.target.value)}
                    placeholder="Gate code / handling notes"
                    className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                  />
                </label>
              </div>

              <label className="block space-y-1">
                <span className="font-semibold">Pickup Address</span>
                <input
                  type="text"
                  value={newAddress}
                  onChange={(e) => setNewAddress(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                  required
                />
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 rounded-xl border border-slate-300 dark:border-white/15 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="px-4 py-2 rounded-xl bg-emerald-500 text-white text-xs font-bold hover:bg-emerald-400 disabled:opacity-50"
              >
                {busy ? 'Scheduling...' : 'Create Pickup'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Appointment Detail & Operational Action Modal */}
      {selectedPickup && (
        <div
          data-testid="pickup-detail-modal"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
        >
          <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-200 dark:border-white/15 bg-white dark:bg-slate-900 p-6 space-y-4 shadow-2xl text-xs">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="text-base font-bold font-mono">
                  {selectedPickup.returnNumber || selectedPickup.packageId}
                </h4>
                <p className="text-slate-500 dark:text-slate-400">
                  Package {selectedPickup.packageId} &bull; Zone {selectedPickup.serviceZone} &bull;
                  Version {selectedPickup.version}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`px-2.5 py-1 rounded-full border text-[11px] font-semibold ${statusBadgeClass(
                    selectedPickup.status
                  )}`}
                >
                  {selectedPickup.status}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedPickup(null)}
                  className="px-2 py-1 rounded-lg border border-slate-300 dark:border-white/15 font-semibold"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-white/10 p-3 bg-slate-50/70 dark:bg-white/[0.02] space-y-1">
              <p>
                <strong>Address:</strong> {selectedPickup.addressSummary}
              </p>
              <p>
                <strong>Current Partner:</strong>{' '}
                {selectedPickup.assignedPartnerName || 'Unassigned'}
              </p>
              <p>
                <strong>Window:</strong> {new Date(selectedPickup.slotStart).toLocaleString()} &ndash;{' '}
                {new Date(selectedPickup.slotEnd).toLocaleString()}
              </p>
            </div>

            {canManageDispatch &&
              selectedPickup.status !== 'COMPLETED' &&
              selectedPickup.status !== 'CANCELLED' && (
                <div className="space-y-3 border-t border-slate-200 dark:border-white/10 pt-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block space-y-1">
                      <span className="font-semibold">Partner</span>
                      <select
                        value={editPartnerId}
                        onChange={(e) => setEditPartnerId(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                      >
                        <option value="">Unassigned</option>
                        {partners.map((p) => (
                          <option key={p.userId} value={p.userId}>
                            {p.displayName} ({p.serviceZones.join(',') || 'All'})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block space-y-1">
                      <span className="font-semibold">Collection Centre</span>
                      <select
                        value={editCentreId}
                        onChange={(e) => setEditCentreId(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                      >
                        <option value="">None</option>
                        {centres.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleAssignSave()}
                    className="px-3 py-1.5 rounded-lg bg-sky-600 text-white font-semibold hover:bg-sky-500 disabled:opacity-50"
                  >
                    Save Assignment
                  </button>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                    <label className="block space-y-1">
                      <span className="font-semibold">New Start</span>
                      <input
                        type="datetime-local"
                        value={editSlotStart}
                        onChange={(e) => setEditSlotStart(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="font-semibold">New End</span>
                      <input
                        type="datetime-local"
                        value={editSlotEnd}
                        onChange={(e) => setEditSlotEnd(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={rescheduleReason}
                      onChange={(e) => setRescheduleReason(e.target.value)}
                      placeholder="Reschedule reason"
                      className="flex-1 min-w-[180px] rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-1.5"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleRescheduleSave()}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-semibold hover:bg-emerald-500 disabled:opacity-50"
                    >
                      Reschedule Slot
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    <input
                      type="text"
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                      placeholder="Cancellation reason"
                      className="flex-1 min-w-[180px] rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-1.5"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleCancelPickup()}
                      className="px-3 py-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300 font-semibold hover:bg-rose-500/20 disabled:opacity-50"
                    >
                      Cancel Pickup
                    </button>
                  </div>
                </div>
              )}

            {canComplete &&
              selectedPickup.status !== 'COMPLETED' &&
              selectedPickup.status !== 'CANCELLED' && (
                <div className="space-y-2 border-t border-slate-200 dark:border-white/10 pt-3">
                  <div className="flex flex-wrap gap-2">
                    {selectedPickup.status === 'ASSIGNED' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleStatusChange('IN_PROGRESS')}
                        className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-500"
                      >
                        Start Pickup (IN_PROGRESS)
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleStatusChange('MISSED')}
                      className="px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 font-semibold"
                    >
                      Mark Missed
                    </button>
                  </div>

                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <strong className="text-emerald-700 dark:text-emerald-300">
                        Complete Pickup (QR-Verified Collection)
                      </strong>
                      <select
                        value={qrMode}
                        onChange={(e) =>
                          setQrMode(e.target.value as 'QR_TOKEN' | 'MANUAL_SUPERVISED')
                        }
                        className="rounded border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-2 py-1"
                      >
                        <option value="QR_TOKEN">Signed QR Token</option>
                        <option value="MANUAL_SUPERVISED">Supervised Fallback</option>
                      </select>
                    </div>
                    {qrMode === 'QR_TOKEN' ? (
                      <input
                        type="text"
                        value={qrTokenInput}
                        onChange={(e) => setQrTokenInput(e.target.value)}
                        placeholder="Paste signed package QR token..."
                        className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-1.5 font-mono"
                      />
                    ) : (
                      <input
                        type="text"
                        value={manualReasonInput}
                        onChange={(e) => setManualReasonInput(e.target.value)}
                        placeholder="Operational override reason (min 8 chars)..."
                        className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-1.5"
                      />
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleCompletePickup()}
                      className="px-3.5 py-1.5 rounded-lg bg-emerald-500 text-white font-bold hover:bg-emerald-400 disabled:opacity-50"
                    >
                      Complete Collection
                    </button>
                  </div>
                </div>
              )}

            {selectedPickup.rescheduleHistory.length > 0 && (
              <div className="border-t border-slate-200 dark:border-white/10 pt-3 space-y-1.5">
                <h5 className="font-bold">Reschedule History</h5>
                {selectedPickup.rescheduleHistory.map((h, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-slate-200 dark:border-white/10 px-3 py-2 text-[11px]"
                  >
                    <p>
                      {new Date(h.previousStart).toLocaleString()} &rarr;{' '}
                      <strong>{new Date(h.newStart).toLocaleString()}</strong>
                    </p>
                    <p className="opacity-75">Reason: {h.reason}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Partner Availability Profile Modal */}
      {showPartnerModal && (
        <div
          data-testid="pickup-partner-modal"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
        >
          <form
            onSubmit={handlePartnerScheduleSubmit}
            className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-white/15 bg-white dark:bg-slate-900 p-6 space-y-4 shadow-2xl text-xs"
          >
            <div className="flex items-center justify-between">
              <h4 className="text-base font-bold">Partner Availability &amp; Capacity</h4>
              <button
                type="button"
                onClick={() => setShowPartnerModal(false)}
                className="font-semibold opacity-70"
              >
                Close
              </button>
            </div>

            <label className="block space-y-1">
              <span className="font-semibold">Partner</span>
              <select
                value={targetSchedulePartnerId}
                onChange={(e) => {
                  const chosen = partners.find((p) => p.userId === e.target.value);
                  setTargetSchedulePartnerId(e.target.value);
                  if (chosen) {
                    setSchedStartHour(chosen.workingHours.startHour);
                    setSchedEndHour(chosen.workingHours.endHour);
                    setSchedDailyCap(chosen.dailyCapacity);
                    setSchedConcurrentCap(chosen.maxConcurrentCapacity);
                    setSchedZones(chosen.serviceZones.join(', '));
                    setSchedStatus(chosen.status);
                  }
                }}
                disabled={mode === 'DELIVERY_PARTNER'}
                className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
              >
                {partners.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="font-semibold">Start Hour (0-23)</span>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={schedStartHour}
                  onChange={(e) => setSchedStartHour(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-semibold">End Hour (1-24)</span>
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={schedEndHour}
                  onChange={(e) => setSchedEndHour(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-semibold">Daily Capacity</span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={schedDailyCap}
                  onChange={(e) => setSchedDailyCap(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-semibold">Concurrent Slots</span>
                <input
                  type="number"
                  min={1}
                  max={25}
                  value={schedConcurrentCap}
                  onChange={(e) => setSchedConcurrentCap(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
                />
              </label>
            </div>

            <label className="block space-y-1">
              <span className="font-semibold">Service Zones (comma-separated, empty = all)</span>
              <input
                type="text"
                value={schedZones}
                onChange={(e) => setSchedZones(e.target.value)}
                placeholder="CENTRAL, NORTH, WEST"
                className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
              />
            </label>

            <label className="block space-y-1">
              <span className="font-semibold">Status</span>
              <select
                value={schedStatus}
                onChange={(e) =>
                  setSchedStatus(e.target.value as 'ACTIVE' | 'UNAVAILABLE' | 'SUSPENDED')
                }
                className="w-full rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-950 px-3 py-2"
              >
                <option value="ACTIVE">ACTIVE</option>
                <option value="UNAVAILABLE">UNAVAILABLE</option>
                <option value="SUSPENDED">SUSPENDED</option>
              </select>
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowPartnerModal(false)}
                className="px-4 py-2 rounded-xl border border-slate-300 dark:border-white/15 font-semibold"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="px-4 py-2 rounded-xl bg-emerald-500 text-white font-bold hover:bg-emerald-400 disabled:opacity-50"
              >
                Save Schedule
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
