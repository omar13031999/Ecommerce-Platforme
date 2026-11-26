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
  it('main list shows only orders still worked by confirmers (no cancelled, no confirmed, not sent)', () => {
    const { b, calls } = builder();
    applyOrderFilters(b, {}, ['new']);
    expect(calls).toContainEqual(['in', 'delivery_status', ['not_submitted', 'submission_failed', 'pending_submission']]);
    const statuses = calls.find((c) => c[0] === 'in' && c[1] === 'confirmation_status')![2] as string[];
    expect(statuses).toContain('postponed');
    expect(statuses).toContain('unreachable');
    expect(statuses).not.toContain('cancelled');
    expect(statuses).not.toContain('confirmed');
  });
  it('closed tab lists cancelled and duplicates', () => {
    const { b, calls } = builder();
    applyOrderFilters(b, { view: 'closed' }, ['new']);
    expect(calls).toEqual([['in', 'confirmation_status', ['cancelled', 'duplicate']]]);
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
