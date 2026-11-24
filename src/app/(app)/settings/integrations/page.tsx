import { getLocale, getTranslations } from 'next-intl/server';
import { requirePage } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { isGoogleConfigured, isMetaConfigured } from '@/lib/env';
import { listAdapters } from '@/lib/integrations/delivery/registry';
import { PageHeader } from '@/components/app/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatDateTime, type AppLocale } from '@/lib/format';
import { ConnectionActions, MetaImportButton, ProviderEditor, ProviderTools, SourceActions, SourceEditor } from './integrations-client';

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ error?: string; connected?: string }> }) {
  const session = await requirePage('integrations.manage');
  const sp = await searchParams;
  const t = await getTranslations();
  const locale = (await getLocale()) as AppLocale;
  const supabase = await createClient();
  const [{ data: connections }, { data: sources }, { data: providers }, { data: runs }, { data: importErrors }, { data: mappings }, { data: wilayas }, ratesRes] = await Promise.all([
    supabase.from('integration_connections').select('id, provider, account_label, status, expires_at, last_error, connected_at').neq('status', 'revoked').order('connected_at', { ascending: false }),
    supabase.from('sheet_sources').select('*').order('created_at'),
    supabase.from('delivery_providers').select('id, code, name, is_active, base_url, config, webhook_enabled, webhook_token, polling_enabled, polling_interval_minutes, tracking_url_template, credentials_configured, last_test_at, last_test_ok, last_polled_at').order('name'),
    supabase.from('sync_runs').select('id, kind, target_id, trigger, status, started_at, finished_at, stats, error').order('started_at', { ascending: false }).limit(30),
    supabase.from('sheet_import_errors').select('id, source_id, row_number, external_id, error, created_at').order('created_at', { ascending: false }).limit(30),
    supabase.from('delivery_status_mappings').select('id, provider_id, provider_status, internal_status'),
    supabase.from('wilayas').select('code, name_fr, name_ar').order('code'),
    session.can('finance.view') ? supabase.from('delivery_rates').select('provider_id, wilaya_code, home_cost, stopdesk_cost, return_cost') : Promise.resolve({ data: [] }),
  ]);
  const google = (connections ?? []).filter((c) => c.provider === 'google');
  const meta = (connections ?? []).filter((c) => c.provider === 'meta');
  const appUrl = process.env.APP_URL ?? '';
  const adapters = listAdapters().map((a) => ({ code: a.code, integrationLevel: a.integrationLevel, credentialFields: a.credentialFields.map((f) => ({ key: f.key, labelKey: f.labelKey, required: f.required })) }));
  const sourceName = Object.fromEntries((sources ?? []).map((s) => [s.id, s.name]));
  const conn = (c: NonNullable<typeof connections>[number]) => (
    <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
      <div>
        <div className="font-medium">{t('integrations.connectedAs', { account: c.account_label ?? '—' })}</div>
        <div className="text-xs text-muted-foreground">{formatDateTime(c.connected_at, locale)}{c.expires_at ? ` → ${formatDateTime(c.expires_at, locale)}` : ''}</div>
        {c.status !== 'connected' ? <div className="text-xs text-destructive">{t('integrations.connectionExpired')}</div> : null}
      </div>
      <ConnectionActions id={c.id} provider={c.provider as 'google' | 'meta'} />
    </div>
  );

  return (
    <div className="grid gap-5">
      <PageHeader title={t('integrations.title')} />
      {sp.error ? <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">{sp.error === 'integration_not_configured' ? t('errors.integration_not_configured') : t('integrations.oauthError')}</p> : null}
      {sp.connected ? <p className="rounded-md border border-success/40 bg-success/10 p-3 text-sm">{t('integrations.connectedOk')}</p> : null}

      <Card>
        <CardHeader><CardTitle>{t('integrations.google')}</CardTitle><CardDescription>{t('integrations.googleHelp')}</CardDescription></CardHeader>
        <CardContent className="grid gap-4">
          {!isGoogleConfigured() ? <p className="text-sm text-warning">{t('integrations.googleNotConfigured')}</p> : (
            <div className="grid gap-2">
              {google.map(conn)}
              <a className="inline-flex h-9 w-fit items-center rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-primary/90" href="/api/oauth/google/start">{google.length ? t('common.reconnect') : t('common.connect')} Google</a>
            </div>
          )}
          <div className="flex items-center justify-between">
            <h3 className="font-medium">{t('integrations.sources')}</h3>
            {google.some((c) => c.status === 'connected') ? <SourceEditor connections={google.filter((c) => c.status === 'connected').map((c) => ({ id: c.id, label: c.account_label ?? '' }))} /> : null}
          </div>
          <Table>
            <THead><TR><TH>{t('common.name')}</TH><TH>{t('integrations.worksheet')}</TH><TH>{t('integrations.syncEnabled')}</TH><TH>{t('common.lastSync')}</TH><TH /></TR></THead>
            <TBody>
              {(sources ?? []).map((s) => (
                <TR key={s.id}>
                  <TD className="font-medium">{s.name}</TD>
                  <TD className="text-xs">{s.worksheet_title}</TD>
                  <TD>{s.sync_enabled ? `${s.sync_interval_minutes} ${t('common.minutes')}` : t('common.disabled')}</TD>
                  <TD className="text-xs">
                    {s.last_synced_at ? formatDateTime(s.last_synced_at, locale) : t('common.never')}
                    {s.last_sync_status ? <Badge className={s.last_sync_status === 'success' ? 'ms-1 bg-green-50 text-green-700 ring-green-200' : 'ms-1 bg-red-50 text-red-700 ring-red-200'}>{t(`common.${s.last_sync_status as 'success'}`)}</Badge> : null}
                    {s.last_sync_error ? <div className="max-w-xs truncate text-destructive" title={s.last_sync_error}>{s.last_sync_error}</div> : null}
                  </TD>
                  <TD><SourceActions source={s} connections={google.map((c) => ({ id: c.id, label: c.account_label ?? '' }))} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {importErrors?.length ? (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">{t('integrations.importErrors')} ({importErrors.length})</summary>
              <Table><TBody>{importErrors.map((e) => (
                <TR key={e.id}><TD className="text-xs">{sourceName[e.source_id]}</TD><TD className="text-xs">#{e.row_number} {e.external_id}</TD><TD className="text-xs text-destructive">{e.error}</TD><TD className="text-xs">{formatDateTime(e.created_at, locale)}</TD></TR>
              ))}</TBody></Table>
            </details>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div><CardTitle>{t('integrations.deliveryProviders')}</CardTitle><CardDescription>{t('integrations.documentedWarning')}</CardDescription></div>
          <ProviderEditor adapters={adapters} appUrl={appUrl} />
        </CardHeader>
        <CardContent className="grid gap-3">
          {(providers ?? []).map((p) => (
            <div key={p.id} className="grid gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">{p.name}</span> <Badge className="bg-muted text-muted-foreground ring-border">{t(`integrations.adapter_${p.code}` as 'integrations.adapter_manual')}</Badge>
                  {!p.is_active ? <Badge className="ms-1 bg-zinc-100 text-zinc-600 ring-zinc-200">{t('common.inactive')}</Badge> : null}
                  <div className="text-xs text-muted-foreground">
                    {p.credentials_configured ? t('integrations.credentialsSet') : null}
                    {p.last_test_at ? ` · ${t('integrations.lastTest')}: ${formatDateTime(p.last_test_at, locale)} ${p.last_test_ok ? '✓' : '✗'}` : ''}
                    {p.last_polled_at ? ` · ${t('common.lastSync')}: ${formatDateTime(p.last_polled_at, locale)}` : ''}
                  </div>
                  {p.webhook_enabled ? <div className="mt-1 font-mono text-[11px] text-muted-foreground" dir="ltr">{appUrl}/api/webhooks/delivery/{p.id}/{p.webhook_token}</div> : null}
                </div>
                <div className="flex gap-1">
                  <ProviderEditor adapters={adapters} appUrl={appUrl} provider={{ ...p, config: JSON.stringify(p.config ?? {}, null, 2) }} />
                </div>
              </div>
              <ProviderTools
                providerId={p.id}
                code={p.code}
                mappings={(mappings ?? []).filter((m) => m.provider_id === p.id)}
                canRates={session.can('finance.manage')}
                rates={(ratesRes.data ?? []).filter((r) => r.provider_id === p.id)}
                wilayas={(wilayas ?? []).map((w) => ({ code: w.code, name: locale === 'ar' ? w.name_ar : w.name_fr }))}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('integrations.meta')}</CardTitle><CardDescription>{t('integrations.metaHelp')}</CardDescription></CardHeader>
        <CardContent className="grid gap-2">
          {!isMetaConfigured() ? <p className="text-sm text-warning">{t('integrations.metaNotConfigured')}</p> : (
            <>
              {meta.map((c) => (
                <div key={c.id} className="grid gap-2">
                  {conn(c)}
                  {c.status === 'connected' && session.can('ads.manage') ? <MetaImportButton connectionId={c.id} /> : null}
                </div>
              ))}
              <a className="inline-flex h-9 w-fit items-center rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-primary/90" href="/api/oauth/meta/start">{meta.length ? t('common.reconnect') : t('ads.connectMeta')}</a>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('integrations.logs')}</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead><TR><TH>{t('common.type')}</TH><TH>{t('common.status')}</TH><TH>{t('common.date')}</TH><TH>{t('common.result')}</TH></TR></THead>
            <TBody>
              {(runs ?? []).map((r) => (
                <TR key={r.id}>
                  <TD className="text-xs">{r.kind}{r.target_id && sourceName[r.target_id] ? ` · ${sourceName[r.target_id]}` : ''} <span className="text-muted-foreground">({r.trigger})</span></TD>
                  <TD><Badge className={r.status === 'success' ? 'bg-green-50 text-green-700 ring-green-200' : r.status === 'running' ? 'bg-blue-50 text-blue-700 ring-blue-200' : r.status === 'partial' ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-red-50 text-red-700 ring-red-200'}>{t(`common.${r.status as 'success'}`)}</Badge></TD>
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(r.started_at, locale)}</TD>
                  <TD className="max-w-[420px] truncate font-mono text-[11px]" title={r.error ?? JSON.stringify(r.stats)}>{r.error ?? JSON.stringify(r.stats)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
