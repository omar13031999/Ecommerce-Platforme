// LIVE test against a real ECOTRACK account. Run: NODE_USE_ENV_PROXY=1 npm run test:live
// Requires network access to the instance and its token (injected by the proxy, or set ECOTRACK_TOKEN).
// Creates test orders and DELETES them right away (before validation, nothing is shipped).
import { describe, expect, it } from 'vitest';
import { ecotrackAdapter } from '@/lib/integrations/delivery/adapters/ecotrack';
import { httpJson } from '@/lib/integrations/http';
import type { AdapterContext, ShipmentInput } from '@/lib/integrations/delivery/types';

// LIVE test against the Navex ECOTRACK account (token injected by the network proxy).
// auto_validate: false — test orders must stay deletable (a shipped order cannot be deleted).
const ctx = (config: Record<string, unknown> = {}): AdapterContext => ({ baseUrl: 'https://navexdelivery.ecotrack.dz', credentials: { api_key: process.env.ECOTRACK_TOKEN ?? 'proxy-injected' }, config: { auto_validate: false, ...config } });
const base: ShipmentInput = {
  reference: '', orderId: 'x', orderReference: 0, customerName: 'TEST CLAUDE NE PAS EXPEDIER', firstName: 'TEST', lastName: 'CLAUDE',
  phone: '0555000001', phone2: null, wilayaCode: 16, wilayaName: 'Alger', commune: 'Bab Ezzouar', address: 'Test adresse',
  deliveryType: 'home', products: [{ name: 'TEST', quantity: 1, unitPrice: 1000, sku: null }], productsLabel: 'TEST x1',
  codAmount: 1000, deliveryFeeCharged: 0, notes: 'TEST API - A SUPPRIMER',
};
const del = (tracking: string) => httpJson({ url: `https://navexdelivery.ecotrack.dz/api/v1/delete/order`, method: 'DELETE', headers: { Authorization: `Bearer ${process.env.ECOTRACK_TOKEN ?? 'proxy-injected'}` }, query: { tracking } });
const log = (...a: unknown[]) => console.log('[live]', ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))));

describe('ECOTRACK live', () => {
  const cases: [string, Partial<ShipmentInput>, Record<string, unknown>][] = [
    ['home', {}, {}],
    ['stopdesk', { deliveryType: 'stopdesk', wilayaCode: 8, wilayaName: 'Béchar', commune: 'Bechar', address: '' }, {}],
    ['stock', { products: [{ name: 'موسع حزام الامان', quantity: 1, unitPrice: 1000, sku: 'RCS' }] }, { use_stock: true }],
    ['bad-commune', { commune: 'التوصيل للمكتب' }, {}],
  ];
  for (const [name, patch, config] of cases) {
    it(name, async () => {
      const input = { ...base, ...patch, reference: `TEST-CLAUDE-${name}-${Date.now()}` };
      try {
        const r = await ecotrackAdapter.createShipment!(ctx(config), input);
        log(name, 'created', r.trackingNumber, r.raw);
        const ev = await ecotrackAdapter.fetchTracking!(ctx(), [r.trackingNumber]);
        log(name, 'status', ev.map((e) => [e.providerStatus, ecotrackAdapter.statusMap[e.providerStatus.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()] ?? 'UNMAPPED']));
        const found = await ecotrackAdapter.findShipmentByReference!(ctx(), input.reference);
        log(name, 'lookup', found?.trackingNumber ?? null);
        const d = await del(r.trackingNumber);
        log(name, 'deleted', d.data);
        expect(found?.trackingNumber).toBe(r.trackingNumber);
      } catch (e) {
        const err = e as { kind?: string; message: string; body?: unknown };
        log(name, 'ERROR', err.kind, err.message, err.body);
        if (name !== 'bad-commune') throw e;
        return;
      }
    }, 120000);
  }
});
