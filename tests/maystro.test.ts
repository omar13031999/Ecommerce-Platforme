import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeMaystroWebhook, matchCommune, maystroAdapter } from '@/lib/integrations/delivery/adapters/maystro';
import type { AdapterContext, ShipmentInput } from '@/lib/integrations/delivery/types';

afterEach(() => vi.unstubAllGlobals());
const ctx: AdapterContext = { baseUrl: null, credentials: { api_key: 'TKN' }, config: {} };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const input: ShipmentInput = {
  reference: 'ORD-1', orderId: 'o', orderReference: 1, customerName: 'Karim', firstName: 'K', lastName: 'B', phone: '0555 12 34 56', phone2: null,
  wilayaCode: 2, wilayaName: 'Chlef', commune: 'Ténès', address: 'Cité 1', deliveryType: 'stopdesk',
  products: [{ name: 'Tn Gold 41', quantity: 2, unitPrice: 3500, sku: 'TG41' }], productsLabel: 'Tn Gold 41 x2', codAmount: 7400, deliveryFeeCharged: 400, notes: 'Appeler',
};

describe('Maystro adapter (official docs)', () => {
  it('cancels an order with the documented status change (50, store request)', async () => {
    const f = vi.fn(async (_u: unknown, _i?: RequestInit) => json({ ok: true }));
    vi.stubGlobal('fetch', f);
    await maystroAdapter.cancelShipment!(ctx, { trackingNumber: '37328030000013', providerShipmentId: 'uuid-1' });
    const [u, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(u)).toBe('https://backend.maystro-delivery.com/api/shared/status/uuid-1/');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ status: 50, abort_reason: 21 });
  });

  it('creates an order with commune id, product uuid and Token auth', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: URL, init?: RequestInit) => {
      const url = String(u);
      calls.push({ url, init });
      if (url.includes('/shared/communes/')) return json([{ id: 29, wilaya: 2, name: 'Chlef' }, { id: 30, wilaya: 2, name: 'Tenes' }]);
      if (url.includes('/stores/product/')) return json({ list: { results: [{ id: 'uuid-tg41', product_id: 'TG41', logistical_description: 'Tn Gold 41', store: 'store-1' }], next: null } });
      if (url.endsWith('/stores/orders/')) return json({ id: 'ord-uuid', display_id: '000217543', status: 4 }, 201);
      return json({}, 404);
    }));
    const r = await maystroAdapter.createShipment!(ctx, input);
    expect(r).toMatchObject({ trackingNumber: '000217543', providerShipmentId: 'ord-uuid' });
    const create = calls.find((c) => c.url.endsWith('/stores/orders/'))!;
    expect(create.url).toBe('https://backend.maystro-delivery.com/api/stores/orders/');
    expect((create.init!.headers as Record<string, string>).Authorization).toBe('Token TKN');
    expect(JSON.parse(String(create.init!.body))).toMatchObject({
      source: 4, wilaya: 2, commune: 30, delivery_type: 2, product_price: 7400, customer_phone: '0555123456', external_order_id: 'ORD-1',
      products: [{ product_id: 'uuid-tg41', quantity: 2 }],
    });
  });

  it('refuses an unknown commune before calling the order endpoint', async () => {
    const f = vi.fn(async (u: URL) => (String(u).includes('/shared/communes/') ? json([{ id: 29, wilaya: 2, name: 'Chlef' }]) : json({}, 500)));
    vi.stubGlobal('fetch', f);
    await expect(maystroAdapter.createShipment!(ctx, { ...input, commune: 'التوصيل للمكتب' })).rejects.toMatchObject({ kind: 'validation' });
    expect(f.mock.calls.some((c) => String(c[0]).endsWith('/stores/orders/'))).toBe(false);
  });

  it('reads statuses by display id and maps them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ list: { results: [{ id: 'u', display_id: '1021', status: 41 }] } })));
    const [ev] = await maystroAdapter.fetchTracking!(ctx, ['1021']);
    expect(ev).toMatchObject({ trackingNumber: '1021', providerStatus: 'DELIVERED' });
    expect(maystroAdapter.statusMap.delivered).toBe('delivered');
    expect(maystroAdapter.statusMap.aborted).toBe('cancelled');
  });

  it('decodes base64 webhook bodies (twice)', () => {
    const payload = { event: 'OrderStatusChanged', payload: { display_id_order: '1309043090', status: 41 } };
    const once = Buffer.from(JSON.stringify(payload)).toString('base64');
    const twice = Buffer.from(once).toString('base64');
    expect(decodeMaystroWebhook(twice)).toEqual(payload);
    expect(decodeMaystroWebhook(JSON.stringify(payload))).toEqual(payload);
  });

  it('matches communes despite small spelling differences, never ambiguously', () => {
    const list = [{ id: 1, name: 'Bab Azzouar' }, { id: 2, name: 'Bab El Oued' }, { id: 3, name: 'Kouba' }];
    expect(matchCommune(list, 'Bab Ezzouar')?.id).toBe(1);
    expect(matchCommune(list, 'kouba')?.id).toBe(3);
    expect(matchCommune(list, 'Oran')).toBeNull();
    expect(matchCommune([{ id: 1, name: 'Ain Abid' }, { id: 2, name: 'Ain Amid' }], 'Ain Aqid')).toBeNull();
  });

  it('uses the linked Maystro product, and never matches Arabic names by accident', async () => {
    const calls: { url: string; body?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: URL, init?: RequestInit) => {
      const url = String(u);
      calls.push({ url, body: init?.body ? String(init.body) : undefined });
      if (url.includes('/shared/communes/')) return json([{ id: 30, wilaya: 2, name: 'Tenes' }]);
      if (url.includes('/stores/product/')) return json({ list: { results: [
        { id: 'uuid-a', product_id: null, logistical_description: 'موسع حزام الأمان السيارة x3', store: 's' },
        { id: 'uuid-b', product_id: null, logistical_description: 'كشاف ضوئي الاطفال', store: 's' },
      ], next: null } });
      if (url.endsWith('/stores/orders/')) return json({ id: 'o', display_id: '1', status: 4 }, 201);
      return json({}, 404);
    }));
    await maystroAdapter.createShipment!(ctx, { ...input, products: [{ name: 'موسع حزام الامان', quantity: 1, unitPrice: 230, externalId: 'uuid-a' }] });
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/stores/orders/'))!.body!).products[0].product_id).toBe('uuid-a');
    await expect(maystroAdapter.createShipment!(ctx, { ...input, products: [{ name: 'منتج غير موجود', quantity: 1, unitPrice: 1 }] })).rejects.toMatchObject({ kind: 'validation' });
  });
});
