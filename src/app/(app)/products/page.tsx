import { getLocale, getTranslations } from 'next-intl/server';
import { requirePage } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { Card } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatDZD, formatPercent, type AppLocale } from '@/lib/format';
import { ProductDialog, ArchiveButton, RecalculateDialog } from './products-client';

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const session = await requirePage('products.manage', 'finance.view');
  const { archived } = await searchParams;
  const t = await getTranslations();
  const locale = (await getLocale()) as AppLocale;
  const supabase = await createClient();
  const canCost = session.can('finance.view');
  const [{ data: products }, costsRes] = await Promise.all([
    supabase.from('products').select('id, sku, name, description, selling_price, is_archived').eq('is_archived', archived === '1').order('name'),
    canCost ? supabase.from('product_costs').select('product_id, purchase_cost, packaging_cost, storage_cost') : Promise.resolve({ data: [] as { product_id: string; purchase_cost: number | null; packaging_cost: number | null; storage_cost: number | null }[] }),
  ]);
  const costs = Object.fromEntries((costsRes.data ?? []).map((c) => [c.product_id, c]));
  return (
    <div>
      <PageHeader
        title={t('products.title')}
        actions={
          <>
            <a href={archived === '1' ? '/products' : '/products?archived=1'} className="text-sm text-primary hover:underline">{archived === '1' ? t('common.back') : t('products.showArchived')}</a>
            {session.can('products.manage') ? <ProductDialog canCost={session.can('finance.manage')} /> : null}
          </>
        }
      />
      <Card className="overflow-hidden">
        <Table>
          <THead><TR>
            <TH>{t('common.name')}</TH><TH>{t('products.sku')}</TH><TH>{t('products.sellingPrice')}</TH>
            {canCost ? <><TH>{t('products.purchaseCost')}</TH><TH>{t('products.margin')}</TH></> : null}
            <TH />
          </TR></THead>
          <TBody>
            {(products ?? []).map((p) => {
              const c = costs[p.id];
              const margin = c?.purchase_cost != null && Number(p.selling_price) > 0 ? (Number(p.selling_price) - Number(c.purchase_cost)) / Number(p.selling_price) : null;
              return (
                <TR key={p.id}>
                  <TD><div className="font-medium">{p.name}</div>{p.description ? <div className="line-clamp-1 text-xs text-muted-foreground">{p.description}</div> : null}</TD>
                  <TD className="font-mono text-xs">{p.sku ?? '—'}</TD>
                  <TD className="tabular">{formatDZD(p.selling_price, locale)}</TD>
                  {canCost ? (
                    <>
                      <TD className="tabular">{c?.purchase_cost != null ? formatDZD(c.purchase_cost, locale) : <Badge className="bg-destructive/10 text-destructive ring-destructive/30">{t('products.missingCost')}</Badge>}</TD>
                      <TD className="tabular">{formatPercent(margin, locale)}</TD>
                    </>
                  ) : null}
                  <TD className="flex justify-end gap-1">
                    <ProductDialog canCost={session.can('finance.manage')} canEdit={session.can('products.manage')} product={{
                      id: p.id, name: p.name, sku: p.sku ?? '', description: p.description ?? '', selling_price: Number(p.selling_price),
                      purchase_cost: c?.purchase_cost ?? null, packaging_cost: c?.packaging_cost ?? null, storage_cost: c?.storage_cost ?? null,
                    }} />
                    {session.can('finance.manage') ? <RecalculateDialog productId={p.id} /> : null}
                    {session.can('products.manage') ? <ArchiveButton id={p.id} archived={p.is_archived} /> : null}
                  </TD>
                </TR>
              );
            })}
            {!products?.length ? <TR><TD colSpan={6} className="text-center text-muted-foreground">{t('common.noResults')}</TD></TR> : null}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
