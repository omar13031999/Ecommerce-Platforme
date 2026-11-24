import { getLocale, getTranslations } from 'next-intl/server';
import { Paperclip } from 'lucide-react';
import { requirePage } from '@/lib/auth/session';
import { resolveRange } from '@/lib/dates';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { DateRangeFilter } from '@/components/app/date-range-filter';
import { StatCard } from '@/components/app/stat-card';
import { TrendChart } from '@/components/app/charts';
import { chartColor } from '@/lib/chart-colors';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/input';
import { formatDZD, formatDate, type AppLocale } from '@/lib/format';
import { CategoryManager, ExpenseDialog, ExpenseDelete, RecurringManager, type Category } from './expenses-client';

type SP = { range?: string; from?: string; to?: string; category?: string; status?: string; product?: string; employee?: string };

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const session = await requirePage('finance.view', 'expenses.manage');
  const sp = await searchParams;
  const range = resolveRange(sp, 'this_month');
  const t = await getTranslations();
  const locale = (await getLocale()) as AppLocale;
  const supabase = await createClient();
  const canManage = session.can('expenses.manage');

  let q = supabase.from('expenses')
    .select('id, title, category_id, amount, amount_paid, expense_date, description, payment_method, payee, reference, attachment_path, payment_status, order_id, product_id, employee_id, recurring_id, orders(reference)')
    .gte('expense_date', range.from).lte('expense_date', range.to).order('expense_date', { ascending: false }).limit(500);
  if (sp.category) q = q.eq('category_id', sp.category);
  if (sp.status) q = q.eq('payment_status', sp.status);
  if (sp.product) q = q.eq('product_id', sp.product);
  if (sp.employee) q = q.eq('employee_id', sp.employee);

  const [{ data: expenses }, { data: categories }, { data: products }, { data: staff }, { data: recurring }] = await Promise.all([
    q,
    supabase.from('expense_categories').select('id, name, name_ar, kind, profit_treatment, is_archived').order('sort_order').order('name'),
    supabase.from('products').select('id, name').order('name'),
    supabase.from('staff_directory').select('id, full_name').order('full_name'),
    supabase.from('recurring_expenses').select('id, title, amount, frequency, interval_days, next_run_date, end_date, is_active, category_id').order('created_at', { ascending: false }),
  ]);
  const cats = (categories ?? []) as Category[];
  const catName = (id: string) => {
    const c = cats.find((x) => x.id === id);
    return c ? (locale === 'ar' && c.name_ar ? c.name_ar : c.name) : '—';
  };
  const list = expenses ?? [];
  const total = list.reduce((s, e) => s + Number(e.amount), 0);
  const unpaid = list.reduce((s, e) => s + Number(e.amount) - Number(e.amount_paid), 0);
  const byCat = new Map<string, number>();
  for (const e of list) byCat.set(e.category_id, (byCat.get(e.category_id) ?? 0) + Number(e.amount));
  const byDay = new Map<string, number>();
  for (const e of list) byDay.set(e.expense_date, (byDay.get(e.expense_date) ?? 0) + Number(e.amount));
  const trend = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, amount]) => ({ day, amount }));
  const productName = Object.fromEntries((products ?? []).map((p) => [p.id, p.name]));
  const staffName = Object.fromEntries((staff ?? []).map((p) => [p.id, p.full_name]));
  const statusTone = { paid: 'bg-green-50 text-green-700 ring-green-200', unpaid: 'bg-red-50 text-red-700 ring-red-200', partial: 'bg-amber-50 text-amber-800 ring-amber-200' } as const;

  return (
    <div className="grid gap-5">
      <PageHeader
        title={t('expenses.title')}
        actions={<>
          <DateRangeFilter range={range} />
          {canManage ? <ExpenseDialog categories={cats.filter((c) => !c.is_archived)} products={products ?? []} staff={staff ?? []} /> : null}
        </>}
      />
      <form className="flex flex-wrap gap-2">
        {sp.range ? <input type="hidden" name="range" value={sp.range} /> : null}
        <Select name="category" defaultValue={sp.category ?? ''} className="w-48"><option value="">{t('common.category')}: {t('common.all')}</option>{cats.map((c) => <option key={c.id} value={c.id}>{catName(c.id)}</option>)}</Select>
        <Select name="status" defaultValue={sp.status ?? ''} className="w-44"><option value="">{t('expenses.paymentStatus')}: {t('common.all')}</option>{(['paid', 'unpaid', 'partial'] as const).map((s) => <option key={s} value={s}>{t(`expenses.${s}`)}</option>)}</Select>
        <Select name="product" defaultValue={sp.product ?? ''} className="w-44"><option value="">{t('expenses.relatedProduct')}</option>{(products ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
        <Select name="employee" defaultValue={sp.employee ?? ''} className="w-44"><option value="">{t('expenses.relatedEmployee')}</option>{(staff ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</Select>
        <button className="h-9 rounded-md border bg-card px-3 text-sm hover:bg-accent">{t('common.apply')}</button>
        <a className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm hover:bg-accent" href={`/api/exports/expenses?format=xlsx&from=${range.from}&to=${range.to}`}>{t('common.exportXlsx')}</a>
      </form>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label={t('expenses.totalPeriod')} value={formatDZD(total, locale)} />
        <StatCard label={t('expenses.unpaid')} value={formatDZD(unpaid, locale)} tone={unpaid > 0 ? 'warning' : 'default'} />
        <StatCard label={t('common.total')} value={list.length} />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>{t('expenses.trend')}</CardTitle></CardHeader>
          <CardContent><TrendChart kind="bar" data={trend} series={[{ key: 'amount', label: t('common.amount'), color: chartColor(3) }]} height={220} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t('expenses.byCategory')}</CardTitle></CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {[...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([id, v]) => (
              <div key={id} className="flex justify-between gap-2">
                <span>{catName(id)}{cats.find((c) => c.id === id)?.profit_treatment === 'informational' ? <span className="text-xs text-muted-foreground"> ({t('expenses.informational')})</span> : null}</span>
                <span className="tabular">{formatDZD(v, locale)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <Card className="overflow-hidden">
        <Table>
          <THead><TR>
            <TH>{t('common.date')}</TH><TH>{t('expenses.titleField')}</TH><TH>{t('common.category')}</TH><TH>{t('common.amount')}</TH>
            <TH>{t('expenses.paymentStatus')}</TH><TH>{t('expenses.payee')}</TH><TH>{t('expenses.reference')}</TH><TH /><TH />
          </TR></THead>
          <TBody>
            {list.map((e) => (
              <TR key={e.id}>
                <TD className="whitespace-nowrap text-xs">{formatDate(e.expense_date, locale)}</TD>
                <TD>
                  <div className="font-medium">{e.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {[e.product_id ? productName[e.product_id] : null, e.employee_id ? staffName[e.employee_id] : null,
                      e.order_id ? `#${(e.orders as unknown as { reference: number } | null)?.reference}` : null, e.recurring_id ? '↻' : null].filter(Boolean).join(' · ')}
                  </div>
                </TD>
                <TD className="text-xs">{catName(e.category_id)}</TD>
                <TD className="tabular whitespace-nowrap">{formatDZD(e.amount, locale)}</TD>
                <TD><Badge className={statusTone[e.payment_status as keyof typeof statusTone]}>{t(`expenses.${e.payment_status as 'paid'}`)}</Badge></TD>
                <TD className="text-xs">{e.payee ?? '—'}</TD>
                <TD className="text-xs">{e.reference ?? '—'}</TD>
                <TD>{e.attachment_path ? <a href={`/api/expenses/${e.id}/attachment`} target="_blank" rel="noopener noreferrer" aria-label={t('expenses.download')}><Paperclip className="size-4 text-primary" /></a> : null}</TD>
                <TD className="flex gap-1">{canManage ? <><ExpenseDialog categories={cats.filter((c) => !c.is_archived || c.id === e.category_id)} products={products ?? []} staff={staff ?? []} expense={{
                  id: e.id, title: e.title, category_id: e.category_id, amount: Number(e.amount), amount_paid: Number(e.amount_paid), expense_date: e.expense_date,
                  description: e.description ?? '', payment_method: e.payment_method ?? '', payee: e.payee ?? '', reference: e.reference ?? '', payment_status: e.payment_status,
                  order_reference: e.order_id ? String((e.orders as unknown as { reference: number } | null)?.reference ?? '') : '', product_id: e.product_id ?? '', employee_id: e.employee_id ?? '',
                }} /><ExpenseDelete id={e.id} /></> : null}</TD>
              </TR>
            ))}
            {!list.length ? <TR><TD colSpan={9} className="text-center text-muted-foreground">{t('common.noResults')}</TD></TR> : null}
          </TBody>
        </Table>
      </Card>
      {canManage ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <CategoryManager categories={cats} />
          <RecurringManager categories={cats.filter((c) => !c.is_archived)} staff={staff ?? []} items={(recurring ?? []).map((r) => ({ ...r, amount: Number(r.amount), category: catName(r.category_id) }))} />
        </div>
      ) : null}
    </div>
  );
}
