/**
 * Bulk price list ("CODE <tab> Name <tab> Price", one product per line) matched
 * to catalogue products. Codes in a price list are often shorter or spelled
 * differently from the delivery company's references, so matching is, in order:
 *  1. exact SKU                                   TG41        -> TG41
 *  2. SKU ignoring separators / case              COMPRESSEUR_TOYOTA -> "Compresseur Toyota"
 *  3. size family: SKU = code + digits            TMD         -> TMD39, TMD40 … TMD43
 *  4. a SKU written in the name                   "Kit d'urgence / VKM" -> VKM
 *  5. same product name (accent/case-insensitive)
 * Lines with no match are reported (and can be created as new products).
 */

export type CatalogProduct = { id: string; sku: string | null; name: string };
export type PriceLine = { line: number; code: string; name: string; price: number | null; raw: string };
export type PriceMatch = PriceLine & { products: CatalogProduct[]; rule: 'sku' | 'sku_loose' | 'family' | 'sku_in_name' | 'name' | null };

const key = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, '');

export function parsePrice(s: string): number | null {
  const cleaned = s.replace(/\s| /g, '').replace(/(da|dzd|دج)$/i, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

export function parsePriceList(text: string): PriceLine[] {
  const out: PriceLine[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let cells = line.split('\t').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) cells = line.split(/\s{2,}|;/).map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) {
      // "CODE Name words 1234"
      const m = /^(\S+)\s+(.*?)\s+([\d\s.,]+(?:da|dzd|دج)?)$/i.exec(line);
      cells = m ? [m[1]!, m[2]!, m[3]!] : [line];
    }
    const priceCell = cells.length > 1 ? cells[cells.length - 1]! : '';
    const price = parsePrice(priceCell);
    const code = cells[0] ?? '';
    const name = cells.length > 2 ? cells.slice(1, -1).join(' ') : price === null && cells.length === 2 ? cells[1]! : '';
    out.push({ line: i + 1, code, name, price, raw });
  });
  return out;
}

export function matchPriceLine(l: PriceLine, catalog: CatalogProduct[]): PriceMatch {
  const withSku = catalog.filter((p) => p.sku && !/^d[ée]calage_/i.test(p.sku));
  const code = l.code.trim();
  const exact = withSku.filter((p) => p.sku!.toLowerCase() === code.toLowerCase());
  if (exact.length) return { ...l, products: exact, rule: 'sku' };
  const k = key(code);
  if (k) {
    const loose = withSku.filter((p) => key(p.sku!) === k);
    if (loose.length) return { ...l, products: loose, rule: 'sku_loose' };
    const family = withSku.filter((p) => {
      const pk = key(p.sku!);
      return pk.length > k.length && pk.startsWith(k) && /^\d{2}$/.test(pk.slice(k.length));
    });
    if (family.length) return { ...l, products: family, rule: 'family' };
  }
  // A token that is the code without its suffix (VCOMB for VCOMB2) is another product, not this one.
  const tokens = l.name.split(/[\s/()|,]+/).filter((t) => t.length >= 2 && !(k.startsWith(key(t)) && k !== key(t)));
  const inName = withSku.filter((p) => tokens.some((t) => t.toLowerCase() === p.sku!.toLowerCase()));
  if (inName.length) return { ...l, products: inName, rule: 'sku_in_name' };
  const nk = key(l.name.replace(/\(.*?\)/g, ''));
  if (nk) {
    const byName = catalog.filter((p) => key(p.name) === nk && !/^d[ée]calage_/i.test(p.name));
    if (byName.length) return { ...l, products: byName, rule: 'name' };
  }
  return { ...l, products: [], rule: null };
}

export function matchPriceList(text: string, catalog: CatalogProduct[]): PriceMatch[] {
  return parsePriceList(text).map((l) => matchPriceLine(l, catalog));
}
