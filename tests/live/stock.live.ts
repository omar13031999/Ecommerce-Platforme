// LIVE, read-only: reads the ECOTRACK product list with stock. Run: NODE_USE_ENV_PROXY=1 npm run test:live
import { expect, it } from 'vitest';
import { listEcotrackProducts } from '@/lib/integrations/delivery/adapters/ecotrack';
it('reads all products with stock', async () => {
  const list = await listEcotrackProducts({ baseUrl: 'https://navexdelivery.ecotrack.dz', credentials: { api_key: process.env.ECOTRACK_TOKEN ?? 'proxy-injected' }, config: {} });
  console.log('[live] products', list.length, JSON.stringify(list.filter((p) => (p.physical ?? 0) > 0).slice(0, 6)));
  expect(list.length).toBeGreaterThan(15); // more than one page
  expect(list.every((p) => p.available !== null && p.physical !== null)).toBe(true);
}, 120000);
