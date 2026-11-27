// LIVE, read-only checks against a real Maystro store (token injected by the proxy). Run: NODE_USE_ENV_PROXY=1 npm run test:live
import { expect, it } from 'vitest';
import { listMaystroProducts, maystroAdapter, maystroCommuneId, MAYSTRO_STATUS } from '@/lib/integrations/delivery/adapters/maystro';
import { httpJson } from '@/lib/integrations/http';

const ctx = { baseUrl: null, credentials: { api_key: process.env.MAYSTRO_TOKEN ?? 'proxy-injected' }, config: {} };
const log = (...a: unknown[]) => console.log('[mlive]', ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))));

it('maystro read-only', async () => {
  await maystroAdapter.testConnection!(ctx);
  const products = await listMaystroProducts(ctx);
  log('products', products.length, products.slice(0, 5).map((p) => [p.logistical_description, p.product_id, p.id.slice(0, 8)]));
  log('communes', await maystroCommuneId(ctx, 16, 'Bab Ezzouar'), await maystroCommuneId(ctx, 2, 'Tenes'), await maystroCommuneId(ctx, 16, 'التوصيل للمكتب'));
  const { data } = await httpJson<{ list: { count: number; results: { display_id: string; status: number; external_order_id: string | null }[] } }>({
    url: 'https://backend.maystro-delivery.com/api/stores/orders/', headers: { Authorization: 'Token proxy-injected' },
  });
  log('orders count', data.list.count, data.list.results.slice(0, 6).map((o) => [o.display_id, o.status, MAYSTRO_STATUS[o.status] ?? 'UNKNOWN']));
  const statuses = new Set(data.list.results.map((o) => o.status));
  log('unknown codes', [...statuses].filter((s) => !MAYSTRO_STATUS[s]));
  if (data.list.results[0]) {
    const ev = await maystroAdapter.fetchTracking!(ctx, [String(data.list.results[0].display_id)]);
    log('tracking', ev.map((e) => [e.trackingNumber, e.providerStatus, maystroAdapter.statusMap[e.providerStatus.toLowerCase()]]));
    expect(ev[0]?.trackingNumber).toBe(String(data.list.results[0].display_id));
  }
  expect(products.length).toBeGreaterThan(0);
}, 120000);
