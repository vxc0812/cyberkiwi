/**
 * Picks the key store for this platform.
 *
 * - Native: the Keychain (iOS) or Keystore (Android), through capacitor-secure-storage-plugin.
 * - Web: memory only, unless the user explicitly opts into passphrase-encrypted storage (see aiKeyService.ts).
 *
 * If the secure plugin cannot load, the store falls back to memory. It never falls back to plain storage.
 */
import { Capacitor } from '@capacitor/core';
import { type AiKeyStore, MemoryAiKeyStore, SecureValueAiKeyStore, type SecureValuePort } from './aiKeyStore';

let active: Promise<AiKeyStore> | null = null;

/** The platform's secure key-value port, or null on the web and when the plugin is unavailable. */
export async function getSecureValuePort(): Promise<SecureValuePort | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const { SecureStoragePlugin } = await import('capacitor-secure-storage-plugin');
    return {
      get: async (key) => (await SecureStoragePlugin.get({ key })).value ?? null,
      set: async (key, value) => {
        await SecureStoragePlugin.set({ key, value });
      },
      remove: async (key) => {
        await SecureStoragePlugin.remove({ key });
      },
    };
  } catch {
    return null;
  }
}

export function getDefaultAiKeyStore(): Promise<AiKeyStore> {
  active ??= (async (): Promise<AiKeyStore> => {
    const port = await getSecureValuePort();
    return port ? new SecureValueAiKeyStore(port) : new MemoryAiKeyStore();
  })();
  return active;
}

/** Replaces the active store. Used when the user opts into passphrase-encrypted web storage. */
export function setDefaultAiKeyStore(store: AiKeyStore): void {
  active = Promise.resolve(store);
}
