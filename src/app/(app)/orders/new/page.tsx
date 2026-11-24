import { getLocale, getTranslations } from 'next-intl/server';
import { requirePage } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { NewOrderForm } from './new-order-form';

export default async function NewOrderPage() {
  await requirePage('orders.create');
  const t = await getTranslations('orders');
  const locale = await getLocale();
  const supabase = await createClient();
  const [{ data: products }, { data: wilayas }] = await Promise.all([
    supabase.from('products').select('id, name, sku, selling_price').eq('is_archived', false).order('name'),
    supabase.from('wilayas').select('code, name_fr, name_ar').order('code'),
  ]);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t('new')} />
      <NewOrderForm
        products={(products ?? []).map((p) => ({ ...p, selling_price: Number(p.selling_price) }))}
        wilayas={(wilayas ?? []).map((w) => ({ code: w.code, name: locale === 'ar' ? w.name_ar : w.name_fr }))}
      />
    </div>
  );
}
