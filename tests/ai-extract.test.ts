import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiRowToOrder } from '@/lib/integrations/google-sheets/ai-order';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const cells = { Nom: '0555 12 34 56 Karim', Wilaya: 'الجزائر - باب الزوار', Produit: 'Tn Gold 41 x2 7000' };

describe('AI row -> order', () => {
  it('normalises a complete extraction', () => {
    const o = aiRowToOrder({
      customer_name: 'Karim', phone: '+213 555 12 34 56', phone2: null, wilaya_code: 16, commune: 'Bab Ezzouar', address: 'Cité 1',
      delivery_type: 'home', products: [{ name: 'Tn Gold 41', sku: 'TG41', quantity: 2, unit_price: 3500 }],
      total_amount: 7000, delivery_fee: null, notes: null, missing: [],
    }, 'auto-1', 2, cells, null);
    expect(o).toMatchObject({ phone: '0555123456', wilaya: '16', commune: 'Bab Ezzouar', needs_review: false, items: [{ sku: 'TG41', quantity: 2, unit_price: 3500 }] });
  });

  it('flags missing data and keeps the original row for the confirmer', () => {
    const o = aiRowToOrder({
      customer_name: null, phone: '0555', phone2: null, wilaya_code: null, commune: null, address: null,
      delivery_type: 'stopdesk', products: [{ name: 'Tn Gold 41', sku: null, quantity: 1, unit_price: null }],
      total_amount: 3900, delivery_fee: 400, notes: null, missing: ['customer_name', 'wilaya'],
    }, 'auto-2', 3, cells, null);
    expect(o.needs_review).toBe(true);
    expect(o.review_reason).toMatch(/^Extraction IA — Import incomplet/);
    expect(o.review_reason).toContain('téléphone');
    expect(o.review_reason).toContain("ligne d'origine : Nom: 0555 12 34 56 Karim");
    expect(o.items[0]!.unit_price).toBe(3500); // (total - delivery fee) / quantity
  });
});

describe('AI extraction call', () => {
  it('sends rows with the catalogue and parses the structured answer', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    const answer = { orders: [{ row: 2, customer_name: 'Karim', phone: '0555123456', phone2: null, wilaya_code: 16, commune: 'Bab Ezzouar', address: null, delivery_type: 'home',
      products: [{ name: 'Tn Gold 41', sku: 'TG41', quantity: 2, unit_price: 3500 }], total_amount: 7000, delivery_fee: null, notes: null, missing: ['address'] }] };
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('claude-opus-5-5');
      expect(body.fallbacks).toBe('default');
      expect(body.output_config.format.type).toBe('json_schema');
      expect(JSON.stringify(body.system)).toContain('TG41 | Tn Gold 41');
      expect(body.messages[0].content).toContain('باب الزوار');
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 10, output_tokens: 10 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { extractRowsWithAI } = await import('@/lib/integrations/google-sheets/ai-extract');
    const { results, errors } = await extractRowsWithAI([{ row: 2, cells }], [{ name: 'Tn Gold 41', sku: 'TG41' }]);
    expect(errors).toEqual([]);
    expect(results.get(2)).toMatchObject({ customer_name: 'Karim', wilaya_code: 16, products: [{ sku: 'TG41' }] });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/v1/messages');
  });

  it('reports an invalid key instead of throwing', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-bad');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } })));
    const { extractRowsWithAI } = await import('@/lib/integrations/google-sheets/ai-extract');
    const r = await extractRowsWithAI([{ row: 2, cells }], []);
    expect(r.results.size).toBe(0);
    expect(r.errors[0]).toMatch(/^ai_invalid_api_key/);
  });
});

describe('AI availability', () => {
  it('treats a placeholder value as not configured', async () => {
    const { aiExtractionAvailable } = await import('@/lib/integrations/google-sheets/ai-extract');
    vi.stubEnv('ANTHROPIC_API_KEY', 'A_REMPLACER');
    expect(aiExtractionAvailable()).toBe(false);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-xyz');
    expect(aiExtractionAvailable()).toBe(true);
  });
});

describe('AI extraction through Vercel AI Gateway', () => {
  it('uses the gateway with the cheap default model when no Anthropic key is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'A_REMPLACER');
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gw-test');
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://ai-gateway.vercel.sh/v1/messages');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('anthropic/claude-haiku-5.5');
      expect(body.fallbacks).toBeUndefined();
      expect(body.output_config.format.type).toBe('json_schema');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer gw-test');
      return new Response(JSON.stringify({
        id: 'msg_2', type: 'message', role: 'assistant', model: 'anthropic/claude-haiku-5.5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify({ orders: [] }) }], usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { extractRowsWithAI, aiExtractionAvailable } = await import('@/lib/integrations/google-sheets/ai-extract');
    expect(aiExtractionAvailable()).toBe(true);
    const r = await extractRowsWithAI([{ row: 2, cells: { A: 'x' } }], []);
    expect(r.errors).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports exhausted or locked free credits clearly', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gw-test');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'customer_verification_required', message: 'Add a payment method to unlock free credits' } }), { status: 403, headers: { 'content-type': 'application/json' } })));
    const { extractRowsWithAI } = await import('@/lib/integrations/google-sheets/ai-extract');
    const r = await extractRowsWithAI([{ row: 2, cells: { A: 'x' } }], []);
    expect(r.errors[0]).toMatch(/^ai_gateway_credits|^ai_api_error/);
  });

  it('falls back to plain JSON when the structured-output request is rejected', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'A_REMPLACER');
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gw-test');
    const answer = { orders: [{ row: 2, customer_name: 'Karim', phone: '0555123456', phone2: null, wilaya_code: 16, commune: 'Kouba', address: null,
      delivery_type: 'home', products: [{ name: 'Montre', sku: null, quantity: 1, unit_price: 4500 }], total_amount: null, delivery_fee: null, notes: null, missing: [] }] };
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.output_config) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'output_config: Extra inputs are not permitted' } }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        id: 'msg_3', type: 'message', role: 'assistant', model: 'm', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: '```json\n' + JSON.stringify(answer) + '\n```' }], usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { extractRowsWithAI } = await import('@/lib/integrations/google-sheets/ai-extract');
    const r = await extractRowsWithAI([{ row: 2, cells: { Nom: '0555123456', Tel: 'Karim' } }], []);
    expect(r.errors).toEqual([]);
    expect(r.results.get(2)).toMatchObject({ phone: '0555123456', customer_name: 'Karim', wilaya_code: 16 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
