'use client';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAction } from '@/components/app/use-action';
import { createOrder } from '@/lib/actions/orders';
import { formatDZD, type AppLocale } from '@/lib/format';

const schema = z.object({
  customer_name: z.string().trim().min(1, 'required'),
  phone: z.string().trim().regex(/^[+\d\s.-]{9,20}$/, 'invalid_phone'),
  phone2: z.string().trim().optional(),
  wilaya_code: z.coerce.number().int().min(1, 'required').max(58),
  commune: z.string().trim().min(1, 'required'),
  address: z.string().trim().optional(),
  delivery_type: z.enum(['home', 'stopdesk']),
  customer_notes: z.string().optional(),
  delivery_fee: z.coerce.number().min(0),
  discount: z.coerce.number().min(0),
  items: z.array(z.object({ product_id: z.guid('required'), quantity: z.coerce.number().int().min(1), unit_price: z.coerce.number().min(0) })).min(1),
});
type Values = z.input<typeof schema>;

export function NewOrderForm({ products, wilayas }: { products: { id: string; name: string; sku: string | null; selling_price: number }[]; wilayas: { code: number; name: string }[] }) {
  const t = useTranslations();
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const { run, pending } = useAction();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { customer_name: '', phone: '', phone2: '', wilaya_code: 0, commune: '', address: '', delivery_type: 'home', customer_notes: '', delivery_fee: 0, discount: 0, items: [{ product_id: '', quantity: 1, unit_price: 0 }] },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'items' });
  const items = form.watch('items');
  const subtotal = items.reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unit_price || 0), 0);
  const total = subtotal + Number(form.watch('delivery_fee') || 0) - Number(form.watch('discount') || 0);
  const err = (name: string) => {
    const e = name.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], form.formState.errors) as { message?: string } | undefined;
    return e?.message ? <p className="text-xs text-destructive">{t.has(`errors.${e.message}`) ? t(`errors.${e.message}`) : t('errors.invalid_input')}</p> : null;
  };

  const onSubmit = form.handleSubmit((values) =>
    run(() => createOrder(schema.parse(values)), { success: t('orders.created'), refresh: false, onSuccess: (id) => router.push(`/orders/${id}`) }),
  );

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <Card>
        <CardHeader><CardTitle>{t('orders.customer')}</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label>{t('orders.customerName')}</Label><Input {...form.register('customer_name')} />{err('customer_name')}</div>
          <div className="grid gap-1.5"><Label>{t('orders.phone')}</Label><Input dir="ltr" {...form.register('phone')} />{err('phone')}</div>
          <div className="grid gap-1.5"><Label>{t('orders.phone2')}</Label><Input dir="ltr" {...form.register('phone2')} /></div>
          <div className="grid gap-1.5">
            <Label>{t('orders.wilaya')}</Label>
            <Select {...form.register('wilaya_code')}>
              <option value={0}>—</option>
              {wilayas.map((w) => <option key={w.code} value={w.code}>{String(w.code).padStart(2, '0')} — {w.name}</option>)}
            </Select>
            {err('wilaya_code')}
          </div>
          <div className="grid gap-1.5"><Label>{t('orders.commune')}</Label><Input {...form.register('commune')} />{err('commune')}</div>
          <div className="grid gap-1.5">
            <Label>{t('orders.deliveryType')}</Label>
            <Select {...form.register('delivery_type')}><option value="home">{t('orders.home')}</option><option value="stopdesk">{t('orders.stopdesk')}</option></Select>
          </div>
          <div className="grid gap-1.5 sm:col-span-2"><Label>{t('orders.address')}</Label><Textarea rows={2} {...form.register('address')} /></div>
          <div className="grid gap-1.5 sm:col-span-2"><Label>{t('orders.customerNotes')}</Label><Textarea rows={2} {...form.register('customer_notes')} /></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('orders.products')}</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          {fields.map((f, i) => (
            <div key={f.id} className="grid grid-cols-12 items-end gap-2">
              <div className="col-span-12 grid gap-1.5 sm:col-span-6">
                <Label>{t('orders.product')}</Label>
                <Select {...form.register(`items.${i}.product_id`, {
                  onChange: (e) => {
                    const p = products.find((x) => x.id === e.target.value);
                    if (p) form.setValue(`items.${i}.unit_price`, p.selling_price);
                  },
                })}>
                  <option value="">{t('orders.selectProduct')}</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ''}</option>)}
                </Select>
                {err(`items.${i}.product_id`)}
              </div>
              <div className="col-span-4 grid gap-1.5 sm:col-span-2"><Label>{t('orders.quantity')}</Label><Input type="number" min={1} {...form.register(`items.${i}.quantity`)} /></div>
              <div className="col-span-6 grid gap-1.5 sm:col-span-3"><Label>{t('orders.unitPrice')}</Label><Input type="number" min={0} step="0.01" {...form.register(`items.${i}.unit_price`)} /></div>
              <Button type="button" variant="ghost" size="icon" className="col-span-2 sm:col-span-1" onClick={() => remove(i)} disabled={fields.length === 1} aria-label={t('orders.removeItem')}><Trash2 /></Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => append({ product_id: '', quantity: 1, unit_price: 0 })}><Plus />{t('orders.addItem')}</Button>
          <div className="grid gap-3 border-t pt-3 sm:grid-cols-3">
            <div className="grid gap-1.5"><Label>{t('orders.deliveryFee')}</Label><Input type="number" min={0} {...form.register('delivery_fee')} /></div>
            <div className="grid gap-1.5"><Label>{t('orders.discount')}</Label><Input type="number" min={0} {...form.register('discount')} /></div>
            <div className="grid content-end gap-1 text-end">
              <span className="text-xs text-muted-foreground">{t('orders.totalAmount')}</span>
              <span className="tabular text-xl font-semibold">{formatDZD(total, locale)}</span>
            </div>
          </div>
        </CardContent>
      </Card>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()}>{t('common.cancel')}</Button>
        <Button type="submit" disabled={pending}>{t('common.create')}</Button>
      </div>
    </form>
  );
}
