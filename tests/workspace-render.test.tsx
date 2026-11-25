import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/fr.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), usePathname: () => '/', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/actions/orders', () => ({ updateOrderCustomer: vi.fn(), updateOrderItems: vi.fn(), changeConfirmationStatus: vi.fn(), addOrderNote: vi.fn(), assignOrders: vi.fn(), autoAssignOrders: vi.fn(), matchOrderItem: vi.fn(), resolveReview: vi.fn(), setDeliveryManual: vi.fn(), submitToDelivery: vi.fn() }));

describe('ConfirmationWorkspace', () => {
  it('renders an incomplete imported order with warnings', async () => {
    const { ConfirmationWorkspace } = await import('@/app/(app)/orders/[id]/workspace');
    const html = renderToString(
      <NextIntlClientProvider locale="fr" messages={messages} timeZone="Africa/Algiers">
        <ConfirmationWorkspace orderId="o1" version={1} status="new" isManager={false}
          initial={{ customer_name: 'Client sans nom', phone: '', phone2: '', wilaya_code: 16, commune: '', address: '', delivery_type: 'home', customer_notes: '' }}
          items={[{ id: 'i1', product_id: null, product_name: 'Produit non renseigné', sku: null, quantity: 1, unit_price: 0 }]}
          catalog={[{ id: 'p1', name: 'Tn Gold 41', sku: 'TG41', selling_price: 3500 }]}
          wilayas={[{ code: 16, name: 'Alger' }]}
          communes={[{ wilaya_code: 16, name: 'Bab Ezzouar', has_stop_desk: true }]}
          deliveryFee={500} discount={0} reviewReason="Import incomplet — à compléter : nom, téléphone, produit" />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('Import incomplet');
    expect(html).toContain('Bab Ezzouar');
    expect(html).toContain('Tn Gold 41');
    expect(html).toContain('Ajouter un produit');
    expect(html).toContain('border-warning');
  });
});
