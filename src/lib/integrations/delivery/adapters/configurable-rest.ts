import type { DeliveryAdapter, AdapterContext, ShipmentInput, TrackingEvent } from '../types';
import { baseValidation, normalizeProviderStatus } from '../types';
import { httpJson, ProviderError } from '@/lib/integrations/http';
import { getPath, renderTemplate } from '../template';
import { hmacSha256, safeEqual } from '@/lib/crypto';

/**
 * Generic adapter for any delivery company exposing a JSON REST API.
 * The administrator copies the endpoints, payload and response paths from the
 * provider's OFFICIAL documentation into the provider configuration — the
 * platform never guesses them. Example configuration: docs/delivery-providers.md
 *
 * config = {
 *   auth: { headers: { "X-API-KEY": "{{credentials.api_key}}" } },
 *   create: { method: "POST", path: "/orders", body: {...template...},
 *             tracking_path: "data.tracking", id_path?: "...", label_path?: "...",
 *             success_path?: "success" },
 *   lookup?: { path: "/orders?reference={{reference}}", tracking_path: "data.0.tracking" },
 *   tracking?: { path: "/tracking/{{tracking}}", status_path: "data.status",
 *                date_path?: "data.updated_at", events_path?: "data.history" },
 *   fees?: { path: "/orders/{{tracking}}", fee_path: "data.delivery_fee", return_fee_path?: "..." },
 *   test?: { path: "/me" },
 *   webhook?: { signature_header?: "x-signature", signature_encoding?: "hex"|"base64",
 *               events_path?: "events", tracking_path: "tracking", status_path: "status",
 *               date_path?: "date", id_path?: "id" },
 *   status_map?: { "<provider status>": "<internal status>" }
 * }
 */
type RestConfig = {
  auth?: { headers?: Record<string, string>; query?: Record<string, string> };
  create?: { method?: 'POST' | 'PUT'; path: string; body: unknown; tracking_path: string; id_path?: string; label_path?: string; success_path?: string };
  lookup?: { path: string; tracking_path: string; id_path?: string };
  tracking?: { path: string; status_path: string; date_path?: string; events_path?: string; reason_path?: string };
  fees?: { path: string; fee_path: string; return_fee_path?: string };
  test?: { path: string };
  webhook?: {
    signature_header?: string;
    signature_encoding?: 'hex' | 'base64';
    events_path?: string;
    tracking_path: string;
    status_path: string;
    date_path?: string;
    id_path?: string;
  };
};

function cfg(ctx: AdapterContext): RestConfig {
  return ctx.config as RestConfig;
}

function vars(ctx: AdapterContext, extra: Record<string, unknown>) {
  return { credentials: ctx.credentials, config: ctx.config, ...extra };
}

function request(ctx: AdapterContext, path: string, v: Record<string, unknown>) {
  if (!ctx.baseUrl) throw new ProviderError('validation', 'missing_base_url');
  const c = cfg(ctx);
  const url = new URL(String(renderTemplate(path, v)), ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`);
  const headers = renderTemplate(c.auth?.headers ?? {}, v) as Record<string, string>;
  const query = renderTemplate(c.auth?.query ?? {}, v) as Record<string, string>;
  return { url: url.toString(), headers, query };
}

function str(v: unknown): string | null {
  return v === null || v === undefined || v === '' ? null : String(v);
}

export const configurableRestAdapter: DeliveryAdapter = {
  code: 'rest',
  name: 'API REST configurable',
  docsUrl: null,
  integrationLevel: 'documented',
  defaultBaseUrl: null,
  credentialFields: [
    { key: 'api_key', labelKey: 'api_key', secret: true, required: true },
    { key: 'api_id', labelKey: 'api_id', secret: true, required: false },
    { key: 'webhook_secret', labelKey: 'webhook_secret', secret: true, required: false },
  ],
  configFields: [],
  capabilities: { createShipment: true, findByReference: true, tracking: true, webhooks: true, fees: true },
  statusMap: {},
  validate: baseValidation,

  async testConnection(ctx) {
    const c = cfg(ctx);
    if (!c.test?.path) throw new ProviderError('validation', 'test_endpoint_not_configured');
    const r = request(ctx, c.test.path, vars(ctx, {}));
    await httpJson({ ...r, method: 'GET' });
  },

  async createShipment(ctx, input: ShipmentInput) {
    const c = cfg(ctx);
    if (!c.create) throw new ProviderError('validation', 'create_endpoint_not_configured');
    const v = vars(ctx, { ...input, order: input });
    const r = request(ctx, c.create.path, v);
    const { data } = await httpJson({ ...r, method: c.create.method ?? 'POST', json: renderTemplate(c.create.body, v), timeoutMs: 30000 });
    if (c.create.success_path && !getPath(data, c.create.success_path)) {
      throw new ProviderError('validation', JSON.stringify(data).slice(0, 500), 200, data);
    }
    const tracking = str(getPath(data, c.create.tracking_path));
    if (!tracking) {
      // Accepted but no tracking number found: outcome unclear, reconcile before retrying.
      throw new ProviderError('ambiguous', 'tracking_not_found_in_response', 200, data);
    }
    return {
      trackingNumber: tracking,
      providerShipmentId: c.create.id_path ? str(getPath(data, c.create.id_path)) : null,
      providerReference: input.reference,
      labelUrl: c.create.label_path ? str(getPath(data, c.create.label_path)) : null,
      raw: data,
    };
  },

  async findShipmentByReference(ctx, reference) {
    const c = cfg(ctx);
    if (!c.lookup) throw new ProviderError('validation', 'lookup_not_configured');
    const r = request(ctx, c.lookup.path, vars(ctx, { reference }));
    try {
      const { data } = await httpJson({ ...r, method: 'GET' });
      const tracking = str(getPath(data, c.lookup.tracking_path));
      if (!tracking) return null;
      return {
        trackingNumber: tracking,
        providerShipmentId: c.lookup.id_path ? str(getPath(data, c.lookup.id_path)) : null,
        providerReference: reference,
        raw: data,
      };
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'not_found') return null;
      throw e;
    }
  },

  async fetchTracking(ctx, trackingNumbers) {
    const c = cfg(ctx);
    if (!c.tracking) throw new ProviderError('validation', 'tracking_not_configured');
    const out: TrackingEvent[] = [];
    for (const tracking of trackingNumbers) {
      const r = request(ctx, c.tracking.path, vars(ctx, { tracking }));
      const { data } = await httpJson({ ...r, method: 'GET' });
      const events = c.tracking.events_path ? getPath(data, c.tracking.events_path) : [data];
      for (const ev of Array.isArray(events) ? events : [events]) {
        const status = str(getPath(ev, c.tracking.status_path));
        if (!status) continue;
        out.push({
          trackingNumber: tracking,
          providerStatus: status,
          occurredAt: c.tracking.date_path ? str(getPath(ev, c.tracking.date_path)) : null,
          reason: c.tracking.reason_path ? str(getPath(ev, c.tracking.reason_path)) : null,
          raw: ev,
        });
      }
    }
    return out;
  },

  async fetchFees(ctx, trackingNumbers) {
    const c = cfg(ctx);
    if (!c.fees) return [];
    const out = [];
    for (const tracking of trackingNumbers) {
      const r = request(ctx, c.fees.path, vars(ctx, { tracking }));
      const { data } = await httpJson({ ...r, method: 'GET' });
      const fee = Number(getPath(data, c.fees.fee_path));
      const ret = c.fees.return_fee_path ? Number(getPath(data, c.fees.return_fee_path)) : null;
      out.push({ trackingNumber: tracking, deliveryFee: Number.isFinite(fee) ? fee : null, returnFee: ret !== null && Number.isFinite(ret) ? ret : null, raw: data });
    }
    return out;
  },

  async handleWebhook(ctx, req) {
    const w = cfg(ctx).webhook;
    if (!w) return { kind: 'events', valid: false, events: [] };
    let valid = true;
    if (w.signature_header) {
      const secret = ctx.credentials.webhook_secret;
      const received = req.headers[w.signature_header.toLowerCase()] ?? '';
      valid = Boolean(secret) && safeEqual(hmacSha256(secret!, req.rawBody, w.signature_encoding ?? 'hex'), received.replace(/^sha256=/, ''));
    }
    let body: unknown;
    try {
      body = JSON.parse(req.rawBody);
    } catch {
      return { kind: 'events', valid: false, events: [] };
    }
    const list = w.events_path ? getPath(body, w.events_path) : [body];
    const events: TrackingEvent[] = [];
    for (const ev of Array.isArray(list) ? list : [list]) {
      const tracking = str(getPath(ev, w.tracking_path));
      const status = str(getPath(ev, w.status_path));
      if (!tracking || !status) continue;
      events.push({
        trackingNumber: tracking,
        providerStatus: status,
        occurredAt: w.date_path ? str(getPath(ev, w.date_path)) : null,
        eventId: w.id_path ? str(getPath(ev, w.id_path)) : null,
        raw: ev,
      });
    }
    return { kind: 'events', valid, events };
  },
};

export function restStatusMap(config: Record<string, unknown>): Record<string, string> {
  const map = (config.status_map ?? {}) as Record<string, string>;
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [normalizeProviderStatus(k), v]));
}
