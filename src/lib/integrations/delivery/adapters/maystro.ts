import type { AdapterContext, CreateShipmentResult, DeliveryAdapter, ShipmentInput, TrackingEvent } from '../types';
import { baseValidation } from '../types';
import { httpJson, ProviderError } from '@/lib/integrations/http';
import type { DeliveryStatus } from '@/lib/domain/statuses';

/**
 * Maystro Delivery — implemented from the official documentation
 * (https://maystro.gitbook.io/maystro-delivery-documentation):
 *  - base https://backend.maystro-delivery.com/api, header "Authorization: Token <store token>"
 *  - GET  /shared/communes/?wilaya=<code>        commune ids (orders take a commune id, not a name)
 *  - GET  /stores/product/?page=n                store products (orders reference product uuids)
 *  - POST /stores/product/                       create a product (store_id, logistical_description, product_id)
 *  - POST /stores/orders/                        create an order (source 4, delivery_type 1 home / 2 stop desk)
 *  - GET  /stores/orders/?display_id=<id>        order + status code
 *  - webhooks: JSON base64-encoded (decode twice), events orderCreated / OrderStatusChanged
 *
 * tracking number = Maystro display_id (printed on the slip); the order uuid is kept as provider id.
 * Optional config: { "store_id": "<uuid>", "express": false, "create_missing_products": false }.
 * Products are taken from the links set in "Lier les produits", else matched by SKU (= Maystro product_id)
 * or exact name; never guessed. Creating missing products is off by default (a new Maystro product has no stock).
 */

type MaystroConfig = { store_id?: string; express?: boolean; create_missing_products?: boolean };
type MaystroProduct = { id: string; product_id: string | null; logistical_description: string; store?: string };
type MaystroOrder = { id: string; display_id: string | number; status: number; external_order_id?: string | null; alert_reason_name?: string | null; abort_reason?: unknown; postponed_to?: string | null };

const DEFAULT_BASE = 'https://backend.maystro-delivery.com/api';

/** Status codes from the documentation ("Status Code REF"). */
export const MAYSTRO_STATUS: Record<number, string> = {
  4: 'CREATED', 5: 'PICK_UP_REQUESTED', 6: 'IN_PROCESS', 8: 'WAITING_TRANSIT', 9: 'IN_TRANSIT_TO_BE_SHIPPED',
  10: 'IN_TRANSIT_TO_BE_RETURNED', 11: 'PENDING', 12: 'OUT_OF_STOCK', 15: 'READY_TO_SHIP', 22: 'ASSIGNED',
  31: 'SHIPPED', 32: 'ALERTED', 41: 'DELIVERED', 42: 'POSTPONED', 50: 'ABORTED', 51: 'READY_TO_RETURN',
  52: 'TAKEN_BY_STORE', 53: 'NOT_RECEIVED',
};

const STATUS_MAP: Record<string, DeliveryStatus> = {
  created: 'submitted',
  pick_up_requested: 'ready_for_pickup',
  in_process: 'processing',
  pending: 'processing',
  out_of_stock: 'processing',
  ready_to_ship: 'processing',
  waiting_transit: 'in_transit',
  in_transit_to_be_shipped: 'in_transit',
  assigned: 'out_for_delivery',
  shipped: 'out_for_delivery',
  alerted: 'failed_delivery',
  postponed: 'failed_delivery',
  in_transit_to_be_returned: 'failed_delivery',
  ready_to_return: 'failed_delivery',
  not_received: 'failed_delivery',
  delivered: 'delivered',
  taken_by_store: 'returned',
  aborted: 'cancelled',
};

const cfg = (ctx: AdapterContext) => (ctx.config ?? {}) as MaystroConfig;
function base(ctx: AdapterContext) {
  return (ctx.baseUrl?.trim() || DEFAULT_BASE).replace(/\/+$/, '').replace(/(\/api)?$/, '/api');
}
function auth(ctx: AdapterContext) {
  const t = ctx.credentials.api_key?.trim();
  if (!t) throw new ProviderError('auth', 'missing_api_token');
  return { Authorization: `Token ${t}` };
}
const key = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\u0621-\u064a]/g, ''); // keeps Arabic letters
const cut = (s: string | null | undefined, n = 255) => (s ?? '').trim().slice(0, n);

function validationMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const parts = Object.entries(body as Record<string, unknown>)
      .filter(([k]) => k !== 'status_code')
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
    if (parts.length) return parts.join(' | ').slice(0, 500);
  }
  return fallback;
}

async function get<T>(ctx: AdapterContext, path: string, query?: Record<string, string | number>) {
  return (await httpJson<T>({ url: `${base(ctx)}${path}`, method: 'GET', headers: auth(ctx), query, timeoutMs: 30000 })).data;
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length]![b.length]!;
}

/**
 * Maystro commune for a wilaya + commune name: exact (accent/case/punctuation-insensitive), else the single
 * closest spelling within 2 letters ("Bab Ezzouar" -> "Bab Azzouar"); null when absent or ambiguous.
 */
export function matchCommune(list: { id: number; name: string }[], commune: string): { id: number; name: string } | null {
  const k = key(commune);
  if (!k) return null;
  const exact = list.find((c) => key(c.name) === k);
  if (exact) return exact;
  if (k.length < 5) return null;
  const scored = list.map((c) => ({ c, d: distance(key(c.name), k) })).filter((x) => x.d <= 2).sort((a, b) => a.d - b.d);
  if (!scored.length || (scored[1] && scored[1].d === scored[0]!.d)) return null;
  return scored[0]!.c;
}

export async function maystroCommuneId(ctx: AdapterContext, wilaya: number, commune: string): Promise<number | null> {
  const list = await get<{ id: number; wilaya: number; name: string }[]>(ctx, '/shared/communes/', { wilaya });
  return matchCommune(Array.isArray(list) ? list : [], commune)?.id ?? null;
}

/** All store products (20 per page, paginated with "next"). */
export async function listMaystroProducts(ctx: AdapterContext): Promise<MaystroProduct[]> {
  const out: MaystroProduct[] = [];
  for (let page = 1; page <= 50; page++) {
    const data = await get<{ list?: { results?: MaystroProduct[]; next?: string | null }; results?: MaystroProduct[]; next?: string | null }>(ctx, '/stores/product/', { page });
    const l = data?.list ?? data;
    out.push(...(l?.results ?? []));
    if (!l?.next) break;
  }
  return out;
}

/** Maystro product uuid for an order line: by our SKU (= Maystro product_id), else by name; created when missing. */
async function resolveProducts(ctx: AdapterContext, input: ShipmentInput) {
  const catalog = await listMaystroProducts(ctx);
  const storeId = cfg(ctx).store_id || catalog.find((p) => p.store)?.store || null;
  const lines = [];
  for (const p of input.products) {
    const sku = p.sku?.trim();
    let hit = (p.externalId && catalog.find((c) => c.id === p.externalId))
      || (sku && catalog.find((c) => c.product_id && c.product_id.toLowerCase() === sku.toLowerCase()))
      || catalog.find((c) => key(c.logistical_description) === key(p.name));
    if (!hit) {
      if (!cfg(ctx).create_missing_products || !storeId) {
        throw new ProviderError('validation', `maystro_product_unknown: « ${p.name} » n'est lié à aucun produit du magasin Maystro. Liez-le dans Intégrations → Maystro → Lier les produits.`);
      }
      try {
        hit = (await httpJson<MaystroProduct>({
          url: `${base(ctx)}/stores/product/`, method: 'POST', headers: auth(ctx),
          json: { store_id: storeId, logistical_description: cut(p.name), ...(sku ? { product_id: sku } : {}) },
        })).data;
      } catch (e) {
        if (e instanceof ProviderError && e.kind === 'validation') throw new ProviderError('validation', `maystro_product_create: ${validationMessage(e.body, e.message)}`, e.status, e.body);
        throw e;
      }
      catalog.push(hit);
    }
    lines.push({ product_id: hit.id, quantity: p.quantity, logistical_description: hit.logistical_description });
  }
  return lines;
}

async function findByDisplayId(ctx: AdapterContext, displayId: string): Promise<MaystroOrder | null> {
  const data = await get<{ list?: { results?: MaystroOrder[] }; results?: MaystroOrder[] }>(ctx, '/stores/orders/', { display_id: displayId });
  const results = (data?.list ?? data)?.results ?? [];
  return results.find((o) => String(o.display_id) === String(displayId)) ?? results[0] ?? null;
}

function toEvent(o: MaystroOrder): TrackingEvent {
  const name = MAYSTRO_STATUS[o.status] ?? `STATUS_${o.status}`;
  return {
    trackingNumber: String(o.display_id),
    providerStatus: name,
    occurredAt: null,
    eventId: `${o.id}:${o.status}`,
    reason: o.alert_reason_name ?? (o.postponed_to ? `postponed_to ${o.postponed_to}` : null),
    raw: o,
  };
}

/** Webhook bodies are JSON encoded in base64, sometimes twice. */
export function decodeMaystroWebhook(raw: string): unknown {
  let cur = raw.trim();
  for (let i = 0; i < 3; i++) {
    try {
      return JSON.parse(cur);
    } catch {
      try {
        const next = Buffer.from(cur.replace(/^"|"$/g, ''), 'base64').toString('utf8').trim();
        if (!next || next === cur) return null;
        cur = next;
      } catch {
        return null;
      }
    }
  }
  try { return JSON.parse(cur); } catch { return null; }
}

export const maystroAdapter: DeliveryAdapter = {
  code: 'maystro',
  name: 'Maystro Delivery',
  docsUrl: 'https://maystro.gitbook.io/maystro-delivery-documentation',
  integrationLevel: 'documented',
  defaultBaseUrl: DEFAULT_BASE,
  credentialFields: [{ key: 'api_key', labelKey: 'api_token', secret: true, required: true }],
  configFields: [],
  capabilities: { createShipment: true, findByReference: true, tracking: true, webhooks: true, fees: false },
  statusMap: STATUS_MAP,
  validate(input) {
    const errors = baseValidation(input);
    if (input.wilayaCode && (input.wilayaCode < 1 || input.wilayaCode > 58)) errors.push('wilaya');
    return errors;
  },

  async testConnection(ctx) {
    await get(ctx, '/stores/product/', { page: 1 });
  },

  async cancelShipment(ctx, shipment) {
    // Documented status change: 50 = cancelled, abort reason 21 (store request). Needs the order uuid.
    const id = shipment.providerShipmentId ?? (await findByDisplayId(ctx, shipment.trackingNumber))?.id;
    if (!id) throw new ProviderError('not_found', 'maystro_order_not_found');
    try {
      await httpJson({ url: `${base(ctx)}/shared/status/${id}/`, method: 'PATCH', headers: auth(ctx), json: { status: 50, abort_reason: 21 }, timeoutMs: 30000 });
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'validation') throw new ProviderError('validation', validationMessage(e.body, e.message), e.status, e.body);
      throw e;
    }
  },

  async createShipment(ctx, input: ShipmentInput): Promise<CreateShipmentResult> {
    if (!input.wilayaCode || !input.commune) throw new ProviderError('validation', 'wilaya_commune_required');
    const commune = await maystroCommuneId(ctx, input.wilayaCode, input.commune);
    if (!commune) throw new ProviderError('validation', `commune_unknown: « ${input.commune} » n'est pas une commune Maystro de la wilaya ${input.wilayaCode}. Choisissez la commune dans la liste (Modifier).`);
    const products = await resolveProducts(ctx, input);
    const body = {
      external_order_id: cut(input.reference),
      source: 4,
      wilaya: input.wilayaCode,
      commune,
      destination_text: cut(input.address) || cut(input.commune),
      customer_phone: input.phone.replace(/\s/g, ''),
      customer_name: cut(input.customerName),
      product_price: Math.round(input.codAmount),
      delivery_type: input.deliveryType === 'stopdesk' ? 2 : 1,
      express: Boolean(cfg(ctx).express),
      note_to_driver: cut(input.notes),
      products,
    };
    let data: MaystroOrder;
    try {
      ({ data } = await httpJson<MaystroOrder>({ url: `${base(ctx)}/stores/orders/`, method: 'POST', headers: auth(ctx), json: body, timeoutMs: 30000 }));
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'validation') throw new ProviderError('validation', validationMessage(e.body, e.message), e.status, e.body);
      throw e;
    }
    if (!data?.display_id) throw new ProviderError('ambiguous', 'display_id_not_found_in_response', 200, data);
    return { trackingNumber: String(data.display_id), providerShipmentId: data.id, providerReference: input.reference, labelUrl: null, raw: data };
  },

  async findShipmentByReference(ctx, reference) {
    // No filter by external id in the documentation: scan the most recent pages.
    for (let page = 1; page <= 5; page++) {
      const data = await get<{ list?: { results?: MaystroOrder[]; next?: string | null } }>(ctx, '/stores/orders/', { page });
      const l = data?.list;
      const hit = (l?.results ?? []).find((o) => o.external_order_id === reference);
      if (hit) return { trackingNumber: String(hit.display_id), providerShipmentId: hit.id, providerReference: reference, raw: hit };
      if (!l?.next) break;
    }
    return null;
  },

  async fetchTracking(ctx, trackingNumbers) {
    const out: TrackingEvent[] = [];
    for (const t of trackingNumbers) {
      const o = await findByDisplayId(ctx, t);
      if (o) out.push(toEvent(o));
    }
    return out;
  },

  async handleWebhook(ctx, req) {
    const body = decodeMaystroWebhook(req.rawBody) as { payload?: { display_id_order?: string | number } } | null;
    const displayId = body?.payload?.display_id_order;
    if (!displayId) return { kind: 'events', valid: true, events: [] };
    // The body is only a trigger: the status is re-read from the API with the store token.
    const o = await findByDisplayId(ctx, String(displayId));
    return { kind: 'events', valid: true, events: o ? [toEvent(o)] : [] };
  },
};
