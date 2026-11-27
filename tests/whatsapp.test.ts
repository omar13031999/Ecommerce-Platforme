import { describe, expect, it } from 'vitest';
import { whatsappNumber, whatsappTemplates } from '@/components/app/whatsapp-button';

describe('WhatsApp helpers', () => {
  it('turns Algerian numbers into wa.me international format', () => {
    expect(whatsappNumber('0555 12 34 56')).toBe('213555123456');
    expect(whatsappNumber('+213 661 23 45 67')).toBe('213661234567');
    expect(whatsappNumber('00213770000000')).toBe('213770000000');
    expect(whatsappNumber('021 23 45 67')).toBe('21321234567');
    expect(whatsappNumber('')).toBeNull();
    expect(whatsappNumber('12345')).toBeNull();
  });
  it('fills templates with order data', () => {
    const [confirm] = whatsappTemplates({ name: 'Karim', reference: 10001, total: '5 200 DA', products: 'Tn Gold 41 ×1' });
    expect(confirm!.text).toContain('Karim');
    expect(confirm!.text).toContain('10001');
    expect(confirm!.text).toContain('5 200 DA');
  });
});
