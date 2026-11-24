'use client';
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Pencil, Plus, Trash2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TR } from '@/components/ui/table';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useAction } from '@/components/app/use-action';
import { deleteCategory, deleteExpense, generateRecurringNow, saveCategory, saveExpense, saveRecurring, toggleRecurring } from '@/lib/actions/expenses';
import { formatDZD, formatDate, type AppLocale } from '@/lib/format';
import { todayInAlgiers } from '@/lib/dates';

export type Category = { id: string; name: string; name_ar: string | null; kind: string; profit_treatment: 'deduct' | 'informational'; is_archived: boolean };
const KINDS = ['overhead', 'advertising', 'salary', 'confirmation', 'packaging', 'storage', 'delivery', 'product_purchase', 'returns', 'software', 'other'];
type Opt = { id: string; name?: string; full_name?: string };
type Expense = { id?: string; title: string; category_id: string; amount: number; amount_paid: number; expense_date: string; description: string; payment_method: string; payee: string; reference: string; payment_status: string; order_reference: string; product_id: string; employee_id: string };

export function ExpenseDialog({ expense, categories, products, staff }: { expense?: Expense; categories: Category[]; products: Opt[]; staff: Opt[] }) {
  const t = useTranslations();
  const locale = useLocale();
  const { run, pending } = useAction();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(expense?.payment_status ?? 'paid');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{expense ? <Button size="icon" variant="ghost" aria-label={t('common.edit')}><Pencil /></Button> : <Button><Plus />{t('expenses.new')}</Button>}</DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{expense ? expense.title : t('expenses.new')}</DialogTitle></DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            if (expense?.id) fd.set('id', expense.id);
            run(() => saveExpense(fd), { success: t('common.saved'), onSuccess: () => setOpen(false) });
          }}
        >
          <div className="grid gap-1.5 sm:col-span-2"><Label>{t('expenses.titleField')}</Label><Input name="title" required defaultValue={expense?.title} /></div>
          <div className="grid gap-1.5"><Label>{t('common.category')}</Label>
            <Select name="category_id" required defaultValue={expense?.category_id}>{categories.map((c) => <option key={c.id} value={c.id}>{locale === 'ar' && c.name_ar ? c.name_ar : c.name}</option>)}</Select>
          </div>
          <div className="grid gap-1.5"><Label>{t('common.date')}</Label><Input type="date" name="expense_date" required defaultValue={expense?.expense_date ?? todayInAlgiers()} /></div>
          <div className="grid gap-1.5"><Label>{t('expenses.amountDzd')}</Label><Input type="number" min={0} step="0.01" name="amount" required defaultValue={expense?.amount} /></div>
          <div className="grid gap-1.5"><Label>{t('expenses.paymentStatus')}</Label>
            <Select name="payment_status" value={status} onChange={(e) => setStatus(e.target.value)}>{(['paid', 'unpaid', 'partial'] as const).map((s) => <option key={s} value={s}>{t(`expenses.${s}`)}</option>)}</Select>
          </div>
          {status === 'partial' ? <div className="grid gap-1.5"><Label>{t('expenses.amountPaid')}</Label><Input type="number" min={0} name="amount_paid" defaultValue={expense?.amount_paid} /></div> : null}
          <div className="grid gap-1.5"><Label>{t('expenses.paymentMethod')}</Label><Input name="payment_method" defaultValue={expense?.payment_method} /></div>
          <div className="grid gap-1.5"><Label>{t('expenses.payee')}</Label><Input name="payee" defaultValue={expense?.payee} /></div>
          <div className="grid gap-1.5"><Label>{t('expenses.reference')}</Label><Input name="reference" defaultValue={expense?.reference} /></div>
          <div className="grid gap-1.5"><Label>{t('expenses.relatedOrder')}</Label><Input name="order_reference" inputMode="numeric" defaultValue={expense?.order_reference} /></div>
          <div className="grid gap-1.5"><Label>{t('expenses.relatedProduct')}</Label><Select name="product_id" defaultValue={expense?.product_id}><option value="">—</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
          <div className="grid gap-1.5"><Label>{t('expenses.relatedEmployee')}</Label><Select name="employee_id" defaultValue={expense?.employee_id}><option value="">—</option>{staff.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</Select></div>
          <div className="grid gap-1.5"><Label>{t('expenses.attachment')}</Label><Input type="file" name="attachment" accept=".pdf,image/png,image/jpeg,image/webp" /></div>
          <div className="grid gap-1.5 sm:col-span-2"><Label>{t('common.description')}</Label><Textarea name="description" rows={2} defaultValue={expense?.description} /></div>
          <DialogFooter className="sm:col-span-2"><Button type="submit" disabled={pending}>{t('common.save')}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ExpenseDelete({ id }: { id: string }) {
  const t = useTranslations('common');
  const { run, pending } = useAction();
  return <Button size="icon" variant="ghost" disabled={pending} aria-label={t('delete')} onClick={() => { if (confirm(t('confirm'))) run(() => deleteExpense(id)); }}><Trash2 /></Button>;
}

export function CategoryManager({ categories }: { categories: Category[] }) {
  const t = useTranslations();
  const locale = useLocale();
  const { run, pending } = useAction();
  const empty = { name: '', name_ar: '', kind: 'overhead', profit_treatment: 'deduct' as const };
  const [f, setF] = useState<{ id?: string; name: string; name_ar: string; kind: string; profit_treatment: 'deduct' | 'informational' }>(empty);
  return (
    <Card>
      <CardHeader><CardTitle>{t('expenses.categories')}</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
          <Input placeholder={t('common.name')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Input placeholder="الاسم بالعربية" dir="rtl" value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} />
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label={t('expenses.kind')}>{KINDS.map((k) => <option key={k} value={k}>{t(`expenses.kind_${k}`)}</option>)}</Select>
          <Select value={f.profit_treatment} onChange={(e) => setF({ ...f, profit_treatment: e.target.value as 'deduct' })} aria-label={t('expenses.treatment')}>
            <option value="deduct">{t('expenses.deduct')}</option><option value="informational">{t('expenses.informational')}</option>
          </Select>
          <div className="flex gap-2 sm:col-span-2">
            <Button size="sm" disabled={!f.name.trim() || pending} onClick={() => run(() => saveCategory({ ...f, kind: f.kind as 'overhead' }), { success: t('common.saved'), onSuccess: () => setF(empty) })}>{f.id ? t('common.save') : t('expenses.newCategory')}</Button>
            {f.id ? <Button size="sm" variant="ghost" onClick={() => setF(empty)}>{t('common.cancel')}</Button> : null}
          </div>
        </div>
        <Table>
          <TBody>
            {categories.map((c) => (
              <TR key={c.id} className={c.is_archived ? 'opacity-50' : ''}>
                <TD>{locale === 'ar' && c.name_ar ? c.name_ar : c.name}<div className="text-xs text-muted-foreground">{t(`expenses.kind_${c.kind}`)} · {t(`expenses.${c.profit_treatment}`)}</div></TD>
                <TD className="text-end">
                  <Button size="sm" variant="ghost" onClick={() => setF({ id: c.id, name: c.name, name_ar: c.name_ar ?? '', kind: c.kind, profit_treatment: c.profit_treatment })}>{t('common.edit')}</Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => saveCategory({ id: c.id, name: c.name, name_ar: c.name_ar ?? '', kind: c.kind as 'overhead', profit_treatment: c.profit_treatment, is_archived: !c.is_archived }))}>{c.is_archived ? t('common.unarchive') : t('common.archive')}</Button>
                  <Button size="icon" variant="ghost" disabled={pending} aria-label={t('common.delete')} onClick={() => run(() => deleteCategory(c.id))}><Trash2 /></Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

type Rec = { id: string; title: string; amount: number; frequency: string; interval_days: number | null; next_run_date: string; end_date: string | null; is_active: boolean; category: string };

export function RecurringManager({ categories, staff, items }: { categories: Category[]; staff: Opt[]; items: Rec[] }) {
  const t = useTranslations();
  const locale = useLocale() as AppLocale;
  const { run, pending } = useAction();
  const [freq, setFreq] = useState('monthly');
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{t('expenses.recurring')}</CardTitle>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => generateRecurringNow(), { success: (n) => t('expenses.generated', { count: Number(n) }) })}><RefreshCw />{t('expenses.generateNow')}</Button>
      </CardHeader>
      <CardContent className="grid gap-3">
        <form className="grid gap-2 rounded-md border p-3 sm:grid-cols-2" onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const d = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
          run(() => saveRecurring({ ...d, frequency: d.frequency as 'monthly', default_status: d.default_status as 'paid', category_id: d.category_id ?? '', title: d.title ?? '', amount: d.amount ?? '', start_date: d.start_date ?? '' }), { success: t('common.saved'), onSuccess: () => form.reset() });
        }}>
          <Input name="title" required placeholder={t('expenses.titleField')} className="sm:col-span-2" />
          <Select name="category_id" required>{categories.map((c) => <option key={c.id} value={c.id}>{locale === 'ar' && c.name_ar ? c.name_ar : c.name}</option>)}</Select>
          <Input name="amount" type="number" min={0} required placeholder={t('expenses.amountDzd')} />
          <Select name="frequency" value={freq} onChange={(e) => setFreq(e.target.value)}>{(['daily', 'weekly', 'monthly', 'yearly', 'custom'] as const).map((f) => <option key={f} value={f}>{t(`expenses.${f}`)}</option>)}</Select>
          {freq === 'custom' ? <Input name="interval_days" type="number" min={1} placeholder={t('expenses.intervalDays')} /> : <span />}
          <div className="grid gap-1"><Label className="text-xs">{t('expenses.startDate')}</Label><Input name="start_date" type="date" required defaultValue={todayInAlgiers()} /></div>
          <div className="grid gap-1"><Label className="text-xs">{t('expenses.endDate')}</Label><Input name="end_date" type="date" /></div>
          <Select name="default_status" defaultValue="unpaid">{(['paid', 'unpaid', 'partial'] as const).map((s) => <option key={s} value={s}>{t(`expenses.${s}`)}</option>)}</Select>
          <Select name="employee_id" defaultValue=""><option value="">{t('expenses.relatedEmployee')}</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</Select>
          <Button type="submit" size="sm" disabled={pending} className="sm:col-span-2"><Plus />{t('expenses.newRecurring')}</Button>
        </form>
        <Table>
          <TBody>
            {items.map((r) => (
              <TR key={r.id} className={r.is_active ? '' : 'opacity-50'}>
                <TD><div className="font-medium">{r.title}</div><div className="text-xs text-muted-foreground">{r.category} · {t(`expenses.${r.frequency as 'monthly'}`)}{r.interval_days ? ` (${r.interval_days})` : ''}</div></TD>
                <TD className="tabular">{formatDZD(r.amount, locale)}</TD>
                <TD className="text-xs">{t('expenses.nextRun')}: {formatDate(r.next_run_date, locale)}</TD>
                <TD><label className="flex items-center gap-1 text-xs"><Checkbox checked={r.is_active} onChange={(e) => run(() => toggleRecurring(r.id, e.target.checked))} />{t('common.active')}</label></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}
