/**
 * Push worker. Sends queued PushJob rows through FCM/APNs and records the outcome.
 *
 *   npm run worker:push                run continuously (PUSH_INTERVAL_MS, default 30 s)
 *   npm run worker:push -- --once      send what is due once, then exit
 *
 * With no provider credentials configured, jobs are retried with backoff and marked FAILED after the last attempt.
 * They are never reported as sent.
 */
import '../ingestion/loadEnv';
import { closePrisma, getPrisma } from '../db/client';
import { createPushSender } from './sender';
import { processPushJobs } from './jobs';

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const intervalMs = Number(process.env.PUSH_INTERVAL_MS || 30_000);
  const db = getPrisma();
  const sender = createPushSender();
  const status = sender.status();
  console.log(`[push] providers android=${status.android} ios=${status.ios}${status.available ? '' : ' (no provider: jobs will retry, not send)'}`);

  const cycle = async (): Promise<void> => {
    const summary = await processPushJobs(db, sender, { limit: 100 });
    console.log(`[push] claimed=${summary.claimed} sent=${summary.sent} invalid=${summary.invalid} retried=${summary.retried} failed=${summary.failed}`);
  };

  if (once) {
    await cycle();
    await closePrisma();
    return;
  }

  const timer = setInterval(() => void cycle().catch((err) => console.error('[push] cycle failed:', (err as Error).message)), intervalMs);
  await cycle().catch((err) => console.error('[push] cycle failed:', (err as Error).message));
  const shutdown = async () => {
    clearInterval(timer);
    await closePrisma();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(async (err) => {
  console.error('[push] fatal:', (err as Error).message);
  await closePrisma();
  process.exitCode = 1;
});
