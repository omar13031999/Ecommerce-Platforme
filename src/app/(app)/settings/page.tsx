import { getTranslations } from 'next-intl/server';
import { requirePage } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { SettingsForms } from './settings-client';

export default async function SettingsPage() {
  await requirePage('settings.manage');
  const t = await getTranslations('settings');
  const supabase = await createClient();
  const [{ data: settings }, { data: providers }] = await Promise.all([
    supabase.from('app_settings').select('key, value'),
    supabase.from('delivery_providers').select('id, name').eq('is_active', true).order('name'),
  ]);
  const values = Object.fromEntries((settings ?? []).map((s) => [s.key, s.value])) as Record<string, Record<string, unknown>>;
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t('title')} />
      <SettingsForms values={values} providers={providers ?? []} />
    </div>
  );
}
