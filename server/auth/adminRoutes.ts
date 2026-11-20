/**
 * Admin routes (mounted at /api/admin). Gated by a signed-in session whose user has role ADMIN.
 * ADMIN_TOKEN is never accepted here and is never sent to the browser.
 *
 *   POST   /invites            create an invite code (shown once in the response)
 *   GET    /invites            list invites (codes are never returned)
 *   DELETE /invites/:id        revoke an invite
 *   GET    /users              list users
 *   PATCH  /users/:id          change status (ACTIVE / SUSPENDED) or role (USER / ADMIN)
 */
import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '../../generated/prisma/client';
import { createInvite, INVITE_DEFAULT_DAYS, INVITE_MAX_DAYS, INVITE_MAX_USES, listInvites, revokeInvite } from './invites';
import { principalOf, requireRole, requireUser } from './middleware';
import { revokeAllSessions } from './session';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function intIn(raw: unknown, min: number, max: number, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) return null;
  return raw;
}

export function createAdminRouter(db: PrismaClient): Router {
  const router = Router();
  router.use(requireUser, requireRole('ADMIN'));

  router.post('/invites', async (req: Request, res: Response) => {
    const maxUses = intIn(req.body?.maxUses, 1, INVITE_MAX_USES, 1);
    const expiresInDays = intIn(req.body?.expiresInDays, 1, INVITE_MAX_DAYS, INVITE_DEFAULT_DAYS);
    const cohort = req.body?.cohort === undefined || req.body?.cohort === null ? null : String(req.body.cohort).slice(0, 60);
    if (maxUses === null || expiresInDays === null) {
      return res.status(400).json({ success: false, error: 'maxUses or expiresInDays is out of range' });
    }
    const invite = await createInvite(db, { cohort, maxUses, expiresInDays, createdById: principalOf(res)!.userId });
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({
      success: true,
      code: invite.code,
      invite: { id: invite.id, cohort: invite.cohort, maxUses: invite.maxUses, expiresAt: invite.expiresAt },
    });
  });

  router.get('/invites', async (_req: Request, res: Response) => {
    return res.json({ success: true, invites: await listInvites(db) });
  });

  router.delete('/invites/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ success: false, error: 'Invite id must be a UUID' });
    const revoked = await revokeInvite(db, id);
    if (!revoked) return res.status(404).json({ success: false, error: 'Invite not found or already revoked' });
    return res.json({ success: true });
  });

  router.get('/users', async (_req: Request, res: Response) => {
    const users = await db.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, email: true, role: true, status: true, createdAt: true, lastLoginAt: true },
    });
    return res.json({ success: true, users });
  });

  router.patch('/users/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ success: false, error: 'User id must be a UUID' });
    const status = req.body?.status;
    const role = req.body?.role;
    if (status === undefined && role === undefined) {
      return res.status(400).json({ success: false, error: 'Nothing to change' });
    }
    if (status !== undefined && status !== 'ACTIVE' && status !== 'SUSPENDED') {
      return res.status(400).json({ success: false, error: 'status must be ACTIVE or SUSPENDED' });
    }
    if (role !== undefined && role !== 'USER' && role !== 'ADMIN') {
      return res.status(400).json({ success: false, error: 'role must be USER or ADMIN' });
    }
    const caller = principalOf(res)!;
    // Admins cannot suspend or demote themselves, so the last admin cannot lock the system out.
    if (id === caller.userId && (status === 'SUSPENDED' || role === 'USER')) {
      return res.status(400).json({ success: false, error: 'You cannot suspend or demote your own account here' });
    }

    const user = await db.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const updated = await db.user.update({
      where: { id },
      data: { ...(status !== undefined ? { status } : {}), ...(role !== undefined ? { role } : {}) },
      select: { id: true, email: true, role: true, status: true },
    });
    if (status === 'SUSPENDED') await revokeAllSessions(db, id);
    return res.json({ success: true, user: updated });
  });

  return router;
}
