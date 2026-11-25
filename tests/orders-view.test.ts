import { describe, expect, it } from 'vitest';
import { applyOrderFilters } from '@/lib/orders-query';

/** Minimal PostgREST builder double that records filter calls. */
function builder() {
  const calls: unknown[][] = [];
  const b: Record<string, unknown> = {};
  for (const m of ['in', 'not', 'eq', 'is', 'or', 'gte', 'lt']) b[m] = (...a: unknown[]) => { calls.push([m, ...a]); return b; };
  return { b, calls };
}

describe('orders list views', () => {
  it('main list shows only orders not yet sent to a delivery company', () => {
    const { b, calls } = builder();
    applyOrderFilters(b, {}, ['new']);
    expect(calls).toContainEqual(['in', 'delivery_status', ['not_submitted', 'submission_failed', 'pending_submission']]);
  });
  it('tracking view shows sent orders only', () => {
    const { b, calls } = builder();
    applyOrderFilters(b, { view: 'tracking' }, ['new']);
    expect(calls).toContainEqual(['not', 'delivery_status', 'in', '(not_submitted,submission_failed,pending_submission)']);
  });
  it('an explicit delivery filter is not combined with the default split', () => {
    const { b, calls } = builder();
    applyOrderFilters(b, { delivery: 'delivered' }, ['new']);
    expect(calls).toEqual([['eq', 'delivery_status', 'delivered']]);
  });
});
