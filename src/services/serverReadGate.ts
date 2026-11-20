/**
 * Whether the app may read stored stories and articles from the CyberKiwi server right now.
 *
 * Those reads are invite-only (the server answers 401 without a session), so they wait for the
 * session to be restored on start, are skipped while signed out, and run again whenever the
 * signed-in user changes.
 *
 *   local       no CyberKiwi server is configured; the app uses its local feed adapter
 *   restoring   the session is still being restored (cookie check, or native token refresh)
 *   signed_out  restoration finished and nobody is signed in
 *   ready       a user is signed in; protected reads may run
 *   guest       the local development server allows guest reads
 */
export type ServerReadGate = 'local' | 'restoring' | 'signed_out' | 'ready' | 'guest';

export function serverReadGate(apiConfigured: boolean, authLoading: boolean, userId: string | null, localGuest = false): ServerReadGate {
  if (!apiConfigured) return 'local';
  if (localGuest) return 'guest';
  if (authLoading) return 'restoring';
  return userId ? 'ready' : 'signed_out';
}

/**
 * Identity of the reader that protected results belong to. A result is applied only if this key is
 * unchanged between starting the request and receiving the answer, so a response that arrives after
 * sign-out, or after another user signs in, is dropped. Null whenever reads are not allowed.
 */
export function readerKey(gate: ServerReadGate, userId: string | null): string | null {
  if (gate === 'guest') return 'localhost-guest';
  return gate === 'ready' && userId ? userId : null;
}
