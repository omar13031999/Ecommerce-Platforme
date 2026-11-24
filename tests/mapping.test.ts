import { describe, expect, it } from 'vitest';
import { extractSpreadsheetId, parseAmount, parseProductToken, parseSheetDate, rowsToOrders } from '@/lib/integrations/google-sheets/mapping';

describe('parseAmount', () => {
  it.each([
    ['2500', 2500], ['2 500 DA', 2500], ['2 500,00', 2500], ['1,500.50', 1500.5], ['1.500,50', 1500.5],
    ['3.000', 3000], ['12.5', 12.5], ['', null], ['abc', null], ['1 200 DZD', 1200],
  ])('%s -> %s', (raw, expected) => expect(parseAmount(raw)).toBe(expected));
});

describe('parseSheetDate', () => {
  it('parses dd/mm/yyyy hh:mm in Algiers time', () => {
    expect(parseSheetDate('24/11/2026 14:30')).toBe('2026-11-24T13:30:00.000Z');
  });
  it('parses ISO dates', () => expect(parseSheetDate('2026-11-24')).toBe('2026-11-24T11:00:00.000Z'));
  it('swaps when day > 12 in mdy style auto detection', () => expect(parseSheetDate('11/24/2026')).toBe('2026-11-24T11:00:00.000Z'));
  it('rejects garbage', () => expect(parseSheetDate('demain')).toBeNull());
});

describe('parseProductToken', () => {
  it('handles quantity suffix/prefix', () => {
    expect(parseProductToken('Montre x2')).toEqual({ name: 'Montre', quantity: 2 });
    expect(parseProductToken('3 x Bracelet')).toEqual({ name: 'Bracelet', quantity: 3 });
    expect(parseProductToken('Sac (4)')).toEqual({ name: 'Sac', quantity: 4 });
    expect(parseProductToken('Casque')).toEqual({ name: 'Casque', quantity: null });
  });
});

describe('rowsToOrders', () => {
  const header = ['N° Commande', 'Nom', 'Téléphone', 'Wilaya', 'Commune', 'Adresse', 'Produit', 'Qté', 'Prix', 'Livraison', 'Date'];
  const mapping = {
    external_id: 'n° commande', customer_name: 'NOM', phone: 'Telephone', wilaya: 'Wilaya', commune: 'Commune',
    address: 'Adresse', product_name: 'Produit', quantity: 'Qté', product_price: 'Prix', delivery_price: 'Livraison', created_at: 'Date',
  };

  it('maps columns case/accent-insensitively and groups multi-row orders', () => {
    const rows = [
      ['A1', 'Karim', '0555', '16', 'Hydra', 'Rue 1', 'Montre', '1', '4 500', '400', '24/11/2026'],
      ['A1', 'Karim', '0555', '16', 'Hydra', 'Rue 1', 'Bracelet', '2', '1000', '400', '24/11/2026'],
      ['', '', '', '', '', '', '', '', '', '', ''],
      ['A2', 'Sara', '0666', 'Oran', 'Bir', 'Rue 2', 'Sac', '', '3000', '', ''],
    ];
    const { orders, errors } = rowsToOrders(header, rows, mapping);
    expect(errors).toEqual([]);
    expect(orders).toHaveLength(2);
    expect(orders[0]!.items).toEqual([
      { product_name: 'Montre', sku: null, quantity: 1, unit_price: 4500 },
      { product_name: 'Bracelet', sku: null, quantity: 2, unit_price: 1000 },
    ]);
    expect(orders[0]!.delivery_fee).toBe(400);
    expect(orders[0]!.row_numbers).toEqual([2, 3]);
    expect(orders[1]!.items[0]!.quantity).toBe(1);
  });

  it('splits multi-product cells', () => {
    const rows = [['B1', 'Nadia', '0777', '31', 'Oran', 'X', 'Montre x2 | Sac', '', '4500 | 3000', '0', '']];
    const { orders } = rowsToOrders(header, rows, mapping, { multi_product_separator: '|' });
    expect(orders[0]!.items).toEqual([
      { product_name: 'Montre', sku: null, quantity: 2, unit_price: 4500 },
      { product_name: 'Sac', sku: null, quantity: 1, unit_price: 3000 },
    ]);
  });

  it('reports row-level errors and missing required columns', () => {
    const rows = [['', 'X', '0555', '', '', '', 'P', '1', '10', '', ''], ['C1', 'Y', '0555', '', '', '', 'P', '1', '', '', '']];
    const { errors } = rowsToOrders(header, rows, mapping);
    expect(errors.map((e) => e.error)).toEqual(['missing_external_id', 'missing_price']);
    const r = rowsToOrders(['a'], rows, mapping);
    expect(r.missingColumns).toContain('external_id');
    expect(r.orders).toEqual([]);
  });

  it('price_is_line_total divides by quantity', () => {
    const rows = [['D1', 'Y', '0555', '', '', '', 'P', '2', '5000', '', '']];
    expect(rowsToOrders(header, rows, mapping, { price_is_line_total: true }).orders[0]!.items[0]!.unit_price).toBe(2500);
  });
});

describe('extractSpreadsheetId', () => {
  it('accepts URLs and ids', () => {
    expect(extractSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=0')).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz012345');
    expect(extractSpreadsheetId('not a sheet')).toBeNull();
  });
});
