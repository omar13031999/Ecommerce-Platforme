'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Bookmark, BookmarkPlus, Download, FilterX, Search, X } from 'lucide-react';
import { Input, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CONFIRMATION_STATUSES, DELIVERY_STATUSES } from '@/lib/domain/statuses';
import { RANGE_PRESETS } from '@/lib/dates';
import { useAction } from '@/components/app/use-action';
import { deleteOrderFilter, saveOrderFilter } from '@/lib/actions/orders';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type Opt = { id: string; name?: string; full_name?: string };

export function OrdersFilters({
  agents, products, wilayas, showAgentFilter, canExport, savedFilters = [],
}: { agents: Opt[]; products: Opt[]; wilayas: { code: number; name: string }[]; showAgentFilter: boolean; canExport: boolean; savedFilters?: { id: string; name: string; query: string }[] }) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [tmin, setTmin] = useState(params.get('tmin') ?? '');
  const [tmax, setTmax] = useState(params.get('tmax') ?? '');
  const [utm, setUtm] = useState(params.get('utm') ?? '');
  const { run, pending } = useAction();

  useEffect(() => {
    setQ(params.get('q') ?? '');
    setTmin(params.get('tmin') ?? '');
    setTmax(params.get('tmax') ?? '');
    setUtm(params.get('utm') ?? '');
  }, [params]);
  function setMany(values: Record<string, string>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, val] of Object.entries(values)) {
      if (val) sp.set(k, val);
      else sp.delete(k);
    }
    sp.delete('page');
    router.push(`${pathname}?${sp.toString()}`);
  }

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
        <Select className="w-36" value={v('dt')} onChange={(e) => set('dt', e.target.value)} aria-label={t('orders.deliveryType')}>
          <option value="">{t('orders.deliveryType')}: {t('common.all')}</option>
          <option value="home">{t('orders.home')}</option>
          <option value="stopdesk">{t('orders.stopdesk')}</option>
        </Select>
        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); setMany({ tmin: tmin.trim(), tmax: tmax.trim(), utm: utm.trim() }); }}>
          <Input className="h-9 w-24" type="number" min={0} placeholder={t('orders.totalMin')} value={tmin} onChange={(e) => setTmin(e.target.value)} aria-label={t('orders.totalMin')} />
          <Input className="h-9 w-24" type="number" min={0} placeholder={t('orders.totalMax')} value={tmax} onChange={(e) => setTmax(e.target.value)} aria-label={t('orders.totalMax')} />
          <Input className="h-9 w-32" placeholder="UTM source" value={utm} onChange={(e) => setUtm(e.target.value)} aria-label="UTM source" />
          <Button type="submit" size="sm" variant="outline" className="h-9">OK</Button>
        </form>
        <Button variant={v('blocked') ? 'secondary' : 'outline'} size="sm" className="h-9" onClick={() => set('blocked', v('blocked') ? '' : '1')}>⛔ {t('orders.onlyBlocked')}</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="h-9"><Bookmark />{t('orders.savedFilters')}{savedFilters.length ? ` (${savedFilters.length})` : ''}</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>{t('orders.savedFilters')}</DropdownMenuLabel>
            {savedFilters.map((f) => (
              <DropdownMenuItem key={f.id} className="justify-between" onSelect={() => router.push(`${pathname}?${f.query}`)}>
                <span className="truncate">{f.name}</span>
                <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-destructive" aria-label={t('common.delete')}
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); run(() => deleteOrderFilter(f.id)); }}><X className="size-3.5" /></button>
              </DropdownMenuItem>
            ))}
            {savedFilters.length ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem disabled={!params.toString() || pending} onSelect={() => {
              const name = window.prompt(t('orders.saveFilterName'));
              if (name?.trim()) run(() => saveOrderFilter({ name, query: params.toString() }), { success: t('common.saved') });
            }}><BookmarkPlus className="size-4" />{t('orders.saveCurrentFilter')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {showAgentFilter ? (
          <>
            <Button variant={v('review') ? 'secondary' : 'outline'} size="sm" className="h-9" onClick={() => set('review', v('review') ? '' : '1')}>{t('orders.onlyReview')}</Button>
            <Button variant={v('queue') ? 'secondary' : 'outline'} size="sm" className="h-9" onClick={() => set('queue', v('queue') ? '' : 'waiting')}>{t('orders.onlyWaiting')}</Button>
          </>
        ) : null}
        {params.toString() ? (
          <Button variant="ghost" size="sm" className="h-9" onClick={() => router.push(params.get('view') ? `${pathname}?view=${encodeURIComponent(params.get('view')!)}` : pathname)}><FilterX />{t('common.reset')}</Button>
        ) : null}
      </div>
    </div>
  );
}
