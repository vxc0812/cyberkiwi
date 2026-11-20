# CyberKiwi Engineering Handoff

## Snapshot

- Project: `cyberkiwi-client`
- Branch: `security-hardening-2026-11`
- Status: in progress; this snapshot contains the current uncommitted implementation and its verification notes.
- Transfer target: `/home/vishal-chopra/Desktop/cyberkiwi-client`
- Source copy: retained on the Windows workstation.

This handoff intentionally excludes local secrets and regenerable artifacts. Create a new `.env.local` on the Ubuntu device from `.env.example`; do not copy the Windows `.env.local`.

## What is implemented

### Authentication and sessions

- Invite/account/session database models and migrations are present.
- Web authentication uses cookie-backed sessions.
- Native clients can use bearer/refresh-token flow.
- Refresh requests are serialized on the client and retry once after a 401.
- Refresh-token rotation includes a 60-second grace window for a dropped refresh response.
- Session-specific CSRF tokens are issued at login, refresh, and `/api/auth/csrf`.
- CSRF values are hashed in the database and compared in constant time.
- Origin validation is an additional protection for cookie-authenticated writes.

### BYOK Gemini keys

- Settings contains the `AiKeySection` UI.
- Keys are only considered saved after server validation succeeds.
- Native storage uses Keychain/Keystore-backed storage when the secure plugin is available.
- Web keys remain in memory unless the user enables passphrase encryption.
- Keys are not persisted in the general settings object or browser storage.
- Server-side key validation and quota handling are implemented.

### Enrichment

- Enrichment jobs are queued by ingestion and processed by `worker:enrich`.
- Jobs use enum status, retries, and backoff.
- Feed ingestion remains successful when enrichment fails.
- Filters include `minEpss`, `kev`, `cve`, `technique`, `severity`, and `vendor`.
- `/api/v1/enrichment/stats` is admin-only.
- Five enrichment presets are available to the block builder.
- CVE severity includes provenance fields: `severitySource`, `severityUpdatedAt`, and `severityProvisional`.

### Push and deep links

- Device registration endpoints exist:
  - `POST /api/devices`
  - `PATCH /api/devices/:id`
  - `DELETE /api/devices/:id`
- Breaking-story detection creates deduplicated `PushJob` rows.
- `worker:push` sends through FCM HTTP v1 or APNs when configured.
- Dead device tokens are revoked and failures retry with backoff.
- Push failures do not fail feed ingestion.
- Custom deep links use `cyberkiwi://story/<id>`.
- HTTPS story links use `https://cyberkiwi.app/story/<id>` and share the same handler.

## Verification completed

- TypeScript lint/type-check: passed.
- Web build with Vite: passed.
- Unit suite: 308 checks passed.
- Database suite against the test database: 73 checks passed.
- Real server boot and route checks: passed.
- Invalid filter values return HTTP 400.
- Android `npx cap sync android`: passed.
- Headless browser smoke test: 9 steps passed, including sign-in, reload persistence, rejected BYOK behavior, storage checks, sign-out, and cold story URL handling.
- Dev database migrations through `0009_severity_provenance`: applied.

## Not verified yet

- Valid Gemini-key browser path; run with `SMOKE_GEMINI_KEY`.
- Android emulator or physical-device run; this workstation has no Android SDK or `adb`.
- iOS sync/build/device run; requires macOS or CI.
- Native refresh, resume, cold-start deep-link, and push-registration behavior on devices.
- Live FCM or APNs delivery with real provider credentials.
- Production HTTPS universal-link association files.
- SQLite outbox and background refresh.
- Browser visual review of the React screens.

## Known product limitations

- Push registration and delivery are implemented, but no product event currently sends a notification beyond the queued breaking-story path.
- Per-category push preferences have API support but no complete Settings UI.
- CVE severity is currently provisional and only available for NVD-derived CVEs. There is no canonical NVD lookup yet.
- The auth panel is currently inside Settings rather than a dedicated route/screen.
- Native secure-storage fallback keeps the refresh token in memory, requiring sign-in again after restart if the plugin is unavailable.
- HTTPS universal links remain in progress until Apple and Android association files are deployed with production signing identifiers.

## Ubuntu setup

From the transferred project directory:

```bash
npm ci
cp .env.example .env.local
npm run db:generate
npm run lint
npm test
npm run build
```

Configure `.env.local` with deployment-specific values. Important variables include:

```env
DATABASE_URL=postgresql://...
ALLOWED_ORIGIN=https://cyberkiwi.app,capacitor://localhost,https://localhost
GEMINI_API_KEY=...
AI_ACCESS_TOKEN=...
ADMIN_TOKEN=...
NVD_API_KEY=...
```

Add FCM/APNs credentials only on the server that runs `worker:push`. Never commit them or place them in `VITE_*` variables.

Apply migrations with:

```bash
npm run db:deploy
```

Run the services separately in production or under a supervisor:

```bash
npm start
npm run worker:ingest
npm run worker:enrich
npm run worker:push
```

Use `npm run worker:once` for a one-cycle ingestion check. Keep the API server, ingestion worker, enrichment worker, and push worker independently restartable.

## Native development

After installing the required Android SDK or on macOS for iOS:

```bash
npx cap sync android
npx cap run android
```

On macOS:

```bash
npx cap sync ios
npx cap open ios
```

Before release, verify login/refresh, BYOK storage, app resume, cold-start links, push registration, notification taps, and offline behavior on physical devices.

## Production readiness checklist

- [ ] Investigate intermittent dev/API health-check stalls under feed/database load.
- [ ] Run the valid-key BYOK smoke path.
- [ ] Configure and test live FCM and APNs delivery.
- [ ] Deploy Apple `apple-app-site-association` and Android `assetlinks.json` files.
- [ ] Attach the iOS entitlements file in Xcode and verify Associated Domains.
- [ ] Add Settings UI for category-level notifications.
- [ ] Add canonical NVD severity lookup or clearly label provisional severity in production UI.
- [ ] Run a clean-database migration deployment through `0009`.
- [ ] Configure TLS, secure cookies, trusted proxy settings, backups, and monitoring.
- [ ] Run browser visual QA and Android/iOS device QA.
- [ ] Confirm no `.env.local`, provider credentials, signing keys, `node_modules`, `dist`, or generated Prisma output is in the transfer.

## Transfer policy

The Git repository and source files are transferred. These are intentionally regenerated or kept local:

- `.env.local` and all other `.env*` files except `.env.example`
- `node_modules/`
- `dist/`
- `generated/`
- Android build/cache output
- iOS build/Pods output if present

After transfer, verify the repository with:

```bash
git status
git log -1 --oneline
```

