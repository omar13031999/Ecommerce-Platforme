import type { AdapterContext, CreateShipmentResult, DeliveryAdapter, ShipmentInput, TrackingEvent } from '../types';
import { baseValidation } from '../types';
import { httpJson, ProviderError } from '@/lib/integrations/http';
import type { DeliveryStatus } from '@/lib/domain/statuses';

/**
 * ECOTRACK — white-label platform used by many Algerian delivery companies
 * (each company has its own instance, e.g. https://<company>.ecotrack.dz).
 *
 * Implemented from the official "ECOTRACK API" Postman documentation
 * (https://documenter.getpostman.com/view/14517169/Tz5je15g):
 *  - auth: API token as Bearer in the Authorization header
 *    (validate/token only accepts it as the `api_token` query parameter — verified live)
 *  - POST /api/v1/create/order            (query parameters) -> { success, tracking }
 *  - POST /api/v1/valid/order?tracking=   (ship / validate, optional)
 *  - GET  /api/v1/get/orders?page&start_date&end_date (40/page, reference lookup)
 *  - GET  /api/v1/get/orders/status?trackings=a,b&status=all (max 100 trackings)
 *  - GET  /api/v1/validate/token?api_token=
 * Rate limits: 50 req/min, 1 500/h, 15 000/day.
 *
 * Webhooks: the payload format is not part of the public documentation, so the
 * webhook body is only used as a trigger — tracking numbers found in it are
 * re-read from the API with our own token (the status always comes from the
 * API, never from the unauthenticated body). Raw payloads stay in webhook_inbox.
 *
 * Optional provider config (JSON):
 *   { "auto_validate": true, "ask_collection": <auto>, "operation_type": 1, "use_stock": <auto> }
 * auto_validate (default true): the order is shipped ("Expédier", valid/order) right after creation;
 * ask_collection defaults to false for stock orders (goods already in the warehouse), true otherwise.
 * use_stock: the parcel is prepared from the stock held by the company
 * (stock=1, produit = product references, quantite = quantities). Default:
 * automatic when every order line is matched to a product with a SKU.
 */

type EcotrackConfig = { auto_validate?: boolean; ask_collection?: boolean; operation_type?: number; use_stock?: boolean };

/** Stock mode: explicit config, otherwise automatic when every line has a product reference (SKU). */
const stockMode = (c: EcotrackConfig, input: ShipmentInput) => c.use_stock ?? (input.products.length > 0 && input.products.every((p) => Boolean(p.sku?.trim())));

const MAX_TRACKINGS_PER_CALL = 100;

function cfg(ctx: AdapterContext): EcotrackConfig {
  return (ctx.config ?? {}) as EcotrackConfig;
}

function token(ctx: AdapterContext): string {
  const t = ctx.credentials.api_key?.trim();
  if (!t) throw new ProviderError('auth', 'missing_api_token');
  return t;
}

function url(ctx: AdapterContext, path: string): string {
  if (!ctx.baseUrl) throw new ProviderError('validation', 'missing_base_url');
  const base = ctx.baseUrl.replace(/\/+$/, '').replace(/\/api(\/v1)?$/, '');
  return `${base}${path}`;
}

function auth(ctx: AdapterContext) {
  return { Authorization: `Bearer ${token(ctx)}` };
}

const cut = (s: string | null | undefined, n = 255) => (s ?? '').trim().slice(0, n);
const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

/** Ecotrack dates are local Algerian time (UTC+1, no DST). */
function toIso(date?: string | null, time?: string | null): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const t = time && /^\d{2}:\d{2}(:\d{2})?$/.test(time) ? (time.length === 5 ? `${time}:00` : time) : '00:00:00';
  return `${date}T${t}+01:00`;
}

/** Laravel validation errors -> readable message. */
function validationMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as { message?: unknown; errors?: Record<string, unknown> };
    if (b.errors && typeof b.errors === 'object') {
      const parts = Object.entries(b.errors).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' ') : String(v)}`);
      if (parts.length) return parts.join(' | ').slice(0, 500);
    }
    if (b.message) return String(b.message).slice(0, 500);
  }
  return fallback;
}

type StatusEntry = {
  status?: string;
  order_id?: string;
  activity?: { reason?: string; details?: string; date?: string; time?: string; postponed_to?: string | null }[];
};

async function fetchStatuses(ctx: AdapterContext, trackings: string[]): Promise<Record<string, StatusEntry>> {
  const out: Record<string, StatusEntry> = {};
  for (let i = 0; i < trackings.length; i += MAX_TRACKINGS_PER_CALL) {
    const batch = trackings.slice(i, i + MAX_TRACKINGS_PER_CALL);
    const { data } = await httpJson<{ data?: Record<string, StatusEntry> }>({
      url: url(ctx, '/api/v1/get/orders/status'),
      method: 'GET',
      headers: auth(ctx),
      // Bearer header only (verified live); keeps the token out of URLs and logs.
      query: { trackings: batch.join(','), status: 'all' },
      timeoutMs: 30000,
    });
    Object.assign(out, data?.data ?? {});
  }
  return out;
}

function toEvents(entries: Record<string, StatusEntry>): TrackingEvent[] {
  const events: TrackingEvent[] = [];
  for (const [tracking, e] of Object.entries(entries)) {
    if (!e?.status) continue;
    const activity = Array.isArray(e.activity) ? e.activity : [];
    const last = activity[activity.length - 1];
    const reason = last ? [last.reason, last.details].filter(Boolean).join(' — ') || null : null;
    events.push({
      trackingNumber: tracking,
      providerStatus: e.status,
      occurredAt: last ? toIso(last.date, last.time) : null,
      // A new driver note under the same status is a new event; the same poll twice is not.
      eventId: `${tracking}:${e.status}:${activity.length}`,
      reason,
      raw: e,
    });
  }
  return events;
}

/** Recursively collects tracking numbers from an (undocumented) webhook payload. */
function collectTrackings(value: unknown, out: Set<string>, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const v of value) collectTrackings(v, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if ((key === 'tracking' || key === 'tracking_number' || key === 'trackings') && v) {
      for (const t of Array.isArray(v) ? v : [v]) {
        const s = String(t).trim();
        if (/^[A-Za-z0-9-]{6,40}$/.test(s)) out.add(s);
      }
    } else {
      collectTrackings(v, out, depth + 1);
    }
  }
}

// Order states ("status") documented for get/orders/status, plus the activity
// codes documented for get/tracking/info. Overridable per provider in the UI.
const STATUS_MAP: Record<string, DeliveryStatus> = {
  prete_a_expedier: 'submitted',
  prete_a_preparer: 'submitted', // seen live, not in the documented list
  en_ramassage: 'ready_for_pickup',
  en_preparation_stock: 'processing',
  vers_hub: 'in_transit',
  en_hub: 'in_transit',
  vers_wilaya: 'in_transit',
  en_preparation: 'in_transit',
  en_livraison: 'out_for_delivery',
  suspendu: 'failed_delivery',
  livre_non_encaisse: 'delivered',
  encaisse_non_paye: 'delivered',
  paiements_prets: 'delivered',
  paye_et_archive: 'delivered',
  retour_chez_livreur: 'failed_delivery',
  retour_transit_entrepot: 'failed_delivery',
  retour_en_traitement: 'failed_delivery',
  retour_recu: 'returned',
  retour_archive: 'returned',
  annule: 'cancelled',
  // activity codes
  order_information_received_by_carrier: 'processing',
  picked: 'picked_up',
  accepted_by_carrier: 'in_transit',
  dispatched_to_driver: 'out_for_delivery',
  attempt_delivery: 'failed_delivery',
  return_asked: 'failed_delivery',
  return_in_transit: 'failed_delivery',
  return_received: 'returned',
  livred: 'delivered',
  encaissed: 'delivered',
  payed: 'delivered',
};

export const ecotrackAdapter: DeliveryAdapter = {
  code: 'ecotrack',
  name: 'ECOTRACK',
  docsUrl: 'https://documenter.getpostman.com/view/14517169/Tz5je15g',
  integrationLevel: 'documented',
  defaultBaseUrl: null,
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
    const { data } = await httpJson<{ success?: boolean; message?: string }>({
      url: url(ctx, '/api/v1/validate/token'),
      method: 'GET',
      query: { api_token: token(ctx) },
    });
    if (!data?.success) throw new ProviderError('auth', data?.message ?? 'INVALID_TOKEN', 200, data);
  },

  async createShipment(ctx, input: ShipmentInput): Promise<CreateShipmentResult> {
    const c = cfg(ctx);
    const query: Record<string, string | number> = {
      reference: cut(input.reference),
      nom_client: cut(input.customerName),
      telephone: digits(input.phone),
      adresse: cut(input.address) || cut(input.commune),
      commune: cut(input.commune),
      code_wilaya: input.wilayaCode ?? '',
      montant: Math.round(input.codAmount),
      produit: cut(input.productsLabel),
      type: c.operation_type ?? 1,
      stop_desk: input.deliveryType === 'stopdesk' ? 1 : 0,
    };
    const usesStock = stockMode(c, input);
    if (usesStock) {
      const missing = input.products.filter((p) => !p.sku?.trim());
      if (missing.length) throw new ProviderError('validation', `missing_sku: ${missing.map((p) => p.name).join(', ')}`.slice(0, 300));
      query.stock = 1;
      query.produit = cut(input.products.map((p) => p.sku!.trim()).join(','));
      query.quantite = input.products.map((p) => p.quantity).join(',');
    }
    if (input.phone2 && digits(input.phone2)) query.telephone_2 = digits(input.phone2);
    if (input.notes?.trim()) query.remarque = cut(input.notes);

    let data: { success?: boolean; tracking?: string; error?: number; message?: string };
    try {
      ({ data } = await httpJson<typeof data>({ url: url(ctx, '/api/v1/create/order'), method: 'POST', headers: auth(ctx), query, timeoutMs: 30000 }));
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'validation') throw new ProviderError('validation', validationMessage(e.body, e.message), e.status, e.body);
      throw e;
    }
    if (data?.success === false) {
      throw new ProviderError('validation', `${data.error ?? ''} ${data.message ?? 'refused'}`.trim(), 200, data);
    }
    const tracking = data?.tracking ? String(data.tracking) : null;
    if (!tracking) throw new ProviderError('ambiguous', 'tracking_not_found_in_response', 200, data);

    // Ship ("Expédier") right away so the parcel leaves "Colis prêt" for processing.
    // Stock orders are prepared in the company's warehouse: no pickup request.
    let validation: unknown = null;
    if (c.auto_validate !== false) {
      const askCollection = c.ask_collection ?? !usesStock;
      // The parcel exists at this point: a failed validation must not fail the submission.
      try {
        ({ data: validation } = await httpJson({
          url: url(ctx, '/api/v1/valid/order'), method: 'POST', headers: auth(ctx),
          query: { tracking, ask_collection: askCollection ? 1 : 0 },
        }));
      } catch (e) {
        validation = { error: (e as Error).message };
      }
    }
    return { trackingNumber: tracking, providerReference: input.reference, labelUrl: null, raw: { create: data, validation } };
  },

  async findShipmentByReference(ctx, reference) {
    // No search-by-reference endpoint: scan recent in-process orders (40 per page).
    const start = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    for (let page = 1; page <= 10; page++) {
      const { data } = await httpJson<{ data?: { tracking?: string; reference?: string | null }[]; last_page?: number }>({
        url: url(ctx, '/api/v1/get/orders'), method: 'GET', headers: auth(ctx), query: { page, start_date: start },
      });
      const hit = (data?.data ?? []).find((o) => o.reference && o.reference === reference && o.tracking);
      if (hit?.tracking) return { trackingNumber: hit.tracking, providerReference: reference, raw: hit };
      if (!data?.data?.length || (data.last_page && page >= data.last_page)) break;
    }
    return null;
  },

  async fetchTracking(ctx, trackingNumbers) {
    return toEvents(await fetchStatuses(ctx, trackingNumbers));
  },

  async handleWebhook(ctx, req) {
    let body: unknown = null;
    try {
      body = req.rawBody ? JSON.parse(req.rawBody) : null;
    } catch {
      body = Object.fromEntries(new URLSearchParams(req.rawBody));
    }
    const found = new Set<string>();
    collectTrackings(body, found);
    collectTrackings(req.query, found);
    if (!found.size) return { kind: 'events', valid: true, events: [] };
    return { kind: 'events', valid: true, events: toEvents(await fetchStatuses(ctx, [...found].slice(0, 300))) };
  },
};

export type EcotrackCommune = { name: string; wilayaCode: number; postalCode: string | null; hasStopDesk: boolean; isActive: boolean };
export type EcotrackProduct = { reference: string; title: string; isActive: boolean; physical: number | null; reserved: number | null; available: number | null };

/** GET /api/v1/get/communes — deliverable communes, spelled as ECOTRACK expects them. */
export async function listEcotrackCommunes(ctx: AdapterContext): Promise<EcotrackCommune[]> {
  const { data } = await httpJson<unknown>({ url: url(ctx, '/api/v1/get/communes'), method: 'GET', headers: auth(ctx), timeoutMs: 45000 });
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data as Record<string, unknown>) : [];
  return list.flatMap((c) => {
    const x = c as { nom?: string; wilaya_id?: number | string; code_postal?: string | number | null; has_stop_desk?: number | boolean; is_active?: number | boolean };
    const wilayaCode = Number(x.wilaya_id);
    if (!x.nom?.trim() || !Number.isInteger(wilayaCode) || wilayaCode < 1 || wilayaCode > 58) return [];
    return [{
      name: x.nom.trim(), wilayaCode, postalCode: x.code_postal != null && x.code_postal !== '' ? String(x.code_postal) : null,
      hasStopDesk: Boolean(Number(x.has_stop_desk)), isActive: x.is_active === undefined ? true : Boolean(Number(x.is_active)),
    }];
  });
}

/** GET /api/v1/get/products/list — products stored at the delivery company (paginated). */
export async function listEcotrackProducts(ctx: AdapterContext): Promise<EcotrackProduct[]> {
  const out = new Map<string, EcotrackProduct>();
  for (let page = 1; page <= 100; page++) {
    const { data } = await httpJson<{ products?: { reference?: string | number; title?: string; is_active?: number; stock_disponible?: number; stock_reserve?: number; stock_phisique?: number }[]; pagination?: { current_page?: number; last_page?: number } }>({
      url: url(ctx, '/api/v1/get/products/list'), method: 'GET', headers: auth(ctx), query: page > 1 ? { page } : {},
    });
    for (const p of data?.products ?? []) {
      const reference = String(p.reference ?? '').trim();
      if (!reference || !p.title?.trim()) continue;
      const n = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
      out.set(reference.toLowerCase(), {
        reference, title: p.title.trim(), isActive: p.is_active === undefined ? true : Boolean(Number(p.is_active)),
        physical: n(p.stock_phisique), reserved: n(p.stock_reserve), available: n(p.stock_disponible),
      });
    }
    const pg = data?.pagination;
    // Stop on the last page, or if the API ignores the page parameter.
    if (!pg?.last_page || page >= pg.last_page || (pg.current_page !== undefined && pg.current_page !== page)) break;
  }
  return [...out.values()];
}
