/**
 * Worker process entry point.
 *
 *   npm run worker:ingest            run continuously (WORKER_INTERVAL_MS, default 5 min)
 *   npm run worker:once              run one cycle and exit (cron, CI, manual refresh)
 *
 * Environment: DATABASE_URL, WORKER_INTERVAL_MS, WORKER_CONCURRENCY (default 4).
 */
import './loadEnv';
import { closePrisma, getPrisma } from '../db/client';
import { runIngestionCycle, startScheduler } from './worker';

const once = process.argv.includes('--once');
const intervalMs = Number(process.env.WORKER_INTERVAL_MS || 5 * 60 * 1000);
const concurrency = Number(process.env.WORKER_CONCURRENCY || 4);

function logCycle(summary: Awaited<ReturnType<typeof runIngestionCycle>>): void {
  console.log(
    `[worker] cycle ${summary.startedAt.toISOString()} ` +
      `feeds=${summary.considered} due=${summary.due} ` +
      `succeeded=${summary.succeeded} partial=${summary.partial} failed=${summary.failed} ` +
      `ms=${summary.finishedAt.getTime() - summary.startedAt.getTime()}`
  );
}

async function main(): Promise<void> {
  const db = getPrisma();

  if (once) {
    const summary = await runIngestionCycle({ db }, { concurrency });
    logCycle(summary);
    await closePrisma();
    process.exitCode = summary.failed > 0 && summary.succeeded === 0 && summary.due > 0 ? 1 : 0;
    return;
  }

  const scheduler = startScheduler(
    { db },
    {
      intervalMs,
      concurrency,
      onCycle: logCycle,
      onError: (err) => console.error('[worker] cycle crashed:', (err as Error).message),
    }
  );
  console.log(`[worker] running every ${intervalMs} ms with concurrency ${concurrency}`);

  const shutdown = async () => {
    console.log('[worker] shutting down');
    await scheduler.stop();
    await closePrisma();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(async (err) => {
  console.error('[worker] fatal:', (err as Error).message);
  await closePrisma();
  process.exitCode = 1;
});
