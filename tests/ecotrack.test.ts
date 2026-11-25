import { afterEach, describe, expect, it, vi } from 'vitest';
import { ecotrackAdapter, listEcotrackCommunes, listEcotrackProducts } from '@/lib/integrations/delivery/adapters/ecotrack';
import type { AdapterContext, ShipmentInput } from '@/lib/integrations/delivery/types';

afterEach(() => vi.unstubAllGlobals());

const ctx = (config: Record<string, unknown> = {}): AdapterContext => ({
  baseUrl: 'https://navexdelivery.ecotrack.dz/',
  credentials: { api_key: 'TOKEN123' },
  config,
});

const input: ShipmentInput = {
  reference: 'ORD-42-1', orderId: 'o1', orderReference: 42, customerName: 'Karim Benali', firstName: 'Karim', lastName: 'Benali',
  phone: '0555 12 34 56', phone2: null, wilayaCode: 16, wilayaName: 'Alger', commune: 'Kouba', address: 'Rue 1',
  deliveryType: 'home', products: [{ name: 'Montre', quantity: 1, unitPrice: 4500 }], productsLabel: 'Montre x1',
  codAmount: 5200, deliveryFeeCharged: 700, notes: 'Appeler avant',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const call = (m: ReturnType<typeof vi.fn>, i = 0) => {
  const [u, init] = m.mock.calls[i] as [URL, RequestInit];
  return { url: new URL(String(u)), init };
};

describe('ECOTRACK adapter (official Postman documentation)', () => {
  it('creates an order with documented query parameters and Bearer auth', async () => {
    const f = vi.fn(async () => json({ success: true, tracking: 'ECQFLD2103047673' }));
    vi.stubGlobal('fetch', f);
    const r = await ecotrackAdapter.createShipment!(ctx(), input);
    expect(r.trackingNumber).toBe('ECQFLD2103047673');
    const { url, init } = call(f);
    expect(url.origin + url.pathname).toBe('https://navexdelivery.ecotrack.dz/api/v1/create/order');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN123');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      reference: 'ORD-42-1', nom_client: 'Karim Benali', telephone: '0555123456', adresse: 'Rue 1', commune: 'Kouba',
      code_wilaya: '16', montant: '5200', produit: 'Montre x1', type: '1', stop_desk: '0', remarque: 'Appeler avant',
    });
  });

  it('turns documented refusals into validation errors (nothing created)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: false, error: 10002, message: 'Pas de livraison pour la wilaya sélectionnée' })));
    await expect(ecotrackAdapter.createShipment!(ctx(), input)).rejects.toMatchObject({ kind: 'validation' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'The given data was invalid.', errors: { commune: ['Commune mal écrite, ou désactivée.'] } }, 422)));
    await expect(ecotrackAdapter.createShipment!(ctx(), input)).rejects.toMatchObject({ kind: 'validation', message: 'commune: Commune mal écrite, ou désactivée.' });
  });

  it('treats server errors as ambiguous (must reconcile before retrying)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'Server Error' }, 500)));
    await expect(ecotrackAdapter.createShipment!(ctx(), input)).rejects.toMatchObject({ kind: 'ambiguous' });
  });

  it('optionally validates (ships) the order after creation', async () => {
    const f = vi.fn(async (u: URL) => (String(u).includes('/valid/order') ? json({ success: true }) : json({ success: true, tracking: 'T1' })));
    vi.stubGlobal('fetch', f);
    await ecotrackAdapter.createShipment!(ctx({ auto_validate: true }), { ...input, deliveryType: 'stopdesk' });
    expect(call(f, 0).url.searchParams.get('stop_desk')).toBe('1');
    const v = call(f, 1).url;
    expect(v.pathname).toBe('/api/v1/valid/order');
    expect(Object.fromEntries(v.searchParams)).toEqual({ tracking: 'T1', ask_collection: '1' });
  });

  it('polls statuses in batches and maps them', async () => {
    const f = vi.fn(async () => json({ data: {
      ECL1: { status: 'en_livraison', activity: [{ reason: 'Remarque', details: 'Colis a livrer le 23', date: '2025-07-16', time: '02:31:15' }] },
      ECL2: { status: 'encaisse_non_paye', activity: [] },
    } }));
    vi.stubGlobal('fetch', f);
    const events = await ecotrackAdapter.fetchTracking!(ctx(), ['ECL1', 'ECL2']);
    const { url } = call(f);
    expect(url.pathname).toBe('/api/v1/get/orders/status');
    expect(Object.fromEntries(url.searchParams)).toEqual({ trackings: 'ECL1,ECL2', status: 'all' });
    expect(events[0]).toMatchObject({ trackingNumber: 'ECL1', providerStatus: 'en_livraison', occurredAt: '2025-07-16T02:31:15+01:00', reason: 'Remarque — Colis a livrer le 23' });
    expect(ecotrackAdapter.statusMap.en_livraison).toBe('out_for_delivery');
    expect(ecotrackAdapter.statusMap.encaisse_non_paye).toBe('delivered');
    expect(ecotrackAdapter.statusMap.retour_recu).toBe('returned');
  });

  it('uses webhooks only as a trigger and re-reads the status from the API', async () => {
    const f = vi.fn(async () => json({ data: { ECLWIT2507162547: { status: 'suspendu', activity: [] } } }));
    vi.stubGlobal('fetch', f);
    const r = await ecotrackAdapter.handleWebhook!(ctx(), { method: 'POST', headers: {}, query: {}, rawBody: JSON.stringify({ event: 'x', data: { tracking: 'ECLWIT2507162547', status: 'livred' } }) });
    expect(r).toMatchObject({ kind: 'events', valid: true, events: [{ trackingNumber: 'ECLWIT2507162547', providerStatus: 'suspendu' }] });
  });

  it('finds an order by our reference', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ current_page: 1, last_page: 1, data: [{ tracking: 'A', reference: 'X' }, { tracking: 'B', reference: 'ORD-42-1' }] })));
    expect((await ecotrackAdapter.findShipmentByReference!(ctx(), 'ORD-42-1'))?.trackingNumber).toBe('B');
  });

  it('validates the token with the documented endpoint', async () => {
    const f = vi.fn(async () => json({ success: false, message: 'INVALID_TOKEN' }));
    vi.stubGlobal('fetch', f);
    await expect(ecotrackAdapter.testConnection!(ctx())).rejects.toMatchObject({ kind: 'auth' });
    expect(call(f).url.pathname).toBe('/api/v1/validate/token');
  });

  it('sends stock references and quantities when use_stock is enabled', async () => {
    const f = vi.fn(async () => json({ success: true, tracking: 'T2' }));
    vi.stubGlobal('fetch', f);
    await ecotrackAdapter.createShipment!(ctx({ use_stock: true }), { ...input, products: [{ name: 'Tn Gold 41', quantity: 2, unitPrice: 1, sku: 'TG41' }, { name: 'RCS', quantity: 1, unitPrice: 1, sku: 'RCS' }] });
    expect(Object.fromEntries(call(f).url.searchParams)).toMatchObject({ stock: '1', produit: 'TG41,RCS', quantite: '2,1' });
    await expect(ecotrackAdapter.createShipment!(ctx({ use_stock: true }), input)).rejects.toMatchObject({ kind: 'validation' });
  });

  it('reads communes (object or array form) and products', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ 0: { nom: 'Abadla', wilaya_id: 8, code_postal: '817', has_stop_desk: 0, is_active: 1 }, 1: { nom: 'Ain Touta', wilaya_id: 5, code_postal: '545', has_stop_desk: 1, is_active: 1 } })));
    expect(await listEcotrackCommunes(ctx())).toEqual([
      { name: 'Abadla', wilayaCode: 8, postalCode: '817', hasStopDesk: false, isActive: true },
      { name: 'Ain Touta', wilayaCode: 5, postalCode: '545', hasStopDesk: true, isActive: true },
    ]);
    const pages = [
      { products: [{ reference: 'TG41', title: 'Tn Gold 41', is_active: 1, stock_disponible: 7 }], pagination: { current_page: 1, last_page: 2 } },
      { products: [{ reference: 'RCS', title: 'موسع حزام الامان', is_active: 1, stock_disponible: 5 }], pagination: { current_page: 2, last_page: 2 } },
    ];
    const f = vi.fn(async (u: URL) => json(pages[(Number(new URL(String(u)).searchParams.get('page')) || 1) - 1]));
    vi.stubGlobal('fetch', f);
    const products = await listEcotrackProducts(ctx());
    expect(products.map((p) => [p.reference, p.title, p.available])).toEqual([['TG41', 'Tn Gold 41', 7], ['RCS', 'موسع حزام الامان', 5]]);
    expect(call(f).url.pathname).toBe('/api/v1/get/products/list');
  });
});

describe('ECOTRACK alignment helpers', () => {
  it('matches commune names regardless of accents, case and punctuation', async () => {
    const { communeKey } = await import('@/lib/services/ecotrack-sync');
    expect(communeKey('Bab-Ezzouar')).toBe(communeKey('BAB EZZOUAR'));
    expect(communeKey('Béchar')).toBe(communeKey('bechar'));
    expect(communeKey('التوصيل للمكتب')).not.toBe(communeKey('Bechar'));
  });

  it('uses stock mode automatically when every line has a SKU', async () => {
    const f = vi.fn(async () => json({ success: true, tracking: 'T3' }));
    vi.stubGlobal('fetch', f);
    await ecotrackAdapter.createShipment!(ctx(), { ...input, products: [{ name: 'Tn Gold 41', quantity: 1, unitPrice: 1, sku: 'TG41' }] });
    expect(call(f).url.searchParams.get('stock')).toBe('1');
    await ecotrackAdapter.createShipment!(ctx({ use_stock: false }), { ...input, products: [{ name: 'Tn Gold 41', quantity: 1, unitPrice: 1, sku: 'TG41' }] });
    expect(call(f, 1).url.searchParams.get('stock')).toBeNull();
  });
});
