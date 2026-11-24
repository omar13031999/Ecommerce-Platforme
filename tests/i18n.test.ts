import { describe, expect, it } from 'vitest';
import fr from '../messages/fr.json';
import ar from '../messages/ar.json';

function keys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
}
function placeholders(s: string) {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}
function get(obj: Record<string, unknown>, path: string): string {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj) as string;
}

describe('i18n catalogues', () => {
  it('French and Arabic have exactly the same keys', () => {
    expect(keys(ar).sort()).toEqual(keys(fr).sort());
  });
  it('placeholders match in both languages', () => {
    for (const k of keys(fr)) expect([k, placeholders(get(ar, k))]).toEqual([k, placeholders(get(fr, k))]);
  });
  it('no empty translation', () => {
    for (const k of keys(ar)) expect(get(ar, k).trim().length, k).toBeGreaterThan(0);
  });
});
