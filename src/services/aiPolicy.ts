/**
 * Decides how a native build answers an AI request.
 *
 * - "server": the request goes to the API. This needs the user's own key and a configured API address.
 *   The key is sent in X-User-AI-Key, and the platform's key is never used for native BYOK requests.
 * - "fallback": no key or no API address. The app shows the local digest or an explanation instead.
 *
 * Before BYOK, native builds always answered locally. This replaces that early return: the server is
 * used whenever it can be reached with a user key.
 */
export type NativeAiMode = 'server' | 'fallback';

export function nativeAiMode(input: { hasUserKey: boolean; apiBase: string | null }): NativeAiMode {
  return input.hasUserKey && input.apiBase ? 'server' : 'fallback';
}
