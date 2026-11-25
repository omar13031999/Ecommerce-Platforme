import { getTranslations } from 'next-intl/server';
import { requirePage } from '@/lib/auth/session';
import { PageHeader } from '@/components/app/page-header';
import { ChangePasswordForm } from './change-password-form';

export default async function AccountPage() {
  const session = await requirePage();
  const t = await getTranslations('account');
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title={t('title')} description={session.profile.email ?? ''} />
      <ChangePasswordForm />
    </div>
  );
}
