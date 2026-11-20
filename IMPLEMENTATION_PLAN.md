# CyberKiwi Implementation Plan

**Generated:** 2026-11-16  
**Status:** In progress — partial implementation
**Total:** 62 tasks across 7 groups
**Progress:** 20 completed, 6 in progress, 36 not started (of 62 tasks).


---

## 📋 Plan Overview

| Group | Tasks | Description |
|-------|-------|-------------|
| 1. BYOK for AI | 8 | Bring Your Own Key for Gemini API inferencing |
| 2. Remove Portuguese | 8 | Complete removal of PT language support |
| 3. Phase 2: Accounts | 10 | Invite-only auth, server-side user state |
| 4. Phase 3: Enrichment | 10 | CVE/KEV/EPSS/ATT&CK pipelines |
| 5. Phase 4: AI Briefings/Chat | 10 | Grounded story briefings + multi-turn chat |
| 6. Phase 5: Pre-beta Loop | 7 | Analytics, feedback, cohort program |
| 7. Mobile Delivery | 9 | iOS/Android native features & compliance |

---

## 1️⃣ BYOK (Bring Your Own Key) for AI Inferencing

| # | Task | Details | Status |
|---|------|---------|--------|
| 1.1 | **Design BYOK architecture and data flow** | Define: client-side secure storage (Capacitor Preferences + Web Crypto), server-side key validation endpoint, per-request key forwarding, fallback to server key, quota tracking per user key | Completed |
| 1.2 | **Add BYOK settings UI in SettingsModal** | Add API key input field with show/hide, validation button, clear button, status indicator (valid/invalid/not tested), help text with Gemini API key link | Completed |
| 1.3 | **Implement client-side secure key storage** | Use `@capacitor/preferences` on native, localStorage with Web Crypto encryption on web; never log or send key except to `/api/gemini/*` endpoints | Completed |
| 1.4 | **Add server-side key validation endpoint** | `POST /api/gemini/validate-key` — tests key with a minimal `generateContent` call, returns `{valid: boolean, model?: string, error?: string}`, rate-limited | Completed |
| 1.5 | **Modify AI endpoints to accept user-provided keys** | Update `/api/gemini/summarize`, `/curate`, `/translate` to read `X-User-AI-Key` header, validate format, use for request; fallback to `GEMINI_API_KEY` env var when header absent | Completed |
| 1.6 | **Add per-user-key quota tracking** | Track daily request count per hashed key in Redis/memory; return 429 with retry-after when exceeded; include quota headers in responses | Completed |
| 1.7 | **Update apiAdapter.ts to send user key** | Modify `aiAuthHeaders()` to include stored user key; update `summarizeBlockWithAi`, `curateBlockWithAi`, `translateWithAi` to pass key | Completed |
| 1.8 | **Add key migration for existing users** | One-time migration: if user had key in localStorage (old), migrate to secure storage; show toast on first load | Not started |

---

## 2️⃣ Remove Portuguese Language Support

| # | Task | Details | Status |
|---|------|---------|--------|
| 2.1 | **Audit all Portuguese strings and i18n usage** | Search codebase for `'pt'`, `'portuguese'`, `'pt-BR'`, `language === 'pt'`, `getTranslation('pt')` — map all locations | Not started |
| 2.2 | **Remove Portuguese translations from i18n/translations.ts** | Delete `'pt'` locale object; keep only `'en'`; update `getTranslation` to default to `'en'` | Not started |
| 2.3 | **Remove language selector from SettingsModal** | Delete language dropdown, `languageExplicitlySet` setting, related UI | Not started |
| 2.4 | **Remove PT-specific logic from App.tsx** | Remove `isPtSystem` detection, `effectiveLang` logic, language setting from settings state | Not started |
| 2.5 | **Clean up PT-specific breaking keywords** | Remove `'Bomba'`, `'Urgente'`, `'Última Hora'` from default `breakingKeywords`; keep only EN keywords | Not started |
| 2.6 | **Remove PT date formatting and locale references** | Replace `toLocaleString('pt-BR')` with `'en-US'` or ISO; check all date/time formatting | Not started |
| 2.7 | **Update README and documentation** | Remove `'English and Portuguese UI'` from features; update language config docs | Not started |
| 2.8 | **Delete README.pt-BR.md** | Remove Portuguese README file | Not started |

---

## 3️⃣ Phase 2: Accounts & Pre-beta Access

| # | Task | Details | Status |
|---|------|---------|--------|
| 3.1 | **Design auth schema and add to Prisma** | Add `User`, `Session`, `InviteCode` models; fields: id, email, passwordHash, role, createdAt, updatedAt, lastLoginAt, preferences (JSON), apiKeyHash (for BYOK), quotaUsed, quotaResetAt | Completed |
| 3.2 | **Implement invite-only registration flow** | `POST /api/auth/register` (requires valid inviteCode), `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`; JWT in HttpOnly cookie | Completed |
| 3.3 | **Build admin invite management API** | `POST /api/admin/invites` (create), `GET /api/admin/invites` (list), `DELETE /api/admin/invites/:id` (revoke); requires `ADMIN_TOKEN` | Completed |
| 3.4 | **Create admin dashboard UI (React)** | Simple page: list users, create/revoke invites, view user stats, suspend/activate accounts | Not started |
| 3.5 | **Migrate client state to server** | Blocks, feeds, bookmarks, settings, archive → server endpoints; client becomes cache + optimistic UI; sync on login | Not started |
| 3.6 | **Add device/session management** | `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`; show active sessions in settings | In progress |
| 3.7 | **Implement password reset flow** | `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`; token via email (dev: log to console) | Not started |
| 3.8 | **Add auth middleware and protect API routes** | Require auth for `/api/v1/*`, `/api/gemini/*` (except status); optional auth for `/api/rss` | In progress |
| 3.9 | **Update client AuthContext and hooks** | `useAuth()` hook, login/logout/register functions, token refresh, redirect on 401 | Browser smoke test passes; native refresh and resume not yet run on a device. | In progress |
| 3.10 | **Add privacy policy, terms, data export/delete endpoints** | `GET /api/legal/privacy`, `GET /api/legal/terms`, `POST /api/auth/export-data`, `DELETE /api/auth/delete-account` | Not started |

---

## 4️⃣ Phase 3: Cybersecurity Enrichment

| # | Task | Details | Status |
|---|------|---------|--------|
| 4.1 | **Extend Prisma schema for enrichment data** | Add `Cve`, `kev`, `epss`, `mitreTechnique`, `malwareFamily`, `threatActor`, `product`, `Vendor` models; link to Article via many-to-many Decisions: `EnrichmentJob.status` is a PostgreSQL enum (PENDING, RUNNING, DONE, FAILED). Entities (vendor, product, malware, threat actor) share one `Entity` table distinguished by `type`. | Completed |
| 4.2 | **Build NVD CVE 2.0 ingestion adapter** | Fetch recent/modified CVEs; parse CVSS, CWE, affected products (CPE); upsert to Cve table; respect `NVD_API_KEY` rate limits | Completed |
| 4.3 | **Build CISA KEV ingestion adapter** | Fetch Known Exploited Vulnerabilities catalog; mark CVEs as `knownExploited`; add `dueDate`, `ransomwareCampaign` | Completed |
| 4.4 | **Build EPSS ingestion adapter** | Fetch daily EPSS scores; update `Cve.maxEPSS`; percentile ranking | Completed |
| 4.5 | **Build MITRE ATT&CK tagging pipeline** | Keyword/rule-based extraction from article titles/snippets; map to technique IDs; store in `MitreTechnique` table; link to Article | Completed |
| 4.6 | **Add entity extraction (vendor, product, malware, threat actor)** | NER or dictionary-based; normalize to `Vendor`/`Product`/`MalwareFamily`/`ThreatActor` tables; link to Article | Completed |
| 4.7 | **Enrich articles at ingestion time** | In `worker.ts`: after `upsertArticles`, run enrichment pipeline; attach CVE IDs, KEV status, EPSS, ATT&CK tags, entities | Completed |
| 4.8 | **Extend read API with enrichment filters** | Add `?cve=CVE-2024-xxxx`, `?severity=critical`, `?kev=true`, `?epss>0.5`, `?technique=T1190`, `?vendor=microsoft` to `/stories` and `/articles` | Completed |
| 4.9 | **Add enrichment health/monitoring endpoints** | `GET /api/v1/enrichment/stats` — counts, last run, error rates per adapter | Completed |
| 4.10 | **Build enrichment dashboard UI blocks** | Dynamic blocks for: Critical CVEs (KEV), High EPSS, Recent Exploits, ATT&CK Techniques, Vendor Advisories | | Completed |

---

## 5️⃣ Phase 4: Grounded AI Briefings & Story Chat

| # | Task | Details | Status |
|---|------|---------|--------|
| 5.1 | **Design retrieval/context layer architecture** | Vector embeddings (pgvector or external), article/chunk indexing, hybrid search (BM25 + vector), citation tracking, context window management | Not started |
| 5.2 | **Add pgvector to PostgreSQL and create embeddings pipeline** | Enable pgvector extension; create embeddings table; batch-generate embeddings for article excerpts + titles using embedding model (Gemini `text-embedding-004` or local) | Not started |
| 5.3 | **Implement story briefing generation** | `POST /api/ai/briefing/:storyId` — retrieve top-k chunks, build prompt with citations, stream response; include source links, dates, confidence | Not started |
| 5.4 | **Implement story chat with conversation history** | `POST /api/ai/chat/:storyId` — multi-turn; retrieve context per turn; maintain conversation history per user+story; cite sources in each response | Not started |
| 5.5 | **Add per-user AI usage quotas and cost tracking** | Track tokens (prompt+completion) per user per day; enforce limits (configurable); return quota headers; log for billing prep | In progress |
| 5.6 | **Build AI briefing UI in ArticleReaderModal** | Add 'AI Briefing' tab/button; streaming response display; citation links to source articles; copy/regenerate actions | Not started |
| 5.7 | **Build story chat UI** | Chat panel in reader modal; message history; suggested prompts; source citations inline; feedback buttons (helpful/not) | Not started |
| 5.8 | **Add non-AI fallback experience** | When quota exceeded or model unavailable: show article summary + key facts + source list; disable chat input with explanation | Not started |
| 5.9 | **Add AI feedback and quality logging** | `POST /api/ai/feedback` — helpful/not helpful/inaccurate/missing-source; log prompt, response, sources, user rating | Not started |
| 5.10 | **Implement model abstraction layer** | `AIService` class with pluggable providers (Gemini, OpenAI, local); config-driven model selection; retry/fallback logic | Not started |

---

## 6️⃣ Phase 5: Pre-beta Learning Loop

| # | Task | Details | Status |
|---|------|---------|--------|
| 6.1 | **Define pre-beta metrics and instrumentation** | Events: `sign_up`, `first_login`, `story_view`, `story_chat`, `briefing_generated`, `bookmark_save`, `alert_trigger`, `feedback_submit`, `session_duration`; privacy-respecting, opt-in | Not started |
| 6.2 | **Add analytics endpoint and client logger** | `POST /api/analytics/events` (batched); client queue + flush; respect DNT; no PII in events | Not started |
| 6.3 | **Build admin pre-beta dashboard** | Metrics: DAU/MAU, activation rate, retention (D1/D7/D30), AI usage per user, top stories, top chat topics, feedback sentiment, feature adoption | Not started |
| 6.4 | **Create in-app feedback workflow** | Feedback button → modal (type: bug/feature/question + text + screenshot opt-in); `POST /api/feedback`; admin triage view | Not started |
| 6.5 | **Set up pre-beta cohort management** | Invite codes with cohort tags; track cohort behavior separately; cohort comparison dashboard | Not started |
| 6.6 | **Define and implement learning questions tracking** | Track: Which topics drive repeat visits? Summary vs alert vs chat preference? Recurring AI questions? Acceptable latency? Trust signals? Payment intent signals? | Not started |
| 6.7 | **Run structured pre-beta program** | Recruit 20-50 testers; weekly check-ins; NPS survey; feature usage analysis; iterate on AI quotas/limits; document findings | Not started |

---

## 7️⃣ Mobile Delivery (iOS/Android)

| # | Task | Details | Status |
|---|------|---------|--------|
| 7.1 | **Audit Capacitor config and native permissions for new features** | Check `capacitor.config.ts` for new plugins (biometric, background-runner, push notifications); update `Info.plist` (`NSCameraUsageDescription`, `NSFaceIDUsageDescription`, `UIBackgroundModes`) and `AndroidManifest.xml` (`BIOMETRIC`, `INTERNET`, `RECEIVE_BOOT_COMPLETED`, `FOREGROUND_SERVICE`) | Not started |
| 7.2 | **Implement biometric authentication (Face ID / Touch ID / Android Biometric)** | Add `@capacitor/biometric` or custom plugin; store JWT/refresh token in Keychain (iOS) / Keystore (Android); fallback to PIN/password; prompt on app launch/foreground | Not started |
| 7.3 | **Integrate push notifications (FCM / APNs) for breaking news & alerts** | Configure `@capacitor/push-notifications` + FCM/APNs; notification categories (breaking, daily-digest, ai-ready); background fetch trigger; deep link to story; user preference per-category | Trigger, queue, dedupe, worker and FCM/APNs providers exist; no real provider credentials or native device test yet. | In progress |
| 7.4 | **Add background feed refresh (Background App Refresh / WorkManager)** | iOS: `BGAppRefreshTask` + `BGProcessingTask`; Android: WorkManager periodic worker; sync articles when app backgrounded; respect user settings and battery optimization | Not started |
| 7.5 | **Implement universal links / deep links for invites and stories** | iOS: Associated Domains + `applinks:cyberkiwi.app`; Android: intent-filter with `autoVerify`; routes: `/invite/:code`, `/story/:id`, `/settings`; handle cold start + foreground | Config files and routes exist; not deployed. Needs the Apple team ID, release SHA-256 and the Xcode entitlement attached. | In progress |
| 7.6 | **Build offline-first article cache and sync engine** | Cache stories/articles in `@capacitor/preferences` or SQLite (`capacitor-sqlite`); queue reads/bookmarks/chats offline; sync on reconnect with conflict resolution; show offline banner | Not started |
| 7.7 | **Mobile UI polish: safe areas, keyboard avoidance, touch targets, haptics** | `SafeAreaView` for notches/Dynamic Island; `KeyboardAvoidingView` for chat/input; 44×44pt minimum touch targets; `Haptics.impact` on actions; landscape iPad split view; Dynamic Type support | Not started |
| 7.8 | **App Store compliance: Privacy Manifest, Data Safety, ATTrackingManager** | iOS: `PrivacyInfo.xcprivacy` (`NSPrivacyTracking`, `NSPrivacyCollectedDataTypes`); Android: Play Console Data Safety form; `ATTrackingManager` request if analytics; export compliance (`ITSAppUsesNonExemptEncryption`) | Not started |
| 7.9 | **Update mobile build pipeline: Fastlane, Gradle, TestFlight/Play Console automation** | Fastlane match for certs; Gradle version catalog for deps; GitHub Actions: build → TestFlight (internal) → Play Console (internal testing); automatic version bump; changelog generation; screenshot capture | Not started |

---

## 🗓️ Suggested Execution Timeline

```
Week 1-2:  BYOK (1.1-1.8) + PT Removal (2.1-2.8) + Mobile: Capacitor Audit (7.1)
Week 3-4:  Phase 2 Accounts (3.1-3.10) + Mobile: Biometric Auth (7.2), Deep Links (7.5)
Week 5-7:  Phase 3 Enrichment (4.1-4.10) [backend-focused]
Week 8-11: Phase 4 AI Briefings/Chat (5.1-5.10) + Mobile: Push Notifications (7.3), Offline Cache (7.6), UI Polish (7.7)
Week 12+:  Phase 5 Pre-beta (6.1-6.7) + Mobile: Compliance (7.8), Build Pipeline (7.9), Background Refresh (7.4)
```

---

## 🔗 Key Dependencies

| Phase | Depends On | Blocks |
|-------|------------|--------|
| BYOK | — | Phase 4 quotas |
| PT Removal | — | — |
| Phase 2 (Accounts) | BYOK (for apiKeyHash) | Phase 4, Phase 5 |
| Phase 3 (Enrichment) | Phase 2 (schema) | Phase 4 (retrieval context) |
| Phase 4 (AI) | Phase 2 (quotas), Phase 3 (enrichment data), BYOK | Phase 5 |
| Phase 5 (Pre-beta) | Phase 2, 3, 4 complete | — |
| Mobile Delivery | Parallel with each phase | App Store release |

---

## ✅ Acceptance Criteria Summary

- **BYOK**: User can add/validate/remove own Gemini key; quota tracked per key; server key fallback works
- **PT Removal**: No Portuguese strings remain; single EN locale; settings simplified
- **Phase 2**: Invite-only signup works; JWT sessions; admin manages invites; user state on server
- **Phase 3**: CVE/KEV/EPSS/ATT&CK data in DB; API filters work; dashboard blocks show enriched data
- **Phase 4**: Story briefing streams with citations; multi-turn chat with history; quotas enforced; fallback shown
- **Phase 5**: Analytics dashboard live; feedback workflow works; 20+ testers onboarded; learning questions answered
- **Mobile**: Biometric login; push notifications; background sync; offline read; App Store compliant; CI/CD automated

---

## 📝 Notes

- Status values: **Completed** (code and tests in the repo), **In progress** (partly built; see the task), **Not started**.
- Tasks are sized for ~1-2 day completion each
- Mobile tasks (Group 7) integrate with their dependent phases
- Run `npm run lint` and `npm test` after each task group
- Update this document as decisions evolve during implementation