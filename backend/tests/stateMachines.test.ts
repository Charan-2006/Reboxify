import { describe, expect, it } from 'vitest';
import {
  canCleanAndRecirculatePackage,
  canDispatchOrder,
  canInitiateRefundFromReturn,
  shouldIncrementReuseCount,
} from '../src/stateMachines/gates.js';
import {
  orderStateMachine,
  packageStateMachine,
  paymentStateMachine,
  pickupStateMachine,
  returnStateMachine,
} from '../src/stateMachines/machines.js';

describe('Blueprint v2.0 Independent State Machines', () => {
  it('enforces valid Package lifecycle transitions and blocks invalid skips', () => {
    expect(packageStateMachine.validateTransition('AVAILABLE', 'RESERVED').allowed).toBe(true);
    expect(packageStateMachine.validateTransition('WITH_CUSTOMER', 'AVAILABLE').allowed).toBe(false);
    expect(packageStateMachine.validateTransition('RETIRED', 'AVAILABLE').allowed).toBe(false);
    expect(packageStateMachine.validateTransition('AVAILABLE', 'AVAILABLE').allowed).toBe(false);
  });

  it('enforces Order, Return, Payment, and Pickup state machines independently', () => {
    expect(orderStateMachine.validateTransition('PLACED', 'ALLOCATED').allowed).toBe(true);
    expect(orderStateMachine.validateTransition('DELIVERED', 'CANCELLED').allowed).toBe(false);

    expect(returnStateMachine.validateTransition('REQUESTED', 'PICKUP_SCHEDULED').allowed).toBe(true);
    expect(returnStateMachine.validateTransition('REQUESTED', 'APPROVED').allowed).toBe(false);

    expect(paymentStateMachine.validateTransition('CREATED', 'CAPTURED').allowed).toBe(true);
    expect(paymentStateMachine.validateTransition('CAPTURED', 'PARTIALLY_REFUNDED').allowed).toBe(true);
    expect(paymentStateMachine.validateTransition('REFUNDED', 'CAPTURED').allowed).toBe(false);

    expect(pickupStateMachine.validateTransition('UNASSIGNED', 'ASSIGNED').allowed).toBe(true);
    expect(pickupStateMachine.validateTransition('MISSED', 'RESCHEDULED').allowed).toBe(true);
    expect(pickupStateMachine.validateTransition('COMPLETED', 'MISSED').allowed).toBe(false);
  });

  it('enforces cross-state-machine gates correctly', () => {
    // Gate 1: Dispatch requires CAPTURED payment
    expect(canDispatchOrder('ALLOCATED', 'CAPTURE_PENDING', 1).allowed).toBe(false);
    expect(canDispatchOrder('ALLOCATED', 'CAPTURED', 0).allowed).toBe(false);
    expect(canDispatchOrder('ALLOCATED', 'CAPTURED', 1).allowed).toBe(true);

    // Gate 2: Refund initiation requires PASS inspection outcome
    expect(canInitiateRefundFromReturn('UNDER_INSPECTION', 'FAIL').allowed).toBe(false);
    expect(canInitiateRefundFromReturn('UNDER_INSPECTION', 'PASS').allowed).toBe(true);

    // Gate 3: Cleaning and recirculation are never blocked by pending refund
    expect(canCleanAndRecirculatePackage('CLEANING', 'REFUND_PENDING').allowed).toBe(true);

    // Reuse count increments only when passing inspection and completing cleaning/repair -> AVAILABLE
    expect(shouldIncrementReuseCount('CLEANING', 'AVAILABLE', 'PASS')).toBe(true);
    expect(shouldIncrementReuseCount('CLEANING', 'AVAILABLE', 'FAIL')).toBe(false);
    expect(shouldIncrementReuseCount('PACKED', 'AVAILABLE', 'PASS')).toBe(false);
  });
});

