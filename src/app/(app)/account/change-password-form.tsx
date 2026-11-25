'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAction } from '@/components/app/use-action';
import { changePassword } from '@/lib/actions/auth';

export function ChangePasswordForm() {
  const t = useTranslations('account');
  const { run, pending } = useAction();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm.length > 0 && password !== confirm;
  return (
    <Card>
      <CardHeader><CardTitle>{t('changePassword')}</CardTitle></CardHeader>
      <CardContent>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => changePassword({ password, confirm }), { success: t('changed'), onSuccess: () => { setPassword(''); setConfirm(''); } });
          }}
        >
          <div className="grid gap-1.5"><Label htmlFor="pw">{t('newPassword')}</Label><Input id="pw" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" /></div>
          <div className="grid gap-1.5"><Label htmlFor="pw2">{t('confirmPassword')}</Label><Input id="pw2" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} dir="ltr" /></div>
          <p className="text-xs text-muted-foreground">{t('hint')}</p>
          {mismatch ? <p className="text-xs text-destructive">{t('mismatch')}</p> : null}
          <Button type="submit" disabled={pending || mismatch || password.length < 10}>{t('save')}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
