import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptSecret, encryptSecret } from '@/lib/crypto';

type OwnerType = 'connection' | 'delivery_provider';

export async function getSecret<T = Record<string, string>>(ownerType: OwnerType, ownerId: string): Promise<T | null> {
  const { data, error } = await createAdminClient()
    .from('integration_secrets')
    .select('ciphertext')
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return JSON.parse(decryptSecret(data.ciphertext)) as T;
}

export async function setSecret(ownerType: OwnerType, ownerId: string, value: unknown): Promise<void> {
  const { error } = await createAdminClient()
    .from('integration_secrets')
    .upsert({ owner_type: ownerType, owner_id: ownerId, ciphertext: encryptSecret(JSON.stringify(value)), updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function deleteSecret(ownerType: OwnerType, ownerId: string): Promise<void> {
  await createAdminClient().from('integration_secrets').delete().eq('owner_type', ownerType).eq('owner_id', ownerId);
}
