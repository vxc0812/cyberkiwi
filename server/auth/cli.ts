/**
 * Operator commands for accounts. Run from the server machine, with DATABASE_URL set.
 *
 *   npm run auth:invite -- [--cohort name] [--max-uses 1] [--days 14]   prints a one-time invite code
 *   npm run auth:promote -- <email>                                     gives an existing user the ADMIN role
 *
 * There is no web route that creates the first admin. Create an invite here, register, then promote.
 */
import '../ingestion/loadEnv';
import { closePrisma, getPrisma } from '../db/client';
import { createInvite, INVITE_MAX_DAYS, INVITE_MAX_USES } from './invites';
import { normalizeEmail } from './password';

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  const db = getPrisma();

  if (command === 'invite') {
    const maxUses = Number(flag(args, '--max-uses') ?? 1);
    const days = Number(flag(args, '--days') ?? 14);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > INVITE_MAX_USES) {
      console.error(`--max-uses must be an integer from 1 to ${INVITE_MAX_USES}`);
      return 1;
    }
    if (!Number.isInteger(days) || days < 1 || days > INVITE_MAX_DAYS) {
      console.error(`--days must be an integer from 1 to ${INVITE_MAX_DAYS}`);
      return 1;
    }
    const invite = await createInvite(db, { cohort: flag(args, '--cohort') ?? null, maxUses, expiresInDays: days });
    console.log('Invite code (shown once; only its hash is stored):');
    console.log(invite.code);
    console.log(`expires ${invite.expiresAt.toISOString()}, max uses ${invite.maxUses}`);
    return 0;
  }

  if (command === 'promote') {
    const email = normalizeEmail(args[0]);
    if (!email) {
      console.error('Usage: auth:promote -- <email>');
      return 1;
    }
    const result = await db.user.updateMany({ where: { email }, data: { role: 'ADMIN' } });
    if (result.count !== 1) {
      console.error('No user with that email. Register first, then promote.');
      return 1;
    }
    console.log(`${email} is now an admin. Existing sessions keep working until they expire.`);
    return 0;
  }

  console.error('Commands: invite [--cohort n] [--max-uses n] [--days n] | promote <email>');
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('[auth] failed:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closePrisma());
