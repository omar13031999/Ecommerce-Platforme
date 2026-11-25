import { describe, expect, it } from 'vitest';
import { matchPriceList, parsePrice } from '@/lib/domain/price-import';

const catalog = [
  { id: '1', sku: 'TMD39', name: 'tn madrid 39' }, { id: '2', sku: 'TMD40', name: 'tn madrid 40' },
  { id: '3', sku: 'TG41', name: 'Tn Gold 41' }, { id: '4', sku: 'Décalage_TG41', name: 'Décalage_Tn Gold 41' },
  { id: '5', sku: 'VKM', name: 'حقيبة الطوارئ متعددة الاستخدامات' }, { id: '6', sku: 'Compresseur Toyota', name: 'Compresseur Toyota' },
  { id: '7', sku: 'VCOMB', name: 'الة نزع القمل والصيبان' }, { id: '8', sku: 'TWC', name: 'Talkies Walkie Camera' },
  { id: '9', sku: 'COUV.GRIS', name: 'GRIS غطاء مقعد السيارة' },
];
const run = (text: string) => matchPriceList(text, catalog).map((m) => [m.code, m.price, m.rule, m.products.map((p) => p.sku)]);

describe('price list import', () => {
  it('matches the different ways a code can refer to products', () => {
    expect(run([
      'TG41\tTn Gold 41\t3500',
      'TMD\tTn Madrid (كل المقاسات)\t4700',
      "KIT_URGENCE\tKit d'urgence / VKM\t7500",
      'COMPRESSEUR_TOYOTA\tCompresseur Toyota\t2000',
      'TALKIE_WALKIE\tTalkies Walkie camera\t3200',
      'COUV.GRIS\tغطاء رمادي\t1100',
      'VCOMB2\tVcomb\t1200',
      'KACHAF\tكشاف ضوئي للأطفال\t2 100 DA',
    ].join('\n'))).toEqual([
      ['TG41', 3500, 'sku', ['TG41']],
      ['TMD', 4700, 'family', ['TMD39', 'TMD40']],
      ['KIT_URGENCE', 7500, 'sku_in_name', ['VKM']],
      ['COMPRESSEUR_TOYOTA', 2000, 'sku_loose', ['Compresseur Toyota']],
      ['TALKIE_WALKIE', 3200, 'name', ['TWC']],
      ['COUV.GRIS', 1100, 'sku', ['COUV.GRIS']],
      ['VCOMB2', 1200, null, []], // a "2" version is another product, never VCOMB
      ['KACHAF', 2100, null, []],
    ]);
  });

  it('never touches stock adjustment products (Décalage_*)', () => {
    expect(run('TG\tTn Gold\t3500')[0]![3]).not.toContain('Décalage_TG41');
  });

  it('parses prices', () => {
    expect(parsePrice('3 900')).toBe(3900);
    expect(parsePrice('3900 DA')).toBe(3900);
    expect(parsePrice('abc')).toBeNull();
  });
});
