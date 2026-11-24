import { describe, expect, it } from 'vitest';
import { allocateAdSpend } from '@/lib/domain/ad-allocation';
import { renderTemplate, getPath } from '@/lib/integrations/delivery/template';
import { resolveRange, rangeToInstants } from '@/lib/dates';
import { nextNoAnswer, naLevel } from '@/lib/domain/statuses';
import { effectivePermissions } from '@/lib/auth/permissions';

describe('allocateAdSpend', () => {
  const products = [
    { product_id: 'p1', orders: 10, distributed: 6, revenue: 60000 },
    { product_id: 'p2', orders: 5, distributed: 2, revenue: 20000 },
  ];
  it('uses attribution first, then the estimation method; never exceeds spend', () => {
    const r = allocateAdSpend({
      campaigns: [{ campaign_id: 'c1', spend_dzd: 1000 }, { campaign_id: 'c2', spend_dzd: 800 }],
      products,
      orderLinks: [{ campaign_id: 'c1', product_id: 'p1', revenue: 5000 }],
      campaignProducts: [],
      method: 'distributed',
    });
    const p1 = r.allocations.find((a) => a.product_id === 'p1')!;
    const p2 = r.allocations.find((a) => a.product_id === 'p2')!;
    expect(p1.attributed).toBe(1000);
    expect(p1.estimated).toBe(600);
    expect(p2.estimated).toBe(200);
    const total = r.allocations.reduce((s, a) => s + a.attributed + a.estimated, 0) + r.unallocated;
    expect(total).toBeCloseTo(r.totalSpend);
  });
  it('manual allocation is capped at real unattributed spend', () => {
    const r = allocateAdSpend({
      campaigns: [{ campaign_id: null, spend_dzd: 500 }], products, orderLinks: [], campaignProducts: [],
      method: 'manual', manual: [{ product_id: 'p1', amount: 800 }, { product_id: 'p2', amount: 200 }],
    });
    expect(r.allocations.reduce((s, a) => s + a.estimated, 0)).toBeCloseTo(500);
  });
  it('leaves spend unallocated when no product qualifies', () => {
    const r = allocateAdSpend({ campaigns: [{ campaign_id: 'x', spend_dzd: 300 }], products: [], orderLinks: [], campaignProducts: [], method: 'revenue' });
    expect(r.unallocated).toBe(300);
  });
});

describe('delivery template', () => {
  it('keeps raw types for whole placeholders and interpolates strings', () => {
    const out = renderTemplate({ amount: '{{codAmount}}', name: '{{firstName}} {{lastName}}', h: { k: '{{credentials.api_key}}' }, list: ['{{reference}}'] },
      { codAmount: 4500, firstName: 'Ali', lastName: 'B', reference: 'ORD1-1', credentials: { api_key: 'k' } });
    expect(out).toEqual({ amount: 4500, name: 'Ali B', h: { k: 'k' }, list: ['ORD1-1'] });
  });
  it('reads nested paths', () => expect(getPath({ a: [{ b: 'x' }] }, 'a.0.b')).toBe('x'));
});

describe('date ranges (Africa/Algiers)', () => {
  const now = new Date('2026-11-24T23:30:00Z'); // already 25/11 00:30 in Algiers
  it('today uses Algiers date', () => expect(resolveRange({ range: 'today' }, 'last30', now)).toMatchObject({ from: '2026-11-25', to: '2026-11-25' }));
  it('previous month', () => expect(resolveRange({ range: 'prev_month' }, 'last30', now)).toMatchObject({ from: '2026-10-01', to: '2026-10-31' }));
  it('custom swaps inverted bounds', () => expect(resolveRange({ range: 'custom', from: '2026-11-10', to: '2026-11-01' }, 'last30', now)).toMatchObject({ from: '2026-11-01', to: '2026-11-10' }));
  it('instants', () => expect(rangeToInstants({ from: '2026-11-01', to: '2026-11-01' })).toEqual({ start: '2026-10-31T23:00:00.000Z', end: '2026-11-01T23:00:00.000Z' }));
});

describe('statuses & permissions', () => {
  it('no answer progression', () => {
    expect(nextNoAnswer('new')).toBe('no_answer_1');
    expect(nextNoAnswer('no_answer_8')).toBe('no_answer_9');
    expect(nextNoAnswer('no_answer_9')).toBeNull();
    expect(naLevel('confirmed')).toBe(0);
  });
  it('agents have no financial permission by default', () => {
    expect(effectivePermissions('agent', []).has('finance.view')).toBe(false);
    expect(effectivePermissions('manager', []).has('finance.view')).toBe(false);
    expect(effectivePermissions('manager', ['finance.view', 'bogus']).has('finance.view')).toBe(true);
    expect(effectivePermissions('admin', []).has('settings.manage')).toBe(true);
  });
});
