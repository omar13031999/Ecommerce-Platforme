import type { DeliveryAdapter } from './types';
import { manualAdapter } from './adapters/manual';
import { configurableRestAdapter } from './adapters/configurable-rest';
import { ecotrackAdapter } from './adapters/ecotrack';

/**
 * Registered adapters. To add a provider-specific adapter (Yalidine, ZR
 * Express, Maystro…), implement DeliveryAdapter from
 * the provider's OFFICIAL API documentation and register it here.
 * See docs/delivery-providers.md.
 */
const ADAPTERS: Record<string, DeliveryAdapter> = {
  [manualAdapter.code]: manualAdapter,
  [ecotrackAdapter.code]: ecotrackAdapter,
  [configurableRestAdapter.code]: configurableRestAdapter,
};

export function getAdapter(code: string): DeliveryAdapter | null {
  return ADAPTERS[code] ?? null;
}

export function listAdapters(): DeliveryAdapter[] {
  return Object.values(ADAPTERS);
}
