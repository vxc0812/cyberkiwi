/**
 * Invite codes for invite-only registration. Codes are shown once at creation; only their SHA-256 is stored.
 */
import type { PrismaClient } from '../../generated/prisma/client';
import { randomToken, sha256Hex } from './session';

export const INVITE_DEFAULT_DAYS = 14;
export const INVITE_MAX_DAYS = 90;
export const INVITE_MAX_USES = 100;
const CODE_MIN_LENGTH = 16;
const CODE_MAX_LENGTH = 200;

export function hashInviteCode(code: string): string {
  return sha256Hex(code.trim());
}

/** Shape check before any database work. Codes are random tokens, so anything else is rejected. */
export function plausibleInviteCode(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.trim().length >= CODE_MIN_LENGTH && raw.trim().length <= CODE_MAX_LENGTH;
}

export async function createInvite(
  db: PrismaClient,
  input: { cohort?: string | null; maxUses?: number; expiresInDays?: number; createdById?: string | null; now?: Date }
): Promise<{ id: string; code: string; expiresAt: Date; maxUses: number; cohort: string | null }> {
  const now = input.now ?? new Date();
  const days = input.expiresInDays ?? INVITE_DEFAULT_DAYS;
  const maxUses = input.maxUses ?? 1;
  const code = randomToken(18);
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const row = await db.inviteCode.create({
    data: {
      codeHash: hashInviteCode(code),
      cohort: input.cohort ?? null,
      maxUses,
      expiresAt,
      createdById: input.createdById ?? null,
      createdAt: now,
    },
    select: { id: true, cohort: true, maxUses: true, expiresAt: true },
  });
  return { id: row.id, code, expiresAt: row.expiresAt, maxUses: row.maxUses, cohort: row.cohort };
}

export async function listInvites(db: PrismaClient, limit = 100) {
  return db.inviteCode.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, cohort: true, maxUses: true, usedCount: true, expiresAt: true, revokedAt: true, createdAt: true },
  });
}

export async function revokeInvite(db: PrismaClient, id: string, now: Date = new Date()): Promise<boolean> {
  const result = await db.inviteCode.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } });
  return result.count === 1;
}

/**
 * Uses one invite inside a transaction. The UPDATE is conditional, so two concurrent registrations
 * cannot both consume the last use. Returns the invite id, or null when the code is unknown,
 * revoked, expired or used up.
 */
export async function redeemInvite(
  tx: Pick<PrismaClient, '$queryRaw'>,
  code: string,
  now: Date = new Date()
): Promise<string | null> {
  const hash = hashInviteCode(code);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "InviteCode"
       SET "usedCount" = "usedCount" + 1
     WHERE "codeHash" = ${hash}
       AND "revokedAt" IS NULL
       AND "expiresAt" > ${now}
       AND "usedCount" < "maxUses"
    RETURNING "id"`;
  return rows[0]?.id ?? null;
}
