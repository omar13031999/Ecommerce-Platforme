'use client';
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TR } from '@/components/ui/table';
import { useAction } from '@/components/app/use-action';
import { addManualAllocation, deleteManualAllocation, mapCampaignProduct, syncAdAccountNow, updateAdAccount } from '@/lib/actions/ads';
import { formatDZD, formatDate, type AppLocale } from '@/lib/format';

type Account = { id: string; name: string; external_id: string; currency: string; timezone: string | null; fx_rate_to_dzd: number | null; is_active: boolean; sync_from: string; last_error: string | null };

export function AccountRow({ account, canManage, lastSync }: { account: Account; canManage: boolean; lastSync: string }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const [fx, setFx] = useState(account.fx_rate_to_dzd?.toString() ?? '');
  const [from, setFrom] = useState(account.sync_from);
  const [active, setActive] = useState(account.is_active);
  const needsFx = account.currency !== 'DZD' && !account.fx_rate_to_dzd;
  return (
    <TR>
      <TD><div className="font-medium">{account.name}</div><div className="font-mono text-xs text-muted-foreground">{account.external_id} · {account.timezone}</div>{account.last_error ? <div className="max-w-xs truncate text-xs text-destructive" title={account.last_error}>{account.last_error}</div> : null}</TD>
      <TD>{account.currency}</TD>
      <TD>{account.currency === 'DZD' ? '—' : <Input disabled={!canManage} className={needsFx ? 'h-8 w-28 border-warning' : 'h-8 w-28'} type="number" step="0.0001" value={fx} placeholder={t('ads.fxMissing')} onChange={(e) => setFx(e.target.value)} />}</TD>
      <TD><Input disabled={!canManage} className="h-8 w-36" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></TD>
      <TD><Checkbox disabled={!canManage} checked={active} onChange={(e) => setActive(e.target.checked)} /></TD>
      <TD className="text-xs text-muted-foreground">{lastSync}</TD>
      <TD className="flex gap-1">
        {canManage ? (
          <>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => updateAdAccount({ id: account.id, is_active: active, fx_rate_to_dzd: fx === '' ? null : Number(fx), sync_from: from }), { success: t('common.saved') })}>{t('common.save')}</Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => syncAdAccountNow(account.id), { success: t('common.syncNow') })}><RefreshCw className={pending ? 'animate-spin' : ''} /></Button>
          </>
        ) : null}
      </TD>
    </TR>
  );
}

export function CampaignProductMapper({ campaigns, products, mappings }: { campaigns: { id: string; name: string }[]; products: { id: string; name: string }[]; mappings: { campaign_id: string; product_id: string }[] }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const [campaign, setCampaign] = useState('');
  const [product, setProduct] = useState('');
  const cName = Object.fromEntries(campaigns.map((c) => [c.id, c.name]));
  const pName = Object.fromEntries(products.map((p) => [p.id, p.name]));
  return (
    <Card>
      <CardHeader><CardTitle>{t('ads.campaignProducts')}</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap gap-2">
          <Select className="w-56" value={campaign} onChange={(e) => setCampaign(e.target.value)}><option value="">{t('ads.byCampaign')}</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
          <Select className="w-48" value={product} onChange={(e) => setProduct(e.target.value)}><option value="">{t('orders.product')}</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          <Button size="sm" className="h-9" disabled={!campaign || !product || pending} onClick={() => run(() => mapCampaignProduct({ campaignId: campaign, productId: product }))}>{t('common.add')}</Button>
        </div>
        <Table><TBody>
          {mappings.map((m) => (
            <TR key={`${m.campaign_id}-${m.product_id}`}>
              <TD className="text-sm">{cName[m.campaign_id] ?? m.campaign_id}</TD><TD>→ {pName[m.product_id] ?? '—'}</TD>
              <TD className="text-end"><Button size="icon" variant="ghost" aria-label={t('common.delete')} onClick={() => run(() => mapCampaignProduct({ campaignId: m.campaign_id, productId: m.product_id, remove: true }))}><Trash2 /></Button></TD>
            </TR>
          ))}
        </TBody></Table>
      </CardContent>
    </Card>
  );
}

export function ManualAllocations({ products, items }: { products: { id: string; name: string }[]; items: { id: string; product_id: string; period_start: string; period_end: string; amount_dzd: number; note: string | null }[] }) {
  const t = useTranslations();
  const locale = useLocale() as AppLocale;
  const { run, pending } = useAction();
  const pName = Object.fromEntries(products.map((p) => [p.id, p.name]));
  return (
    <Card>
      <CardHeader><CardTitle>{t('ads.manualAllocations')}</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        <form className="flex flex-wrap gap-2" onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const d = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
          run(() => addManualAllocation({ product_id: d.product_id ?? '', period_start: d.period_start ?? '', period_end: d.period_end ?? '', amount_dzd: d.amount_dzd ?? '' }), { success: t('common.saved'), onSuccess: () => form.reset() });
        }}>
          <Select name="product_id" required className="w-44">{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          <Input name="period_start" type="date" required className="w-36" aria-label={t('common.from')} />
          <Input name="period_end" type="date" required className="w-36" aria-label={t('common.to')} />
          <Input name="amount_dzd" type="number" min={0} required className="w-32" placeholder={t('ads.spendDzd')} />
          <Button size="sm" className="h-9" type="submit" disabled={pending}>{t('common.add')}</Button>
        </form>
        <Table><TBody>
          {items.map((a) => (
            <TR key={a.id}>
              <TD>{pName[a.product_id] ?? '—'}</TD>
              <TD className="text-xs">{formatDate(a.period_start, locale)} → {formatDate(a.period_end, locale)}</TD>
              <TD className="tabular">{formatDZD(a.amount_dzd, locale)}</TD>
              <TD className="text-end"><Button size="icon" variant="ghost" aria-label={t('common.delete')} onClick={() => run(() => deleteManualAllocation(a.id))}><Trash2 /></Button></TD>
            </TR>
          ))}
        </TBody></Table>
      </CardContent>
    </Card>
  );
}
