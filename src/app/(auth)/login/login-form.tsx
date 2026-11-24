'use client';
import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { signIn } from '@/lib/actions/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function LoginForm({ next }: { next: string }) {
  const t = useTranslations('auth');
  const [state, action, pending] = useActionState(signIn, null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-4">
          <input type="hidden" name="next" value={next} />
          <div className="grid gap-1.5">
            <Label htmlFor="email">{t('email')}</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required dir="ltr" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="password">{t('password')}</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required dir="ltr" />
          </div>
          {state?.error ? <p role="alert" className="text-sm text-destructive">{t(state.error)}</p> : null}
          <Button type="submit" disabled={pending}>{pending ? '…' : t('signIn')}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
