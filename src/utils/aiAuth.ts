/**
 * Headers for the server's AI routes.
 *
 * - X-User-AI-Key: the user's own Gemini key, read from the key store for this request only.
 * - Authorization: the desktop app's per-launch token, when running inside Electron. Plain browsers and
 *   mobile apps have none. The token is never placed in the web bundle, in storage or in a URL.
 */
import type { AiKeyStore } from '../services/aiKeyStore';
import { getDefaultAiKeyStore } from '../services/aiKeyStoreFactory';

export const USER_AI_KEY_HEADER = 'X-User-AI-Key';

export async function aiAuthHeaders(store?: AiKeyStore): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  try {
    const desktopToken = await window.electronAPI?.getAiAccessToken?.();
    if (desktopToken) headers.Authorization = `Bearer ${desktopToken}`;
  } catch {
    // No desktop bridge: the request goes without a desktop token.
  }
  try {
    const key = await (store ?? (await getDefaultAiKeyStore())).get();
    if (key) headers[USER_AI_KEY_HEADER] = key;
  } catch {
    // A locked or unavailable key store means no BYOK header. The server then applies its own rules.
  }
  return headers;
}
