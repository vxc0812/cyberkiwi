# CyberKiwi

CyberKiwi is a cybersecurity news intelligence client. It aggregates security news feeds, groups duplicate coverage into stories, and offers reader mode and AI briefings. It runs as a web app, an Electron desktop app, a Tauri desktop build, and Capacitor Android and iOS apps.

> **Status: pre-beta, not release-ready.** Task-level progress is tracked in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

| Area | Status |
|---|---|
| Reader | Dashboard, feeds, story grouping, reader mode, bookmarks, themes |
| Server | Express API, PostgreSQL/Prisma, ingestion and enrichment workers |
| Accounts | Invite-only registration, sessions (web cookie, native bearer token), admin roles. Stored stories and articles require sign-in; live feed and reader-mode endpoints do not (see [Access model](#access-model)). |
| AI | Server-side briefings, BYOK keys and per-key quotas |
| Enrichment | CVE, CISA KEV, EPSS, MITRE ATT&CK and entity extraction |
| Planned | Grounded AI chat, account state sync, password reset, feedback and analytics |
| Mobile | Native projects and push foundations exist; on-device validation is incomplete. Android CI produces a debug build only; signed releases wait on signing credentials. |

## Features

- Curated cybersecurity feed catalog, plus custom RSS/Atom feeds and OPML import/export.
- Story clustering: duplicate coverage from several outlets is grouped under one story.
- Reader mode: full article extraction (Readability + DOMPurify sanitization).
- Bookmarks, archive, dark and light themes, English and Portuguese UI.
- Optional AI briefings, translation and block curation, served by the CyberKiwi server, with your own Gemini key (BYOK) if you prefer.
- Threat enrichment: CVE details, KEV status, EPSS scores, ATT&CK techniques; filter stories by them.
- Invite-only accounts. Stories and articles stored on the server are served only to signed-in users.
- Desktop notifications for breaking-news keywords.

## Quick start

Requirements: Node.js 22 or newer (Capacitor 8 requires it), and Docker for the local database.

```bash
npm ci
cp .env.example .env         # then set DATABASE_URL (the default matches docker compose)
npm run db:up                # PostgreSQL 16 on 127.0.0.1:5433
npm run db:deploy            # apply migrations
npm run db:seed              # load the feed catalog
npm run worker:once          # fetch feeds once and build stories
npm run auth:invite          # prints a one-time invite code; register with it in the app
npm run dev                  # http://localhost:3000
```

Without an AI key, reading, feeds and reader mode work normally. AI features show as unavailable.

Install dependencies on the machine that runs them. A `node_modules` folder copied from another OS (for example Windows to Linux) is missing platform binaries and executable permissions, and builds fail.

## Configuration

Copy `.env.example` to `.env` and set values as needed:

Use `.env` for shared defaults and `.env.local` for git-ignored local overrides. Real process environment variables take priority over both files. The ingestion worker and catalog checker load both files in that order.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. Required for stories, accounts and workers. |
| `GEMINI_API_KEY` | Server-side Google Gemini key. Never sent to the browser. |
| `NVD_API_KEY` | Optional NVD API key used only by the server-side CVE ingestion adapter. |
| `VITE_CYBERKIWI_API_BASE_URL` | API origin embedded into web and native builds. Required for release targets. |
| `WORKER_INTERVAL_MS` | Continuous worker interval in milliseconds (default `300000`). |
| `WORKER_CONCURRENCY` | Maximum parallel feed fetches (default `4`). |
| `PORT` | Server port (default `3000`). |
| `HOST` | Bind address (default `127.0.0.1`). A non-loopback value requires `ALLOWED_ORIGIN` in production. |
| `ALLOWED_ORIGIN` | Comma-separated origins allowed to make credentialed requests in production. |
| `ADMIN_TOKEN` | Enables the operator endpoint `GET /api/v1/ingestion/runs`. Unset means the endpoint does not exist. |
| `TRUST_PROXY_HOPS` | Number of trusted reverse proxies in front of the server (default `0`). Set only when a proxy is in front. |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server (Vite + API). |
| `npm run lint` | Type check (`tsc --noEmit`). |
| `npm test` | Unit tests (no database needed), including sign-in enforcement on story and article reads. |
| `npm run test:db` | PostgreSQL integration tests against a `*_test` database (uses `npm run db:up`). |
| `npm run build` | Production web build and server bundle. |
| `npm run smoke:server` | Boots the built server bundle and checks `/health`. Does not touch the database. |
| `npm run test:auth-flow` | Browser check (Chrome) that story reads follow the session: none while restoring or signed out, load on sign-in without a reload, stop on sign-out. Needs a build with `VITE_CYBERKIWI_API_BASE_URL` set, a running server and a test user; see the header of `scripts/auth-read-flow.mjs`. Run it against a freshly started server, since production rate limits count across runs. |
| `npm run start` | Run the built server (production mode). |
| `npm run db:up` / `db:down` | Start or stop the local PostgreSQL container. |
| `npm run db:deploy` | Apply database migrations. |
| `npm run auth:invite` | Create an invite code (`-- --max-uses N --days N --cohort NAME`). |
| `npm run auth:promote -- <email>` | Give an existing user the admin role. |
| `npm run worker:once` | Fetch one due-feed ingestion cycle. |
| `npm run worker:ingest` | Run the ingestion scheduler continuously. |
| `npm run worker:enrich` / `worker:push` | Run the enrichment and push-notification workers. |
| `npm run catalog:check` | Check catalog URLs without writing to the database. |
| `npm run desktop` | Build and launch the Electron app. |
| `npm run build:win` / `build:linux` | Electron installers. |
| `npm run desktop:tauri` / `build:tauri` | Tauri desktop (requires Rust). |
| `npm run build:android` | Build web assets and sync to Android. Then `cd android && ./gradlew assembleDebug`. |
| `npx cap sync ios` | Sync web assets to iOS. Open with `npx cap open ios`. |

See [DEVELOPMENT.md](DEVELOPMENT.md) for platform details.

## iOS builds from Ubuntu

The **CyberKiwi iOS Build & TestFlight Deploy** workflow builds the Capacitor app on a GitHub-hosted Mac. Run it manually with **Sign and upload this build to TestFlight** unchecked for a compile check. The workflow must be present on the repository's default branch before GitHub offers manual runs.

For an internal TestFlight upload, register the explicit bundle ID `com.cyberkiwi.client` with your Apple Developer team and create the matching app in App Store Connect. In the GitHub repository's Actions settings, configure:

| Type | Name | Value |
| --- | --- | --- |
| Variable | `APPLE_TEAM_ID` | Apple Developer Team ID |
| Variable | `VITE_CYBERKIWI_API_BASE_URL` | HTTPS URL of the CyberKiwi API that the phone can reach |
| Secret | `APP_STORE_CONNECT_KEY_ID` | ID of an App Store Connect team API key with access to automatic signing and upload |
| Secret | `APP_STORE_CONNECT_API_ISSUER` | Issuer ID shown alongside the team API keys |
| Secret | `APP_STORE_CONNECT_API_KEY` | Contents of the downloaded `.p8` key |

Run the workflow again with the upload option checked. After the build processes, add it to an internal testing group in App Store Connect and install it with TestFlight on the iPhone. [Apple cloud signing](https://developer.apple.com/videos/play/wwdc2021/10204/) · [Internal testing](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers)

## Access model

Pre-beta access is invite-only for **stored** content, not for every endpoint that returns content.

| Endpoint | Sign-in | Why |
|---|---|---|
| `GET /api/v1/stories`, `/api/v1/stories/:id`, `/api/v1/articles` | Required | Stories and articles the server ingested and stored. Without a session: `401 unauthorized`. |
| `GET/POST /api/rss`, `POST /api/rss/validate` | Not required | Fetches the caller's own feeds live. Keeps account-free desktop use working. |
| `GET /api/article/extract` | Not required | Reader mode: extracts one article live from its source. Same reason. |
| `GET /api/v1/feeds/health` | Not required | Feed fetch status only, no content. |
| `/api/auth/*`, `/health` | Not required | Sign-in itself, and liveness. |
| `POST /api/gemini/*` | Sign-in, your own AI key (`X-User-AI-Key`), or the desktop app's launch token | The platform AI key is never spent anonymously. |
| `/api/devices` | Required | Push registration for the signed-in user. |
| `/api/admin`, `/api/v1/enrichment/stats` | Admin role | Operator data. |
| `GET /api/v1/ingestion/runs` | `ADMIN_TOKEN` bearer | Exists only when `ADMIN_TOKEN` is set. |

The open endpoints still apply the outbound-fetch protections, size caps and rate limits described below. Requiring sign-in for them would end account-free desktop use, and is a decision for after pre-beta.

## Security

- The browser never holds an AI key. AI calls go through the CyberKiwi server.
- The browser never holds the NVD API key. The worker sends it only as the NVD `apiKey` request header.
- Outbound fetches (feeds, validation, article extraction) resolve DNS first and refuse private, loopback, link-local and reserved addresses. Redirects are re-validated at every hop.
- Response sizes are capped, and API requests are rate limited.
- In production the server binds to `127.0.0.1` and only accepts the configured origin.
- Stored story and article reads require an active session (see [Access model](#access-model)). Invite codes, session tokens and refresh tokens are stored only as hashes.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Project layout

```
server.ts              Express app: middleware, legacy feed/extract/AI endpoints, router mounts
server/api/            Versioned read API (/api/v1: stories, articles, feed health)
server/auth/           Invites, sessions, CSRF, auth and admin routes
server/ingestion/      Feed fetching, normalization and the ingestion worker
server/enrichment/     CVE/KEV/EPSS/ATT&CK enrichment and its worker
server/push/           APNs/FCM push and its worker
server/netSafety.ts    Shared private-address checks for all outbound requests
prisma/                Database schema and migrations
src/                   React client (App, components, services, i18n)
electron/              Electron main and preload processes
src-tauri/             Tauri (Rust) desktop target
android/ ios/          Capacitor native projects
tests/                 Unit tests; tests/integration/ needs PostgreSQL
```

## Contributors

OpenAI Codex contributed to the iOS build and TestFlight workflow and its setup documentation.

## License

MIT. See [LICENSE](LICENSE).
