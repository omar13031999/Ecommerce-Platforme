import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPublicSheet } from '@/lib/integrations/google-sheets/public-sheet';
import { extractGid, rowsToOrders } from '@/lib/integrations/google-sheets/mapping';

afterEach(() => vi.unstubAllGlobals());

describe('public Google Sheet (CSV export)', () => {
  it('builds the export URL from the gid and parses rows', async () => {
    const fetchMock = vi.fn(async () => new Response('Commande,Nom,Téléphone,Produit,Prix\nA1,"Karim, B",0555,Montre,4 500\n', { headers: { 'content-type': 'text/csv' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { header, rows } = await readPublicSheet('SHEETID123456789012345', 'gid:42', 1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://docs.google.com/spreadsheets/d/SHEETID123456789012345/export?format=csv&gid=42');
    expect(header).toEqual(['Commande', 'Nom', 'Téléphone', 'Produit', 'Prix']);
    const { orders } = rowsToOrders(header, rows, { external_id: 'Commande', customer_name: 'Nom', phone: 'Téléphone', product_name: 'Produit', product_price: 'Prix' });
    expect(orders[0]).toMatchObject({ external_id: 'A1', customer_name: 'Karim, B', items: [{ product_name: 'Montre', unit_price: 4500 }] });
  });

  it('reports a sheet that is not shared publicly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } })));
    await expect(readPublicSheet('SHEETID123456789012345', 'gid:0', 1)).rejects.toThrow('sheet_not_public');
  });

  it('extracts the tab id from URLs', () => {
    expect(extractGid('https://docs.google.com/spreadsheets/d/x/edit#gid=1234')).toBe('1234');
    expect(extractGid('https://docs.google.com/spreadsheets/d/x/edit?usp=sharing')).toBe('0');
  });
});

describe('header row detection', () => {
  it('finds the header when the saved header row does not match the mapping', async () => {
    const { readSourceRows, missingColumnsMessage } = await import('@/lib/services/sheets-sync');
    const csv = 'Boutique Hanoutna,,,\nCommande,Nom,Téléphone,Produit\nA1,Karim,0555123456,Montre\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(csv, { headers: { 'content-type': 'text/csv' } })));
    const r = await readSourceRows({
      connection_id: null, spreadsheet_id: 'SHEETID123456789012345', worksheet_title: 'gid:0', header_row: 1,
      column_mapping: { external_id: 'Commande', customer_name: 'Nom', phone: 'Téléphone', product_name: 'Produit' },
    });
    expect(r.headerRow).toBe(2);
    expect(r.rows[0]).toEqual(['A1', 'Karim', '0555123456', 'Montre']);
    expect(missingColumnsMessage(['phone'], ['ID', ' Nom '])).toBe('missing_columns:phone|found:ID; Nom');
  });
});
