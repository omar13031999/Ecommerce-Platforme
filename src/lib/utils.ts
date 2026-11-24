import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function toNumber(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Escape user text for PostgREST `ilike` / `or()` filters. */
export function escapeFilter(v: string): string {
  return v.replace(/[%_\\]/g, (m) => `\\${m}`).replace(/[,()]/g, ' ').trim();
}
