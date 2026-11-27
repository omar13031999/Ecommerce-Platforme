'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Home, MapPin, Package, Phone, Plus, Save, Store, Trash2, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CommuneSelect, type CommuneOption } from '@/components/app/commune-select';
import { cn } from '@/lib/utils';
import { formatDZD, type AppLocale } from '@/lib/format';
import { updateOrderCustomer, updateOrderItems } from '@/lib/actions/orders';
import type { ConfirmationStatus } from '@/lib/domain/statuses';
import { StatusActions } from './order-actions';
import { WhatsAppButton } from '@/components/app/whatsapp-button';

type Customer = {
  customer_name: string; phone: string; phone2: string; wilaya_code: number | null; commune: string; address: string;
  delivery_type: 'home' | 'stopdesk'; customer_notes: string;
};
type Line = { key: string; id?: string; product_id: string | null; product_name: string; sku: string | null; quantity: number; unit_price: number };
type CatalogItem = { id: string; name: string; sku: string | null; selling_price: number };

const PLACEHOLDER_NAME = 'Client sans nom';
const PLACEHOLDER_PRODUCT = 'Produit non renseigné';

/**
 * Everything a confirmer needs on one screen: customer, delivery address,
 * products and the call outcome — edited in place, saved with one button.
 */
export function ConfirmationWorkspace({
  orderId, reference, version, status, isManager, initial, items, catalog, wilayas, communes, deliveryFee, discount, reviewReason,
}: {
  orderId: string; reference: number; version: number; status: ConfirmationStatus; isManager: boolean;
  initial: Customer; items: Omit<Line, 'key'>[]; catalog: CatalogItem[];
  wilayas: { code: number; name: string }[]; communes: CommuneOption[];
  deliveryFee: number; discount: number; reviewReason: string | null;
}) {
  const t = useTranslations();
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const [c, setC] = useState<Customer>({ ...initial, customer_name: initial.customer_name === PLACEHOLDER_NAME ? '' : initial.customer_name });
  const [lines, setLines] = useState<Line[]>(() => items.map((i, n) => ({ ...i, key: i.id ?? `n${n}` })));
  const [saving, setSaving] = useState(false);
  const [currentVersion, setCurrentVersion] = useState(version);

  const initialLines = useMemo(() => JSON.stringify(items.map((i) => [i.id, i.product_id, i.product_name, i.quantity, i.unit_price])), [items]);
  const customerDirty = JSON.stringify(c) !== JSON.stringify({ ...initial, customer_name: initial.customer_name === PLACEHOLDER_NAME ? '' : initial.customer_name });
  const linesDirty = JSON.stringify(lines.map((i) => [i.id, i.product_id, i.product_name, i.quantity, i.unit_price])) !== initialLines;
  const dirty = customerDirty || linesDirty;

  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  const total = subtotal + deliveryFee - discount;
  const set = <K extends keyof Customer>(k: K, v: Customer[K]) => setC((p) => ({ ...p, [k]: v }));
  const missing = {
    customer_name: !c.customer_name.trim(),
    phone: c.phone.replace(/\D/g, '').length < 9,
    wilaya_code: !c.wilaya_code,
    commune: !c.commune.trim(),
    address: c.delivery_type === 'home' && !c.address.trim(),
  };
  const warn = (k: keyof typeof missing) => (missing[k] ? 'border-warning ring-1 ring-warning/40' : '');

  /** Saves customer + products; returns the new version (or null on error). */
  async function save(): Promise<number | null> {
    if (!dirty) return currentVersion;
    setSaving(true);
    try {
      let v = currentVersion;
      if (customerDirty) {
        const r = await updateOrderCustomer({ orderId, version: v, patch: { ...c, wilaya_code: c.wilaya_code ?? null } });
        if (!r.ok) { toast.error(t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : t('errors.unknown')); return null; }
        v = r.data ?? v;
      }
      if (linesDirty) {
        if (lines.some((l) => !l.product_id && !l.product_name.trim())) { toast.error(t('errors.invalid_items')); return null; }
        const r = await updateOrderItems({
          orderId, version: v,
          items: lines.map((l) => ({ id: l.id, product_id: l.product_id, product_name: l.product_name, quantity: l.quantity, unit_price: l.unit_price })),
        });
        if (!r.ok) { toast.error(t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : t('errors.unknown')); return null; }
        v = r.data ?? v;
      }
      setCurrentVersion(v);
      toast.success(t('common.saved'));
      router.refresh();
      return v;
    } finally {
      setSaving(false);
    }
  }

  const pickProduct = (key: string, productId: string) => {
    const p = catalog.find((x) => x.id === productId);
    setLines((ls) => ls.map((l) => (l.key === key ? (p
      ? { ...l, product_id: p.id, product_name: p.name, sku: p.sku, unit_price: l.unit_price > 0 && l.product_id ? l.unit_price : Number(p.selling_price) || l.unit_price }
      : { ...l, product_id: null }) : l)));
  };

  return (
    <div className="grid gap-4">
      {reviewReason ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />{reviewReason}
        </div>
      ) : null}

      {/* 1. Client */}
      <section className="grid gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground"><User className="size-4" />{t('orders.customer')}</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5"><Label>{t('orders.customerName')}</Label>
            <Input className={warn('customer_name')} value={c.customer_name} placeholder={PLACEHOLDER_NAME} onChange={(e) => set('customer_name', e.target.value)} /></div>
          <div className="grid gap-1.5"><Label>{t('orders.phone')}</Label>
            <div className="flex gap-1">
              <Input dir="ltr" className={cn('tabular', warn('phone'))} value={c.phone} onChange={(e) => set('phone', e.target.value)} />
              {c.phone ? <Button asChild size="icon" variant="success" className="shrink-0"><a href={`tel:${c.phone.replace(/\s/g, '')}`} aria-label={t('orders.call')}><Phone /></a></Button> : null}
              <WhatsAppButton phone={c.phone} ctx={{ name: c.customer_name, reference, total: formatDZD(total, locale), products: lines.map((l) => `${l.product_name} ×${l.quantity}`).join('، ') }} />
            </div></div>
          <div className="grid gap-1.5"><Label>{t('orders.phone2')}</Label>
            <div className="flex gap-1">
              <Input dir="ltr" className="tabular" value={c.phone2} onChange={(e) => set('phone2', e.target.value)} />
              {c.phone2 ? <Button asChild size="icon" variant="outline" className="shrink-0"><a href={`tel:${c.phone2.replace(/\s/g, '')}`} aria-label={t('orders.call')}><Phone /></a></Button> : null}
            </div></div>
        </div>
      </section>

      {/* 2. Livraison */}
      <section className="grid gap-3 border-t pt-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground"><MapPin className="size-4" />{t('orders.deliveryAddress')}</h3>
        <div className="flex gap-2">
          {(['home', 'stopdesk'] as const).map((d) => (
            <Button key={d} type="button" size="sm" variant={c.delivery_type === d ? 'default' : 'outline'} onClick={() => set('delivery_type', d)}>
              {d === 'home' ? <Home /> : <Store />}{t(`orders.${d}`)}
            </Button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label>{t('orders.wilaya')}</Label>
            <Select className={warn('wilaya_code')} value={c.wilaya_code ?? ''} onChange={(e) => setC((p) => ({ ...p, wilaya_code: e.target.value ? Number(e.target.value) : null, commune: '' }))}>
              <option value="">—</option>
              {wilayas.map((w) => <option key={w.code} value={w.code}>{String(w.code).padStart(2, '0')} — {w.name}</option>)}
            </Select></div>
          <div className="grid gap-1.5"><Label>{t('orders.commune')}</Label>
            <CommuneSelect className={warn('commune')} communes={communes} wilayaCode={c.wilaya_code} value={c.commune} stopDeskOnly={c.delivery_type === 'stopdesk'} onChange={(v) => set('commune', v)} /></div>
          <div className="grid gap-1.5 sm:col-span-2"><Label>{t('orders.address')}</Label>
            <Textarea rows={2} className={warn('address')} value={c.address} onChange={(e) => set('address', e.target.value)} /></div>
          <div className="grid gap-1.5 sm:col-span-2"><Label>{t('orders.customerNotes')}</Label>
            <Textarea rows={2} value={c.customer_notes} onChange={(e) => set('customer_notes', e.target.value)} /></div>
        </div>
      </section>

      {/* 3. Produits */}
      <section className="grid gap-2 border-t pt-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground"><Package className="size-4" />{t('orders.products')}</h3>
        {lines.map((l) => (
          <div key={l.key} className={cn('grid grid-cols-[1fr_5rem_7rem_auto] items-end gap-2', (l.product_name === PLACEHOLDER_PRODUCT || l.unit_price === 0) && 'rounded-md bg-warning/10 p-1')}>
            <div className="grid gap-1">
              <Select className="text-xs" value={l.product_id ?? ''} onChange={(e) => pickProduct(l.key, e.target.value)} aria-label={t('orders.product')}>
                <option value="">{l.product_id ? '—' : `✎ ${l.product_name || t('orders.chooseProduct')}`}</option>
                {catalog.map((p) => <option key={p.id} value={p.id}>{p.name}{p.sku ? ` · ${p.sku}` : ''}</option>)}
              </Select>
              {!l.product_id ? <Input className="h-8 text-xs" value={l.product_name} placeholder={t('orders.productFreeText')} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, product_name: e.target.value } : x)))} /> : null}
            </div>
            <div className="grid gap-1"><Label className="text-xs">{t('orders.quantity')}</Label>
              <Input type="number" min={1} className="tabular" value={l.quantity} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)))} /></div>
            <div className="grid gap-1"><Label className="text-xs">{t('orders.unitPrice')}</Label>
              <Input type="number" min={0} className="tabular" value={l.unit_price} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, unit_price: Math.max(0, Number(e.target.value) || 0) } : x)))} /></div>
            <Button type="button" size="icon" variant="ghost" disabled={lines.length <= 1} aria-label={t('common.delete')} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 /></Button>
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => setLines((ls) => [...ls, { key: `n${Date.now()}`, product_id: null, product_name: '', sku: null, quantity: 1, unit_price: 0 }])}><Plus />{t('orders.addProduct')}</Button>
        <div className="grid justify-end gap-0.5 text-end text-sm">
          <span className="text-muted-foreground">{t('orders.subtotal')} : <span className="tabular">{formatDZD(subtotal, locale)}</span></span>
          <span className="text-muted-foreground">{t('orders.deliveryFee')} : <span className="tabular">{formatDZD(deliveryFee, locale)}</span></span>
          {discount > 0 ? <span className="text-muted-foreground">{t('orders.discount')} : <span className="tabular">−{formatDZD(discount, locale)}</span></span> : null}
          <span className="font-semibold">{t('orders.totalAmount')} : <span className="tabular">{formatDZD(total, locale)}</span></span>
        </div>
      </section>

      {/* 4. Résultat de l'appel */}
      <section className="sticky bottom-0 z-10 -mx-4 grid gap-3 border-t bg-card/95 px-4 pb-1 pt-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!dirty || saving} onClick={() => void save()}><Save />{t('common.save')}</Button>
          {dirty ? <span className="text-xs text-warning">{t('orders.unsavedChanges')}</span> : null}
        </div>
        <StatusActions orderId={orderId} status={status} version={currentVersion} isManager={isManager} beforeChange={save}
          confirmBlockers={Object.entries(missing).filter(([, v]) => v).map(([k]) => t(k === 'customer_name' ? 'orders.customerName' : k === 'wilaya_code' ? 'orders.wilaya' : `orders.${k}` as 'orders.phone'))} />
      </section>
    </div>
  );
}
