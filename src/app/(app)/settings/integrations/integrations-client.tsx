'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Download, FlaskConical, MapPin, Package, Pencil, Plus, RefreshCw, Trash2, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Table, TBody, TD, TR } from '@/components/ui/table';
import { useAction } from '@/components/app/use-action';
import { deleteSheetSource, disconnectConnection, loadSpreadsheet, saveSheetSource, syncSheetNow, testSheetSource } from '@/lib/actions/integrations';
import { importProviderCommunes, importProviderProducts, saveProvider, saveRates, saveStatusMapping, testProvider } from '@/lib/actions/delivery';
import { importMetaAccounts } from '@/lib/actions/ads';
import { MAPPABLE_FIELDS, REQUIRED_FIELDS, type ColumnMapping, type MappableField } from '@/lib/integrations/google-sheets/mapping';
import { DELIVERY_STATUSES } from '@/lib/domain/statuses';

export function ConnectionActions({ id, provider }: { id: string; provider: 'google' | 'meta' }) {
  const t = useTranslations('common');
  const { run, pending } = useAction();
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => { if (confirm(`${t('disconnect')} ${provider}?`)) run(() => disconnectConnection(id)); }}>
      <Unplug />{t('disconnect')}
    </Button>
  );
}

export function MetaImportButton({ connectionId }: { connectionId: string }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  return <Button size="sm" variant="outline" className="w-fit" disabled={pending} onClick={() => run(() => importMetaAccounts(connectionId), { success: (n) => `${n} ✓` })}><Download />{t('integrations.importAccounts')}</Button>;
}

type Source = {
  id: string; name: string; connection_id: string | null; spreadsheet_id: string; worksheet_title: string; header_row: number;
  column_mapping: ColumnMapping; options: { multi_product_separator?: string; group_rows_by_external_id?: boolean; price_is_line_total?: boolean; date_format?: 'auto' | 'dmy' | 'mdy' };
  sync_enabled: boolean; sync_interval_minutes: number;
};

export function SourceActions({ source, connections }: { source: Source; connections: { id: string; label: string }[] }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  return (
    <div className="flex justify-end gap-1">
      <Button size="icon" variant="ghost" aria-label={t('integrations.testConnection')} disabled={pending}
        onClick={() => run(() => testSheetSource(source.id), { refresh: false, success: (d) => t('integrations.testOk', { rows: d?.rows ?? 0, orders: d?.orders ?? 0 }) })}><FlaskConical /></Button>
      <Button size="icon" variant="ghost" aria-label={t('common.syncNow')} disabled={pending}
        onClick={() => run(() => syncSheetNow(source.id), { success: (d) => t('integrations.syncDone', { created: d?.created ?? 0, updated: d?.updated ?? 0, errors: d?.errors ?? 0 }) })}><RefreshCw className={pending ? 'animate-spin' : ''} /></Button>
      <SourceEditor connections={connections} source={source} />
      <Button size="icon" variant="ghost" aria-label={t('common.delete')} disabled={pending} onClick={() => { if (confirm(t('common.confirm'))) run(() => deleteSheetSource(source.id)); }}><Trash2 /></Button>
    </div>
  );
}

export function SourceEditor({ connections, source }: { connections: { id: string; label: string }[]; source?: Source }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const [open, setOpen] = useState(false);
  const [connectionId, setConnectionId] = useState(source?.connection_id ?? connections[0]?.id ?? '');
  const [spreadsheet, setSpreadsheet] = useState(source?.spreadsheet_id ?? '');
  const [sheets, setSheets] = useState<string[]>(source ? [source.worksheet_title] : []);
  const [worksheet, setWorksheet] = useState(source?.worksheet_title ?? '');
  const [headerRow, setHeaderRow] = useState(source?.header_row ?? 1);
  const [header, setHeader] = useState<string[]>(source ? Object.values(source.column_mapping) : []);
  const [sample, setSample] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>(source?.column_mapping ?? {});
  const [name, setName] = useState(source?.name ?? '');
  const [opts, setOpts] = useState(source?.options ?? { group_rows_by_external_id: true, date_format: 'auto' as const });
  const [sync, setSync] = useState(source?.sync_enabled ?? true);
  const [syncInterval, setSyncInterval] = useState(source?.sync_interval_minutes ?? 15);

  function load(ws?: string) {
    run(() => loadSpreadsheet({ connectionId, spreadsheet, worksheet: ws ?? worksheet, headerRow }), {
      refresh: false,
      onSuccess: (d) => {
        if (!d) return;
        setSpreadsheet(d.spreadsheetId);
        setSheets(d.sheets);
        setWorksheet(d.worksheet ?? '');
        setHeader(d.header.filter(Boolean));
        setSample(d.sample);
        if (!name) setName(d.title);
        // Auto-suggest mapping by similar names
        const guess: ColumnMapping = { ...mapping };
        const find = (...words: string[]) => d.header.find((h) => words.some((w) => h.toLowerCase().includes(w)));
        guess.external_id ??= find('id', 'commande', 'order', 'n°');
        guess.customer_name ??= find('nom', 'name', 'client', 'الاسم');
        guess.phone ??= find('tél', 'tel', 'phone', 'هاتف');
        guess.wilaya ??= find('wilaya', 'ولاية');
        guess.commune ??= find('commune', 'بلدية');
        guess.address ??= find('adresse', 'address', 'عنوان');
        guess.product_name ??= find('produit', 'product', 'article', 'منتج');
        guess.quantity ??= find('qt', 'quant', 'كمية');
        guess.product_price ??= find('prix', 'price', 'سعر');
        setMapping(Object.fromEntries(Object.entries(guess).filter(([, v]) => v)) as ColumnMapping);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{source ? <Button size="icon" variant="ghost" aria-label={t('integrations.editSource')}><Pencil /></Button> : <Button size="sm"><Plus />{t('integrations.newSource')}</Button>}</DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>{source ? t('integrations.editSource') : t('integrations.newSource')}</DialogTitle><DialogDescription>{t('integrations.fieldsRequired')}</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          {!connectionId ? <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">{t('integrations.publicLinkHelp')}</p> : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5 sm:col-span-2"><Label>{t('integrations.spreadsheetUrl')}</Label><Input dir="ltr" value={spreadsheet} onChange={(e) => setSpreadsheet(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" /></div>
            <div className="grid gap-1.5"><Label>{t('integrations.accessMode')}</Label><Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
              <option value="">{t('integrations.publicLink')}</option>
              {connections.map((c) => <option key={c.id} value={c.id}>Google: {c.label}</option>)}
            </Select></div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5"><Label>{t('integrations.headerRow')}</Label><Input className="w-24" type="number" min={1} value={headerRow} onChange={(e) => { setHeaderRow(Number(e.target.value)); setHeader([]); setSample([]); }} /></div>
            <Button variant="outline" disabled={!spreadsheet || pending} onClick={() => load()}>{t('integrations.loadSheet')}</Button>
            {sheets.length ? (
              <div className="grid gap-1.5"><Label>{t('integrations.worksheet')}</Label>
                <Select className="w-48" value={worksheet} onChange={(e) => { setWorksheet(e.target.value); load(e.target.value); }}>{sheets.map((s) => <option key={s} value={s}>{s}</option>)}</Select>
              </div>
            ) : null}
          </div>
          {header.length ? (
            <>
              <div className="grid gap-1.5"><Label>{t('common.name')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
              <fieldset className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
                <legend className="px-1 text-sm font-medium">{t('integrations.mapping')}</legend>
                {MAPPABLE_FIELDS.map((f: MappableField) => (
                  <div key={f} className="grid grid-cols-2 items-center gap-2">
                    <Label className="text-xs">{t(`fields.${f}`)}{REQUIRED_FIELDS.includes(f) ? ' *' : ''}</Label>
                    <Select className="h-8 text-xs" value={mapping[f] ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value || undefined })}>
                      <option value="">{t('integrations.notMapped')}</option>
                      {header.map((h) => <option key={h} value={h}>{h}</option>)}
                    </Select>
                  </div>
                ))}
              </fieldset>
              {sample.length ? (
                <details className="text-xs"><summary className="cursor-pointer">{t('integrations.sample')}</summary>
                  <div className="overflow-x-auto"><table className="mt-1 text-[11px]"><tbody>{[header, ...sample].map((r, i) => <tr key={i} className={i === 0 ? 'font-semibold' : ''}>{r.map((c, j) => <td key={j} className="border px-1">{c}</td>)}</tr>)}</tbody></table></div>
                </details>
              ) : null}
              <fieldset className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
                <legend className="px-1 text-sm font-medium">{t('integrations.options')}</legend>
                <div className="grid gap-1.5"><Label className="text-xs">{t('integrations.multiSeparator')}</Label><Input className="h-8" maxLength={5} value={opts.multi_product_separator ?? ''} onChange={(e) => setOpts({ ...opts, multi_product_separator: e.target.value })} /></div>
                <div className="grid gap-1.5"><Label className="text-xs">{t('integrations.dateFormat')}</Label>
                  <Select className="h-8" value={opts.date_format ?? 'auto'} onChange={(e) => setOpts({ ...opts, date_format: e.target.value as 'auto' })}><option value="auto">{t('integrations.dateAuto')}</option><option value="dmy">JJ/MM/AAAA</option><option value="mdy">MM/DD/YYYY</option></Select>
                </div>
                <label className="flex items-center gap-2 text-xs"><Checkbox checked={opts.group_rows_by_external_id !== false} onChange={(e) => setOpts({ ...opts, group_rows_by_external_id: e.target.checked })} />{t('integrations.groupRows')}</label>
                <label className="flex items-center gap-2 text-xs"><Checkbox checked={Boolean(opts.price_is_line_total)} onChange={(e) => setOpts({ ...opts, price_is_line_total: e.target.checked })} />{t('integrations.priceIsLineTotal')}</label>
                <label className="flex items-center gap-2 text-xs"><Checkbox checked={sync} onChange={(e) => setSync(e.target.checked)} />{t('integrations.syncEnabled')}</label>
                <div className="flex items-center gap-2 text-xs">{t('integrations.interval')}<Input className="h-8 w-20" type="number" min={5} value={syncInterval} onChange={(e) => setSyncInterval(Number(e.target.value))} /></div>
              </fieldset>
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button disabled={pending || !header.length || !worksheet} onClick={() => run(() => saveSheetSource({
            id: source?.id, name: name || worksheet, connection_id: connectionId || null, spreadsheet_id: spreadsheet, worksheet_title: worksheet, header_row: headerRow,
            column_mapping: mapping as Record<MappableField, string>, options: opts, sync_enabled: sync, sync_interval_minutes: syncInterval,
          }), { success: t('common.saved'), onSuccess: () => setOpen(false) })}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type AdapterInfo = { code: string; integrationLevel: string; credentialFields: { key: string; labelKey: string; required: boolean }[] };
type ProviderRow = { id: string; code: string; name: string; is_active: boolean; base_url: string | null; config: string; webhook_enabled: boolean; webhook_token: string; polling_enabled: boolean; polling_interval_minutes: number; tracking_url_template: string | null; credentials_configured: boolean };

export function ProviderEditor({ adapters, appUrl, provider }: { adapters: AdapterInfo[]; appUrl: string; provider?: ProviderRow }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    code: provider?.code ?? 'rest', name: provider?.name ?? '', is_active: provider?.is_active ?? true, base_url: provider?.base_url ?? '',
    config: provider?.config ?? '{}', webhook_enabled: provider?.webhook_enabled ?? false, polling_enabled: provider?.polling_enabled ?? true,
    polling_interval_minutes: provider?.polling_interval_minutes ?? 60, tracking_url_template: provider?.tracking_url_template ?? '',
  });
  const [creds, setCreds] = useState<Record<string, string>>({});
  const adapter = adapters.find((a) => a.code === f.code);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{provider ? <Button size="icon" variant="ghost" aria-label={t('common.edit')}><Pencil /></Button> : <Button size="sm"><Plus />{t('integrations.newProvider')}</Button>}</DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{provider?.name ?? t('integrations.newProvider')}</DialogTitle><DialogDescription>{t('integrations.documentedWarning')}</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5"><Label>{t('common.name')}</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
            <div className="grid gap-1.5"><Label>{t('integrations.adapter')}</Label>
              <Select value={f.code} disabled={Boolean(provider)} onChange={(e) => setF({ ...f, code: e.target.value })}>
                {adapters.map((a) => <option key={a.code} value={a.code}>{t(`integrations.adapter_${a.code}` as 'integrations.adapter_manual')}</option>)}
              </Select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />{t('common.active')}</label>
          <div className="grid gap-1.5"><Label>{t('integrations.trackingUrl')}</Label><Input dir="ltr" value={f.tracking_url_template} onChange={(e) => setF({ ...f, tracking_url_template: e.target.value })} placeholder="https://…/{tracking}" /></div>
          {f.code !== 'manual' ? (
            <>
              <div className="grid gap-1.5"><Label>{t('integrations.baseUrl')}</Label><Input dir="ltr" value={f.base_url} onChange={(e) => setF({ ...f, base_url: e.target.value })} placeholder="https://" /></div>
              <fieldset className="grid gap-2 rounded-md border p-3">
                <legend className="px-1 text-sm font-medium">{t('integrations.credentials')}</legend>
                <p className="text-xs text-muted-foreground">{provider?.credentials_configured ? `${t('integrations.credentialsSet')} — ` : ''}{t('integrations.credentialsHelp')}</p>
                {adapter?.credentialFields.map((c) => (
                  <div key={c.key} className="grid gap-1"><Label className="text-xs">{t(`integrations.${c.labelKey}` as 'integrations.api_key')}</Label>
                    <Input type="password" autoComplete="off" dir="ltr" value={creds[c.key] ?? ''} onChange={(e) => setCreds({ ...creds, [c.key]: e.target.value })} />
                  </div>
                ))}
              </fieldset>
              <div className="grid gap-1.5">
                <Label>{t('integrations.config')}</Label>
                <Textarea dir="ltr" className="font-mono text-xs" rows={10} value={f.config} onChange={(e) => setF({ ...f, config: e.target.value })} />
                <p className="text-xs text-muted-foreground">{t('integrations.configHelp')}</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.polling_enabled} onChange={(e) => setF({ ...f, polling_enabled: e.target.checked })} />{t('integrations.polling')}</label>
                <div className="flex items-center gap-2 text-sm">{t('integrations.pollingInterval')}<Input className="w-20" type="number" min={5} value={f.polling_interval_minutes} onChange={(e) => setF({ ...f, polling_interval_minutes: Number(e.target.value) })} /></div>
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.webhook_enabled} onChange={(e) => setF({ ...f, webhook_enabled: e.target.checked })} />{t('integrations.webhookEnabled')}</label>
              </div>
              {f.webhook_enabled && provider ? (
                <div className="grid gap-1 rounded-md bg-muted p-2 text-xs">
                  <span>{t('integrations.webhookUrl')}</span>
                  <code dir="ltr" className="break-all">{appUrl}/api/webhooks/delivery/{provider.id}/{provider.webhook_token}</code>
                  <span className="text-muted-foreground">{t('integrations.webhookHint')}</span>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button disabled={pending || !f.name.trim()} onClick={() => run(() => saveProvider({ id: provider?.id, ...f, code: f.code as 'rest' | 'ecotrack' | 'manual', credentials: creds }), {
            success: t('common.saved'), onSuccess: () => { setOpen(false); setCreds({}); },
          })}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProviderTools({ providerId, code, mappings, canRates, rates, wilayas }: {
  providerId: string; code: string; mappings: { id: string; provider_status: string; internal_status: string }[];
  canRates: boolean; rates: { wilaya_code: number; home_cost: number | null; stopdesk_cost: number | null; return_cost: number | null }[];
  wilayas: { code: number; name: string }[];
}) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const [ps, setPs] = useState('');
  const [is, setIs] = useState('in_transit');
  const [r, setR] = useState(() => Object.fromEntries(wilayas.map((w) => {
    const x = rates.find((y) => y.wilaya_code === w.code);
    return [w.code, { home: x?.home_cost?.toString() ?? '', stop: x?.stopdesk_cost?.toString() ?? '', ret: x?.return_cost?.toString() ?? '' }];
  })) as Record<number, { home: string; stop: string; ret: string }>);
  const num = (v: string) => (v === '' ? null : Number(v));
  return (
    <div className="flex flex-wrap gap-2">
      {code !== 'manual' ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => testProvider(providerId), {
          onSuccess: (d) => (d?.ok ? toast.success(t('common.success')) : toast.error(t('integrations.testFailed', { error: d?.error ?? '' }))),
        })}><FlaskConical />{t('integrations.testConnection')}</Button>
      ) : null}
      {code === 'ecotrack' ? (
        <>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => importProviderCommunes(providerId), { success: (d) => t('integrations.communesImported', { count: d?.count ?? 0 }) })}><MapPin />{t('integrations.importCommunes')}</Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => importProviderProducts(providerId), { success: (d) => t('integrations.productsImported', { total: d?.total ?? 0, created: d?.created ?? 0, updated: d?.updated ?? 0 }) })}><Package />{t('integrations.importProducts')}</Button>
        </>
      ) : null}
      {code !== 'manual' ? (
        <Dialog>
          <DialogTrigger asChild><Button size="sm" variant="outline">{t('integrations.statusMappings')} ({mappings.length})</Button></DialogTrigger>
          <DialogContent className="max-w-xl">
            <DialogHeader><DialogTitle>{t('integrations.statusMappings')}</DialogTitle></DialogHeader>
            <div className="flex gap-2">
              <Input placeholder={t('integrations.providerStatus')} value={ps} onChange={(e) => setPs(e.target.value)} />
              <Select value={is} onChange={(e) => setIs(e.target.value)}>{DELIVERY_STATUSES.map((s) => <option key={s} value={s}>{t(`delivery.${s}`)}</option>)}</Select>
              <Button disabled={!ps.trim() || pending} onClick={() => run(() => saveStatusMapping({ providerId, provider_status: ps, internal_status: is }), { onSuccess: () => setPs('') })}>{t('common.add')}</Button>
            </div>
            <Table><TBody>{mappings.map((m) => <TR key={m.id}><TD>{m.provider_status}</TD><TD>→ {t(`delivery.${m.internal_status as 'delivered'}`)}</TD></TR>)}</TBody></Table>
          </DialogContent>
        </Dialog>
      ) : null}
      {canRates ? (
        <Dialog>
          <DialogTrigger asChild><Button size="sm" variant="outline">{t('integrations.rates')}</Button></DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>{t('integrations.rates')}</DialogTitle></DialogHeader>
            <div className="max-h-[60vh] overflow-y-auto">
              <Table><TBody>
                <TR><TD /><TD className="text-xs font-medium">{t('integrations.homeCost')}</TD><TD className="text-xs font-medium">{t('integrations.stopdeskCost')}</TD><TD className="text-xs font-medium">{t('integrations.returnCost')}</TD></TR>
                {wilayas.map((w) => (
                  <TR key={w.code}>
                    <TD className="text-xs">{String(w.code).padStart(2, '0')} {w.name}</TD>
                    {(['home', 'stop', 'ret'] as const).map((k) => (
                      <TD key={k}><Input className="h-7 w-24" type="number" min={0} value={r[w.code]?.[k] ?? ''} onChange={(e) => setR({ ...r, [w.code]: { ...r[w.code]!, [k]: e.target.value } })} /></TD>
                    ))}
                  </TR>
                ))}
              </TBody></Table>
            </div>
            <DialogFooter>
              <Button disabled={pending} onClick={() => run(() => saveRates(Object.entries(r).filter(([, v]) => v.home || v.stop || v.ret).map(([code, v]) => ({
                providerId, wilaya_code: Number(code), home_cost: num(v.home), stopdesk_cost: num(v.stop), return_cost: num(v.ret),
              }))), { success: t('common.saved') })}>{t('common.save')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
