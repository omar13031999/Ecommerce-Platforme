import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeEqual } from '@/lib/crypto';
import { applyEvents, loadProvider } from '@/lib/services/delivery';

export const dynamic = 'force-dynamic';

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'x-api-token']);

/**
 * Delivery provider webhooks: /api/webhooks/delivery/<providerId>/<secret path token>
 * 1. the unguessable path token identifies the provider (constant-time check);
 * 2. the adapter verifies the provider signature when configured;
 * 3. the raw payload is stored in webhook_inbox for traceability;
 * 4. events are mapped and applied idempotently (dedupe key per event).
 */
async function handle(req: Request, { params }: { params: Promise<{ providerId: string; token: string }> }) {
  const { providerId, token } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(providerId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const db = createAdminClient();
  const { data: row } = await db.from('delivery_providers').select('id, webhook_enabled, webhook_token, is_active').eq('id', providerId).maybeSingle();
  if (!row || !row.webhook_enabled || !row.is_active || !safeEqual(token, row.webhook_token)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const rawBody = req.method === 'GET' ? '' : await req.text();
  if (rawBody.length > 1_000_000) return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const query = Object.fromEntries(new URL(req.url).searchParams.entries());

  const { data: inbox } = await db.from('webhook_inbox').insert({
    provider_id: providerId,
    headers: Object.fromEntries(Object.entries(headers).filter(([k]) => !SENSITIVE_HEADERS.has(k))),
    body: rawBody.slice(0, 1_000_000),
  }).select('id').single();

  try {
    const { provider, adapter, ctx } = await loadProvider(providerId);
    if (!adapter.handleWebhook) throw new Error('webhooks_not_supported');
    const result = await adapter.handleWebhook(ctx, { method: req.method, headers, rawBody, query });
    if (result.kind === 'challenge') {
      await db.from('webhook_inbox').update({ processed_at: new Date().toISOString(), signature_valid: true, result: { challenge: true } }).eq('id', inbox?.id);
      return new NextResponse(result.response, { status: 200 });
    }
    if (!result.valid) {
      await db.from('webhook_inbox').update({ signature_valid: false, processed_at: new Date().toISOString(), error: 'invalid_signature' }).eq('id', inbox?.id);
      return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
    }
    const stats = await applyEvents(provider, adapter, result.events, 'webhook');
    await db.from('webhook_inbox').update({ signature_valid: true, processed_at: new Date().toISOString(), result: stats }).eq('id', inbox?.id);
    return NextResponse.json({ ok: true, ...stats });
  } catch (e) {
    await db.from('webhook_inbox').update({ processed_at: new Date().toISOString(), error: (e as Error).message.slice(0, 500) }).eq('id', inbox?.id);
    // 500 lets the provider retry; processing is idempotent.
    return NextResponse.json({ error: 'processing_failed' }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
