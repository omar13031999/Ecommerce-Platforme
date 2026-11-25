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
    expect(o.review_reason).toMatch(/^Import incomplet/);
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
    expect(r.errors).toEqual(['ai_invalid_api_key']);
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
