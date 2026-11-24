'use client';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { ActionResult } from '@/lib/errors';

/**
 * Runs a server action, shows a translated toast on error/success and refreshes
 * server components on success.
 */
export function useAction() {
  const [pending, start] = useTransition();
  const router = useRouter();
  const t = useTranslations();

  function errorMessage(code: string, extra?: Record<string, string>) {
    const key = `errors.${code}`;
    return t.has(key) ? t(key, extra) : t('errors.unknown');
  }

  function run<T>(
    action: () => Promise<ActionResult<T>>,
    opts: { success?: string | ((data: T | undefined) => string); onSuccess?: (data: T | undefined) => void; refresh?: boolean } = {},
  ) {
    start(async () => {
      try {
        const res = await action();
        if (!res.ok) {
          const fields = res.fieldErrors ? Object.keys(res.fieldErrors).map((f) => (t.has(`fields.${f}`) ? t(`fields.${f}`) : f)).join(', ') : '';
          toast.error(errorMessage(res.error, { fields, columns: fields }));
          return;
        }
        if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(res.data) : opts.success);
        opts.onSuccess?.(res.data);
        if (opts.refresh !== false) router.refresh();
      } catch {
        toast.error(t('errors.unknown'));
      }
    });
  }
  return { pending, run, errorMessage };
}
