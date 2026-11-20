/**
 * Account state for the app: who is signed in, and the login, register, logout and refresh actions.
 *
 * On start it restores the session. On native it also re-checks the session whenever the app resumes
 * from the background (Capacitor App lifecycle). Background refresh is not used.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import * as auth from '../services/authClient';
import { onSessionLost } from '../services/apiClient';
import type { AuthUser } from '../services/authClient';
import { enablePush } from '../services/pushRegistration';

export interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, inviteCode: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<boolean>;
  me: () => Promise<AuthUser | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const me = useCallback(async () => {
    const current = await auth.fetchMe();
    setUser(current);
    return current;
  }, []);

  const refresh = useCallback(async () => {
    const ok = await auth.refreshSession();
    if (ok) await me();
    return ok;
  }, [me]);

  useEffect(() => {
    let cancelled = false;
    auth.restoreSession().then((current) => {
      if (!cancelled) setUser(current);
    }).finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    const unsubscribe = onSessionLost(() => setUser(null));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Native: register for push once a user is signed in. Without a configured provider this reports "unavailable".
  useEffect(() => {
    if (user && Capacitor.isNativePlatform()) void enablePush();
  }, [user]);

  // Native: check the session again each time the app comes back to the foreground.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let handle: { remove: () => Promise<void> } | null = null;
    App.addListener('resume', () => {
      void refresh();
    }).then((h) => {
      handle = h;
    });
    return () => {
      void handle?.remove();
    };
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    setUser(await auth.login(email, password));
  }, []);

  const register = useCallback(async (email: string, password: string, inviteCode: string) => {
    await auth.register(email, password, inviteCode);
    // Registration does not sign the user in. They log in next.
  }, []);

  const logout = useCallback(async () => {
    await auth.logout();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, isLoading, login, register, logout, refresh, me }),
    [user, isLoading, login, register, logout, refresh, me]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
