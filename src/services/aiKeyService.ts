/**
 * What the Settings screen does with the user's Gemini key. The UI never receives the key itself:
 * it asks whether a key exists, saves or clears one, and asks the server whether one works.
 *
 * A key is saved only after the server confirms it. A rejected key is never stored.
 */
import { apiFetch } from './apiClient';
import { PassphraseAiKeyStore, type AiKeyStore } from './aiKeyStore';
import { getDefaultAiKeyStore, setDefaultAiKeyStore } from './aiKeyStoreFactory';
import { USER_AI_KEY_HEADER } from '../utils/aiAuth';
import { Capacitor } from '@capacitor/core';

const KEY_SHAPE = /^AIza[0-9A-Za-z_-]{35}$/;

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: 'format' | 'invalid_key' | 'rate_limited' | 'unavailable' | 'network' | 'missing' };

export function describeValidation(result: ValidationResult): string {
  if (result.valid === true) return 'Key works. It is ready to use.';
  switch (result.reason) {
    case 'format': return 'That does not look like a Google Gemini API key.';
    case 'invalid_key': return 'Google rejected this key. Check it in Google AI Studio and try again.';
    case 'rate_limited': return 'Too many checks. Wait a minute and try again.';
    case 'unavailable': return 'The key could not be checked right now. Try again later.';
    case 'network': return 'Could not reach the CyberKiwi server.';
    case 'missing': return 'No key is saved on this device.';
  }
}

/** Asks the server to test a key with one minimal call. The key travels only in the request header. */
export async function validateAiKey(key: string): Promise<ValidationResult> {
  const clean = key.trim();
  if (!KEY_SHAPE.test(clean)) return { valid: false, reason: 'format' };
  try {
    const res = await apiFetch('/api/gemini/validate-key', {
      method: 'POST',
      headers: { [USER_AI_KEY_HEADER]: clean },
    });
    const body = (await res.json().catch(() => ({}))) as { valid?: boolean; error?: string };
    if (body.valid === true) return { valid: true };
    if (body.error === 'invalid_key') return { valid: false, reason: 'invalid_key' };
    if (body.error === 'rate_limited' || res.status === 429) return { valid: false, reason: 'rate_limited' };
    if (res.status === 400) return { valid: false, reason: 'format' };
    return { valid: false, reason: 'unavailable' };
  } catch {
    return { valid: false, reason: 'network' };
  }
}

/** Whether a key is stored. The key itself is not read into the caller. */
export async function hasAiKey(): Promise<boolean> {
  return (await getDefaultAiKeyStore()).has();
}

/** Validates first, then stores. A key the server rejects is never saved. */
export async function saveAiKey(key: string): Promise<ValidationResult> {
  const result = await validateAiKey(key);
  if (!result.valid) return result;
  await (await getDefaultAiKeyStore()).set(key.trim());
  return result;
}

/** Validates the stored key without returning it to the caller. */
export async function validateStoredAiKey(): Promise<ValidationResult> {
  const store: AiKeyStore = await getDefaultAiKeyStore();
  const key = await store.get();
  if (!key) return { valid: false, reason: 'missing' };
  return validateAiKey(key);
}

export async function clearAiKey(): Promise<void> {
  await (await getDefaultAiKeyStore()).clear();
}

const WEB_PASSPHRASE_KEY = 'cyberkiwi.ai-key.v1';

function webStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** True on the web when a passphrase-encrypted key is stored and still needs unlocking. */
export function storedKeyNeedsPassphrase(): boolean {
  const storage = webStorage();
  if (Capacitor.isNativePlatform() || !storage) return false;
  return new PassphraseAiKeyStore(storage, WEB_PASSPHRASE_KEY).hasStoredKey();
}

/**
 * Web only, and only when the user asks for it. The key is encrypted with a key derived from the
 * passphrase. Without the passphrase, the stored value is useless to anyone reading localStorage.
 */
export async function enablePassphraseStorage(passphrase: string, key?: string): Promise<void> {
  const storage = webStorage();
  if (!storage) throw new Error('Browser storage is not available');
  const store = new PassphraseAiKeyStore(storage, WEB_PASSPHRASE_KEY);
  await store.unlock(passphrase);
  if (key) await store.set(key.trim());
  setDefaultAiKeyStore(store);
}

/** Unlocks an encrypted key stored earlier. Returns false when no key is stored. */
export async function unlockStoredKey(passphrase: string): Promise<boolean> {
  const storage = webStorage();
  if (!storage) return false;
  const store = new PassphraseAiKeyStore(storage, WEB_PASSPHRASE_KEY);
  await store.unlock(passphrase);
  if (!store.hasStoredKey()) return false;
  setDefaultAiKeyStore(store);
  return true;
}
