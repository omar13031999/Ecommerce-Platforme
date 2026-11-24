import type { DeliveryAdapter } from './types';
import { manualAdapter } from './adapters/manual';
import { configurableRestAdapter } from './adapters/configurable-rest';

/**
 * Registered adapters. To add a provider-specific adapter (Yalidine, ZR
 * Express, Maystro, Ecotrack-based companies…), implement DeliveryAdapter from
 * the provider's OFFICIAL API documentation and register it here.
 * See docs/delivery-providers.md.
 */
const ADAPTERS: Record<string, DeliveryAdapter> = {
  [manualAdapter.code]: manualAdapter,
  [configurableRestAdapter.code]: configurableRestAdapter,
};

export function getAdapter(code: string): DeliveryAdapter | null {
  return ADAPTERS[code] ?? null;
}

export function listAdapters(): DeliveryAdapter[] {
  return Object.values(ADAPTERS);
}
