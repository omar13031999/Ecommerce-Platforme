/**
 * Permission catalogue. MUST stay in sync with public.all_permissions() /
 * public.role_default_permissions() in the database (which is the real
 * enforcement layer — this file only drives navigation and early checks).
 */
export const PERMISSIONS = [
  'orders.view_all',
  'orders.manage',
  'orders.assign',
  'orders.create',
  'orders.export',
  'team.view',
  'team.manage',
  'delivery.view',
  'delivery.manage',
  'products.manage',
  'reports.operational',
  'finance.view',
  'finance.manage',
  'expenses.manage',
  'ads.view',
  'ads.manage',
  'integrations.manage',
  'settings.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Role = 'admin' | 'manager' | 'agent';

/** Financial / owner-level permissions: only an admin may grant them. */
export const SENSITIVE_PERMISSIONS: readonly Permission[] = [
  'finance.view',
  'finance.manage',
  'expenses.manage',
  'ads.view',
  'ads.manage',
  'integrations.manage',
  'settings.manage',
];

const MANAGER_DEFAULTS: readonly Permission[] = [
  'orders.view_all',
  'orders.manage',
  'orders.assign',
  'orders.create',
  'orders.export',
  'team.view',
  'team.manage',
  'delivery.view',
  'delivery.manage',
  'reports.operational',
];

export function roleDefaultPermissions(role: Role): readonly Permission[] {
  if (role === 'admin') return PERMISSIONS;
  if (role === 'manager') return MANAGER_DEFAULTS;
  return [];
}

export function effectivePermissions(role: Role, extra: readonly string[]): Set<Permission> {
  const set = new Set<Permission>(roleDefaultPermissions(role));
  for (const p of extra) if ((PERMISSIONS as readonly string[]).includes(p)) set.add(p as Permission);
  return set;
}

export function isPermission(v: string): v is Permission {
  return (PERMISSIONS as readonly string[]).includes(v);
}
