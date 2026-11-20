/**
 * Registers this device for push notifications, after sign-in.
 *
 * The Capacitor plugin only gives the app a device token. Sending needs the server: the token is posted to
 * POST /api/devices, and the server sends through FCM (Android) or APNs (iOS), when those are configured.
 * When they are not, the state is "unavailable". It is never reported as "registered" without a provider.
 */
import { Capacitor } from '@capacitor/core';
import { apiFetch, authedFetch } from './apiClient';

export type PushState = 'unsupported' | 'unavailable' | 'denied' | 'registered' | 'error';

export interface NotificationPrefs {
  breaking: boolean;
  dailyDigest: boolean;
  aiReady: boolean;
}

export const DEFAULT_PUSH_PREFS: NotificationPrefs = { breaking: true, dailyDigest: false, aiReady: false };

const APP_VERSION = (import.meta as any).env?.VITE_APP_VERSION ?? '0.0.0';

/** Which providers the server has configured. Null when the server cannot be reached. */
export async function pushProviderStatus(): Promise<{ android: boolean; ios: boolean } | null> {
  try {
    const res = await apiFetch('/api/devices/status');
    if (!res.ok) return null;
    const body = (await res.json()) as { push?: { android: boolean; ios: boolean } };
    return body.push ?? null;
  } catch {
    return null;
  }
}

export async function enablePush(prefs: NotificationPrefs = DEFAULT_PUSH_PREFS): Promise<PushState> {
  if (!Capacitor.isNativePlatform()) return 'unsupported';
  const platform = Capacitor.getPlatform();
  if (platform !== 'ios' && platform !== 'android') return 'unsupported';

  const providers = await pushProviderStatus();
  if (!providers || !providers[platform]) return 'unavailable';

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') return 'denied';

    await PushNotifications.removeAllListeners();
    await PushNotifications.addListener('registration', async ({ value }) => {
      // The token is sent once per registration and never logged.
      await authedFetch('/api/devices', {
        method: 'POST',
        body: JSON.stringify({ platform, pushToken: value, appVersion: APP_VERSION, notificationPrefs: prefs }),
      });
    });
    await PushNotifications.addListener('registrationError', () => undefined);
    await PushNotifications.register();
    return 'registered';
  } catch {
    return 'error';
  }
}
