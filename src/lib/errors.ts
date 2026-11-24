import { ZodError } from 'zod';

/**
 * Centralised error handling. Errors carry a stable `code` translated in the UI
 * (messages.errors.*). Raw database / provider messages are never shown to
 * users; they are logged server-side.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(code);
    this.name = 'AppError';
  }
}

/** Business error codes raised by our SQL functions (`raise exception '<code>'`). */
const KNOWN_DB_CODES = new Set([
  'not_authenticated', 'forbidden', 'forbidden_target', 'forbidden_role', 'forbidden_permissions',
  'order_not_found', 'not_assigned', 'stale_version', 'order_in_delivery', 'invalid_transition',
  'capacity_exceeded', 'agent_unavailable', 'unknown_permission', 'last_admin', 'cannot_modify_self',
  'user_not_found', 'order_not_confirmed', 'order_already_submitted', 'submission_in_progress',
  'missing_items', 'missing_external_id', 'item_not_found', 'note_too_long',
]);

type PgLikeError = { code?: string; message?: string; details?: string; hint?: string };

export function fromDbError(error: PgLikeError | null | undefined): AppError {
  if (!error) return new AppError('unknown');
  const msg = error.message ?? '';
  if (KNOWN_DB_CODES.has(msg)) {
    return new AppError(msg, msg.startsWith('forbidden') || msg === 'not_assigned' ? 403 : 400);
  }
  if (error.code === '42501') return new AppError('forbidden', 403);
  if (error.code === '23505') return new AppError('duplicate', 409);
  if (error.code === '23503') return new AppError('in_use', 409);
  if (error.code === '23514' || error.code === '22P02' || error.code === '22023') return new AppError('invalid_input', 400);
  console.error('[db]', error);
  return new AppError('unknown', 500);
}

export type ActionResult<T = undefined> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[] | undefined> };

/** Wrap a server action body: validation/authorization errors become results. */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ZodError) {
      return { ok: false, error: 'invalid_input', fieldErrors: e.flatten().fieldErrors as Record<string, string[]> };
    }
    if (e instanceof AppError) {
      return { ok: false, error: e.code, fieldErrors: e.details as Record<string, string[]> | undefined };
    }
    // Next.js redirect()/notFound() must propagate
    if (e && typeof e === 'object' && 'digest' in e && String((e as { digest: unknown }).digest).startsWith('NEXT_')) throw e;
    console.error('[action]', e);
    return { ok: false, error: 'unknown' };
  }
}
