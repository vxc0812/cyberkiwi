/**
 * The one authenticated request path for the app.
 *
 * - Sends the request. On a 401 it runs ONE refresh and retries the original request ONCE.
 * - Refreshes are single-flight: concurrent requests that all see a 401 share one refresh call.
 *   Refresh tokens rotate on use, so two parallel refreshes would otherwise invalidate each other.
 * - A retry that is also a 401 is returned as it is. It never triggers a second refresh.
 * - If the refresh fails, onSessionLost runs and the 401 is returned to the caller.
 *
 * This module has no imports of its own, so it can be tested with a fake fetch and a fake refresh.
 */

export type FetchOnce = (path: string, init: RequestInit) => Promise<Response>;
export type RefreshOnce = () => Promise<boolean>;

export interface AuthRequestOptions {
  fetchOnce: FetchOnce;
  refresh: RefreshOnce;
  onSessionLost?: () => void;
}

export function createAuthenticatedRequest(options: AuthRequestOptions) {
  let inflight: Promise<boolean> | null = null;

  /** Runs at most one refresh at a time. Callers that arrive during a refresh join it. */
  function refreshSingleFlight(): Promise<boolean> {
    if (!inflight) {
      inflight = options
        .refresh()
        .catch(() => false)
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  return async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const first = await options.fetchOnce(path, init);
    if (first.status !== 401) return first;

    const refreshed = await refreshSingleFlight();
    if (!refreshed) {
      options.onSessionLost?.();
      return first;
    }

    // One retry only. Its result is returned even if it is another 401.
    return options.fetchOnce(path, init);
  };
}
