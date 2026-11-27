// LIVE (owner-approved): creates ONE test order in the Maystro store and cancels it right away (status 50 = ABORTED).
// Run: CADEAU_FILE=<file with a Maystro product uuid> NODE_USE_ENV_PROXY=1 LIVE=1 npx vitest run tests/live/maystro-order.live.ts
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { maystroAdapter } from '@/lib/integrations/delivery/adapters/maystro';
import { httpJson } from '@/lib/integrations/http';

const ctx = { baseUrl: null, credentials: { api_key: 'proxy-injected' }, config: { store_id: process.env.MAYSTRO_STORE_ID ?? '' } };
const log = (...a: unknown[]) => console.log('[mo]', ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))));

it('create + read + cancel one test order', async () => {
  const productUuid = readFileSync(process.env.CADEAU_FILE!, 'utf8').trim();
  const reference = `TEST-CLAUDE-${Date.now()}`;
  let created: Awaited<ReturnType<NonNullable<typeof maystroAdapter.createShipment>>> | null = null;
  try {
    created = await maystroAdapter.createShipment!(ctx, {
      reference, orderId: 'x', orderReference: 0, customerName: 'TEST CLAUDE NE PAS EXPEDIER', firstName: 'TEST', lastName: 'CLAUDE',
      phone: '0555000001', phone2: null, wilayaCode: 16, wilayaName: 'Alger', commune: 'Bab Ezzouar', address: 'TEST - A ANNULER',
      deliveryType: 'home', products: [{ name: 'Cadeau', quantity: 1, unitPrice: 1000, externalId: productUuid }], productsLabel: 'Cadeau x1',
      codAmount: 1000, deliveryFeeCharged: 0, notes: 'TEST API - NE PAS EXPEDIER',
    });
    log('created', created.trackingNumber, created.providerShipmentId, (created.raw as { status: number }).status);
    const ev = await maystroAdapter.fetchTracking!(ctx, [created.trackingNumber]);
    log('status', ev.map((e) => e.providerStatus));
    const found = await maystroAdapter.findShipmentByReference!(ctx, reference);
    log('lookup', found?.trackingNumber ?? null);
    expect(found?.trackingNumber).toBe(created.trackingNumber);
  } catch (e) {
    log('ERROR', (e as { kind?: string }).kind, (e as Error).message, (e as { body?: unknown }).body);
    throw e;
  } finally {
    if (created?.providerShipmentId) {
      const r = await httpJson({ url: `https://backend.maystro-delivery.com/api/shared/status/${created.providerShipmentId}/`, method: 'PATCH', headers: { Authorization: 'Token proxy-injected' }, json: { status: 50, abort_reason: 21 } });
      log('cancelled', r.data);
      const after = await maystroAdapter.fetchTracking!(ctx, [created.trackingNumber]);
      log('after cancel', after.map((e) => e.providerStatus));
    }
  }
}, 120000);
