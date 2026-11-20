/**
 * Device registration for push notifications (mounted at /api/devices). Every route needs a signed-in user.
 *
 *   POST   /api/devices        register or refresh a device token (upserted on the token)
 *   DELETE /api/devices/:id    remove one of the user's devices
 *
 * Push tokens are never echoed back and never logged.
 */
import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '../../generated/prisma/client';
import { principalOf, requireUser } from '../auth/middleware';
import { createPushSender, type RoutingPushSender } from '../push/sender';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_DEVICES_PER_USER = 20;
const PLATFORMS = { ios: 'IOS', android: 'ANDROID', web: 'WEB' } as const;

export interface NotificationPrefs {
  breaking: boolean;
  dailyDigest: boolean;
  aiReady: boolean;
  /** Feed categories for breaking alerts. Empty means all categories. */
  categories: string[];
}

export const DEFAULT_PREFS: NotificationPrefs = { breaking: true, dailyDigest: false, aiReady: false, categories: [] };
const CATEGORY = /^[a-z0-9-]{1,40}$/;
const MAX_CATEGORIES = 20;

/** Keeps only the known boolean preferences. Anything else in the request is dropped. */
export function sanitizePrefs(raw: unknown): NotificationPrefs {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pick = (key: 'breaking' | 'dailyDigest' | 'aiReady'): boolean =>
    typeof input[key] === 'boolean' ? (input[key] as boolean) : DEFAULT_PREFS[key];
  const categories = Array.isArray(input.categories)
    ? [...new Set(input.categories.filter((c): c is string => typeof c === 'string' && CATEGORY.test(c)))].slice(0, MAX_CATEGORIES)
    : DEFAULT_PREFS.categories;
  return { breaking: pick('breaking'), dailyDigest: pick('dailyDigest'), aiReady: pick('aiReady'), categories };
}

export function createDevicesRouter(db: PrismaClient, sender: RoutingPushSender = createPushSender()): Router {
  const router = Router();
  router.use(requireUser);

  /** Which push providers are configured. Booleans only, no credentials. */
  router.get('/status', (_req: Request, res: Response) => res.json({ success: true, push: sender.status() }));

  router.post('/', async (req: Request, res: Response) => {
    const platform = typeof req.body?.platform === 'string' ? PLATFORMS[req.body.platform.toLowerCase() as keyof typeof PLATFORMS] : undefined;
    const pushToken = req.body?.pushToken;
    const appVersion = req.body?.appVersion;
    if (!platform) return res.status(400).json({ success: false, error: 'platform must be ios, android or web' });
    if (typeof pushToken !== 'string' || pushToken.length < 16 || pushToken.length > 4096) {
      return res.status(400).json({ success: false, error: 'pushToken is not valid' });
    }
    if (typeof appVersion !== 'string' || appVersion.length === 0 || appVersion.length > 40) {
      return res.status(400).json({ success: false, error: 'appVersion is required (max 40 characters)' });
    }

    const userId = principalOf(res)!.userId;
    const existing = await db.device.findUnique({ where: { pushToken }, select: { id: true, userId: true } });
    if (!existing || existing.userId !== userId) {
      const count = await db.device.count({ where: { userId, revokedAt: null } });
      if (count >= MAX_DEVICES_PER_USER) {
        return res.status(409).json({ success: false, error: 'Too many devices. Remove one and try again.' });
      }
    }

    const now = new Date();
    const prefs = sanitizePrefs(req.body?.notificationPrefs);
    const device = await db.device.upsert({
      where: { pushToken },
      create: { userId, platform, pushToken, appVersion: appVersion.slice(0, 40), notificationPrefs: { ...prefs }, lastSeenAt: now },
      update: { userId, platform, appVersion: appVersion.slice(0, 40), notificationPrefs: { ...prefs }, lastSeenAt: now, revokedAt: null },
      select: { id: true, platform: true, appVersion: true, notificationPrefs: true, createdAt: true },
    });
    const available = platform === 'ANDROID' ? sender.status().android : platform === 'IOS' ? sender.status().ios : false;
    // Registration is stored either way. pushAvailable says whether notifications can reach this device yet.
    return res.status(existing ? 200 : 201).json({ success: true, device, pushAvailable: available });
  });

  /** Changes notification preferences for one of the user's devices. Only the known keys are stored. */
  router.patch('/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ success: false, error: 'Device id must be a UUID' });
    const incoming = req.body?.notificationPrefs;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ success: false, error: 'notificationPrefs is required' });
    }
    const userId = principalOf(res)!.userId;
    const current = await db.device.findFirst({ where: { id, userId }, select: { notificationPrefs: true } });
    if (!current) return res.status(404).json({ success: false, error: 'Device not found' });
    const prefs = sanitizePrefs({ ...((current.notificationPrefs as object) ?? {}), ...incoming });
    await db.device.update({ where: { id }, data: { notificationPrefs: { ...prefs } } });
    return res.json({ success: true, notificationPrefs: prefs });
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ success: false, error: 'Device id must be a UUID' });
    const result = await db.device.deleteMany({ where: { id, userId: principalOf(res)!.userId } });
    if (result.count !== 1) return res.status(404).json({ success: false, error: 'Device not found' });
    return res.json({ success: true });
  });

  return router;
}
