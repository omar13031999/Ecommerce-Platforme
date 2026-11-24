'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { RefreshCw, Send, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox, Select } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useAction } from '@/components/app/use-action';
import { submitToDelivery } from '@/lib/actions/orders';
import { importDeliveryStatuses, pollProviderNow } from '@/lib/actions/delivery';
import { formatDZD, type AppLocale } from '@/lib/format';

type Row = { id: string; reference: number; customer_name: string; wilaya: string; total: number };

export function DeliveryQueue({ rows, providers }: { rows: Row[]; providers: { id: string; name: string; code: string }[] }) {
  const t = useTranslations();
  const locale = useLocale() as AppLocale;
  const { run, pending, errorMessage } = useAction();
  const apiProviders = providers.filter((p) => p.code !== 'manual');
  const [providerId, setProviderId] = useState(apiProviders[0]?.id ?? '');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const all = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const [errors, setErrors] = useState<Record<string, string>>({});

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 p-3">
        {apiProviders.length ? (
          <>
            <Select className="h-8 w-48" value={providerId} onChange={(e) => setProviderId(e.target.value)} aria-label={t('deliveryPage.chooseProvider')}>
              {apiProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <Button size="sm" disabled={!sel.size || !providerId || pending}
              onClick={() => run(() => submitToDelivery({ orderIds: [...sel], providerId }), {
                success: (d) => t('orders.bulkSubmitted', { ok: d?.ok ?? 0, failed: d?.failed ?? 0 }),
                onSuccess: (d) => setErrors(Object.fromEntries((d?.results ?? []).filter((r) => !r.ok).map((r) => [r.orderId, errorMessage(r.error ?? 'unknown', { fields: (r.details ?? []).map((f) => (t.has(`fields.${f}`) ? t(`fields.${f}`) : f)).join(', ') })]))),
              })}>
              <Send />{t('deliveryPage.submitSelected')} ({sel.size})
            </Button>
          </>
        ) : <span className="text-sm text-muted-foreground">{t('deliveryPage.manualOnly')}</span>}
      </div>
      <Table>
        <THead><TR>
          <TH className="w-8"><Checkbox aria-label="all" checked={all} onChange={() => setSel(all ? new Set() : new Set(rows.map((r) => r.id)))} /></TH>
          <TH>{t('orders.reference')}</TH><TH>{t('orders.customer')}</TH><TH>{t('orders.wilaya')}</TH><TH>{t('orders.totalAmount')}</TH><TH />
        </TR></THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.id}>
              <TD><Checkbox aria-label={`#${r.reference}`} checked={sel.has(r.id)} onChange={() => { const n = new Set(sel); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); setSel(n); }} /></TD>
              <TD><Link className="font-medium text-primary hover:underline" href={`/orders/${r.id}`}>#{r.reference}</Link></TD>
              <TD>{r.customer_name}</TD>
              <TD>{r.wilaya}</TD>
              <TD className="tabular">{formatDZD(r.total, locale)}</TD>
              <TD className="max-w-[320px] text-xs text-destructive">{errors[r.id]}</TD>
            </TR>
          ))}
          {!rows.length ? <TR><TD colSpan={6} className="text-center text-muted-foreground">{t('common.noResults')}</TD></TR> : null}
        </TBody>
      </Table>
    </div>
  );
}

export function ProviderPollButton({ providerId }: { providerId: string }) {
  const t = useTranslations('deliveryPage');
  const { run, pending } = useAction();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => pollProviderNow(providerId), { success: t('pollNow') })}>
      <RefreshCw className={pending ? 'animate-spin' : ''} />{t('pollNow')}
    </Button>
  );
}

export function StatusImport() {
  const t = useTranslations();
  const ref = useRef<HTMLInputElement>(null);
  const { run, pending } = useAction();
  return (
    <>
      <input ref={ref} type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        const fd = new FormData();
        fd.set('file', f);
        run(() => importDeliveryStatuses(fd), { success: (d) => t('reconciliation.importDone', { matched: d?.matched ?? 0, unmatched: d?.unmatched ?? 0 }) });
        e.target.value = '';
      }} />
      <Button variant="outline" disabled={pending} onClick={() => { toast.info('CSV/XLSX: tracking, status'); ref.current?.click(); }}><Upload />{t('deliveryPage.importStatuses')}</Button>
    </>
  );
}
