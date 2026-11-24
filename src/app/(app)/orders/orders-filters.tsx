'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Download, FilterX, Search } from 'lucide-react';
import { Input, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CONFIRMATION_STATUSES, DELIVERY_STATUSES } from '@/lib/domain/statuses';
import { RANGE_PRESETS } from '@/lib/dates';

type Opt = { id: string; name?: string; full_name?: string };

export function OrdersFilters({
  agents, products, wilayas, showAgentFilter, canExport,
}: { agents: Opt[]; products: Opt[]; wilayas: { code: number; name: string }[]; showAgentFilter: boolean; canExport: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');

  useEffect(() => setQ(params.get('q') ?? ''), [params]);

  function set(key: string, value: string) {
    const sp = new URLSearchParams(params.toString());
    if (value) sp.set(key, value);
    else sp.delete(key);
    sp.delete('page');
    router.push(`${pathname}?${sp.toString()}`);
  }
  const v = (k: string) => params.get(k) ?? '';
  const exportHref = (fmt: string) => `/api/exports/orders?${new URLSearchParams({ ...Object.fromEntries(params.entries()), format: fmt }).toString()}`;

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <form
          className="relative min-w-[240px] flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            set('q', q.trim());
          }}
        >
          <Search className="pointer-events-none absolute start-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input className="ps-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('orders.searchPlaceholder')} aria-label={t('common.search')} />
        </form>
        <Select className="w-44" value={v('range')} onChange={(e) => set('range', e.target.value)} aria-label={t('common.period')}>
          <option value="">{t('common.all')}</option>
          {RANGE_PRESETS.filter((p) => p !== 'custom').map((p) => <option key={p} value={p}>{t(`range.${p}`)}</option>)}
        </Select>
        {canExport ? (
          <>
            <a className="inline-flex h-9 items-center gap-1 rounded-md border bg-card px-3 text-sm hover:bg-accent" href={exportHref('xlsx')}><Download className="size-4" />Excel</a>
            <a className="inline-flex h-9 items-center gap-1 rounded-md border bg-card px-3 text-sm hover:bg-accent" href={exportHref('csv')}><Download className="size-4" />CSV</a>
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Select className="w-48" value={v('status')} onChange={(e) => set('status', e.target.value)} aria-label={t('orders.confirmationStatus')}>
          <option value="">{t('orders.confirmationStatus')}: {t('common.all')}</option>
          <option value="active">{t('dashboard.awaitingConfirmation')}</option>
          <option value="no_answer">{t('dashboard.noAnswer')} (1–9)</option>
          {CONFIRMATION_STATUSES.map((s) => <option key={s} value={s}>{t(`confirmation.${s}`)}</option>)}
        </Select>
        <Select className="w-48" value={v('delivery')} onChange={(e) => set('delivery', e.target.value)} aria-label={t('orders.deliveryStatus')}>
          <option value="">{t('orders.deliveryStatus')}: {t('common.all')}</option>
          <option value="in_transit">{t('dashboard.inTransit')} (*)</option>
          {DELIVERY_STATUSES.map((s) => <option key={s} value={s}>{t(`delivery.${s}`)}</option>)}
        </Select>
        {showAgentFilter ? (
          <Select className="w-44" value={v('agent')} onChange={(e) => set('agent', e.target.value)} aria-label={t('orders.filterAgent')}>
            <option value="">{t('orders.filterAgent')}: {t('common.all')}</option>
            <option value="none">{t('orders.unassigned')}</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </Select>
        ) : null}
        <Select className="w-40" value={v('wilaya')} onChange={(e) => set('wilaya', e.target.value)} aria-label={t('orders.wilaya')}>
          <option value="">{t('orders.wilaya')}: {t('common.all')}</option>
          {wilayas.map((w) => <option key={w.code} value={w.code}>{String(w.code).padStart(2, '0')} — {w.name}</option>)}
        </Select>
        <Select className="w-44" value={v('product')} onChange={(e) => set('product', e.target.value)} aria-label={t('orders.filterProduct')}>
          <option value="">{t('orders.filterProduct')}: {t('common.all')}</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        {showAgentFilter ? (
          <>
            <Button variant={v('review') ? 'secondary' : 'outline'} size="sm" className="h-9" onClick={() => set('review', v('review') ? '' : '1')}>{t('orders.onlyReview')}</Button>
            <Button variant={v('queue') ? 'secondary' : 'outline'} size="sm" className="h-9" onClick={() => set('queue', v('queue') ? '' : 'waiting')}>{t('orders.onlyWaiting')}</Button>
          </>
        ) : null}
        {params.toString() ? (
          <Button variant="ghost" size="sm" className="h-9" onClick={() => router.push(pathname)}><FilterX />{t('common.reset')}</Button>
        ) : null}
      </div>
    </div>
  );
}
