import { getTranslations } from 'next-intl/server';
import { requirePage } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { MatchRow, AliasDelete } from './matching-client';

export default async function MatchingPage() {
  const session = await requirePage('products.manage', 'orders.manage');
  const t = await getTranslations('products');
  const supabase = await createClient();
  const [{ data: items }, { data: products }, aliases] = await Promise.all([
    supabase.from('order_items').select('id, product_name, sku').is('product_id', null).limit(2000),
    supabase.from('products').select('id, name, sku').eq('is_archived', false).order('name'),
    session.can('products.manage') ? supabase.from('product_aliases').select('id, alias, product_id, products(name)').order('created_at', { ascending: false }).limit(200) : Promise.resolve({ data: [] }),
  ]);
  const groups = new Map<string, { label: string; sku: string | null; itemId: string; count: number }>();
  for (const i of items ?? []) {
    const key = `${(i.sku ?? '').toLowerCase()}|${i.product_name.toLowerCase().trim()}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { label: i.product_name, sku: i.sku, itemId: i.id, count: 1 });
  }
  const list = [...groups.values()].sort((a, b) => b.count - a.count);
  return (
    <div className="grid gap-5">
      <PageHeader title={t('matchingTitle')} description={t('matchingHelp')} />
      <Card className="overflow-hidden">
        <Table>
          <THead><TR><TH>{t('importedLabel')}</TH><TH>{t('sku')}</TH><TH>{t('occurrences')}</TH><TH>{t('matchTo')}</TH></TR></THead>
          <TBody>
            {list.map((g) => (
              <TR key={g.itemId}>
                <TD className="font-medium">{g.label}</TD>
                <TD className="font-mono text-xs">{g.sku ?? '—'}</TD>
                <TD className="tabular">{g.count}</TD>
                <TD><MatchRow itemId={g.itemId} products={products ?? []} /></TD>
              </TR>
            ))}
            {!list.length ? <TR><TD colSpan={4} className="text-center text-muted-foreground">{t('noUnmatched')}</TD></TR> : null}
          </TBody>
        </Table>
      </Card>
      {aliases.data?.length ? (
        <Card>
          <CardHeader><CardTitle>{t('aliases')}</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TBody>
                {aliases.data.map((a) => (
                  <TR key={a.id}>
                    <TD>{a.alias}</TD>
                    <TD>→ {(a.products as unknown as { name: string } | null)?.name}</TD>
                    <TD className="text-end"><AliasDelete id={a.id} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
