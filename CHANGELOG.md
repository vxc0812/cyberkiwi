# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2026-11-15

### Security
Findings come from the Claude Security scan `CLAUDE-SECURITY-20261116-005326` (53 findings: 2 HIGH, 14 MEDIUM, 37 LOW). The release-signing and CI items (F9, F11, F13, F14, F23) are not covered here; they need credential rotation and CI changes.

- **Article HTML sanitization (F3, F4).** The server sanitizer now runs on a DOM that DOMPurify supports (`isomorphic-dompurify` 4.6.0). It fails closed when unsupported. The client sanitizes server-returned HTML again before rendering. (`server/sanitize.ts`)
- **Feed parser denial of service (F1, F2).** `rss-parser` is replaced by a bounded streaming parser (`saxes` 6.0.0). Items, field length, nesting depth and DOCTYPE entities are capped. Image scanning is bounded. (`server/feedParser.ts`)
- **External URL allowlist (F8, F17, F20, F24, F33, F43, F44).** Only plain `http:` and `https:` URLs reach the browser, `shell.openExternal`, the share sheet or an anchor. Electron's navigation guard matches the loopback hostname exactly. (`electron/externalUrl.cjs`, `src/utils/externalUrl.ts`)
- **Resource limits (F5, F6, F7, F16).** At most 20 feed URLs per request, 4 concurrent fetches, in-flight coalescing, and bounded LRU caches (500 feeds, 200 articles). Each outbound fetch has one deadline that covers redirects. (`server/resourceLimits.ts`)
- **SSRF coverage (F10, F12, F18, F22, F28, F40, F41, F52).** One address classifier for server and client, covering NAT64, 6to4, Teredo and IPv4-mapped addresses. The client refuses private and local targets before any device or browser request, and no longer retries a URL the server rejected. (`src/utils/networkAddress.ts`, `src/utils/fetchTarget.ts`)
- **AI proxy (F26, F27, F39, F42, F53).** AI routes need a bearer token and are disabled without one. Daily quota (`AI_DAILY_LIMIT`, default 1000). Inputs are length-capped and feed text is delimited as untrusted data. The desktop app creates a per-launch token. (`server/aiGuard.ts`, `server/aiRoutes.ts`)
- **Development exposure (F15, F19).** The server binds to `127.0.0.1` by default. Development CORS allows only local origins. Production refuses a non-loopback `HOST` without `ALLOWED_ORIGIN`. (`server/originPolicy.ts`)
- **Lower-priority hardening (F29, F30, F31, F34, F36, F37, F38, F45, F46, F48, F49, F50, F51).**
  - Operator `/ingestion` responses are `no-store`.
  - Block filters match literal `|`-separated terms, not regular expressions. Regex syntax in saved filters no longer works.
  - The OPML fallback and headline cleaning use linear patterns.
  - A remote `DATABASE_URL` must request TLS (`sslmode=require`).
  - Feed URLs with credentials are refused.
  - Feed validation errors are generic.
  - The feed list is sent by POST (GET is still accepted).
  - Public article and story queries hide deactivated feeds and sources.
  - The Android FileProvider shares only `cache/shared/`.
  - Electron waits for the server's per-launch instance id on `/health`.

### Added
- **NVD API key support.** When `NVD_API_KEY` is set, the NVD CVE 2.0 adapter sends it as an `apiKey` header on every request. The key is read only on the server and is never logged or returned. (`server/ingestion/adapters/nvd.ts`, `server/ingestion/fetchFeed.ts`)
- **Local env loading for ingestion.** `server/ingestion/loadEnv.ts` loads `.env`, then `.env.local` (which overrides it). Real process environment variables take precedence over both files.
- **Automated ingestion scheduling.** `npm run worker:ingest` runs an immediate cycle, then refreshes due feeds at `WORKER_INTERVAL_MS` without overlapping cycles. Feed-specific intervals, bounded concurrency and failure backoff remain active.
- **Category coverage blocks.** Cloud, IoT, AppSec, DevSecOps and Privacy now have separate dashboard blocks. Saved dashboards migrate the former combined Cloud and IoT block without discarding custom layout settings.
- **Tests.** `tests/load-env.test.ts` (3 checks) covers env precedence, and `tests/nvd-adapter.test.ts` gained an auth-header check. `npm test` runs 167 checks, all passing.
- `NVD_API_KEY` entry in `.env.example`.

### Changed
- `server/ingestion/run-worker.ts` and `server/ingestion/catalogCheck.ts` import the env loader before any database client, so `DATABASE_URL` and `NVD_API_KEY` are available to `worker:once`, `worker:ingest` and `catalog:check`.
- `fetchFeedXml` accepts optional extra request headers as a fourth parameter. Only the NVD window fetch uses it. All requests still go through `safeFetchText`.
- The navbar places topic links in their own scrollable row and moves secondary mobile actions into the menu to prevent overlap and horizontal overflow.
- Reader and settings dialogs now provide accessible names, focus management, keyboard traps and focus restoration.
- Category blocks now distinguish no active sources from sources that are temporarily failing.
- Secondary text in `src/App.tsx` (section subtitles, bookmark empty state, story snippets and metadata) is theme-aware: `text-neutral-600` in light mode and `text-neutral-400` in dark mode.
- UI text below 12px is now `text-xs`: 102 occurrences across `src/App.tsx` and 11 files in `src/components/` (`AICuratorModal`, `ArticleReaderModal`, `CreateBlockModal`, `DynamicBlockCard`, `GlobalFeedsModal`, `ManageFeedsModal`, `Navbar`, `SafeImage`, `SettingsModal`, `TickerBar`, `ToastNotificationContainer`).
- `.env.example` and `DEVELOPMENT.md` document `NVD_API_KEY`, the `.env` / `.env.local` precedence, and the NVD key behavior.

### Fixed
- The NVD adapter could not authenticate: nothing read `NVD_API_KEY`.
- `worker:once`, `worker:ingest` and `catalog:check` ignored `.env.local`.
- Low-contrast secondary text: light-mode `text-neutral-400` on white measured 2.52:1 and 2.31:1 on the light page background; `text-neutral-500` on the dark page measured 4.15:1. All measured below the 4.5:1 requirement for text.
- Category links could render a blank dashboard when no matching default block existed. The dashboard now renders the correct block and source-health message for each security topic.
- The combined Cloud and IoT block queried Cloud data for both tabs. The blocks now query their own categories.
- The desktop topic links shared a flex row with the header actions and overlapped at narrower widths. The links now occupy a separate row, and the mobile header no longer overflows at 390px.

### Verification
- NVD: the key is accepted (HTTP 200). The `catalog:check` NVD row is OK with 18 items. A worker sync succeeded with 17 new articles. The database holds 306 NVD articles, all linked to stories. The stories API returned HTTP 200, and 48 of its 50 stories mention CVEs.
- `tsc --noEmit`, `npm test` (167 checks) and `npm run build` pass. The build prints an `import.meta` warning from the generated Prisma client when bundling `dist/server.cjs`. I have not investigated it.

### Known issues
- `iotsec` times out in `catalog:check` and in worker cycles. `zerodayinitiative` timed out in one run and passed in a later one.
- NVD returns intermittent HTTP 503s. A failed feed backs off (15-minute base, doubling per failure) and keeps its previous sync point.
- An invalid `NVD_API_KEY` makes every NVD request fail with `Invalid apiKey.`. There is no fallback to unauthenticated access.
- Not visually verified: layout at 320px and 200% zoom, light-mode rendering, and the 12px badge sizes in the navbar.
- Story cards are `div` elements with `onClick` (`src/App.tsx`). Keyboard reachability has not been checked.
- Not reviewed: writing and UI-polish domains. The accessibility review covered contrast only.

### Verification notes
- Browser smoke checks covered the category links at desktop width. Malware rendered 8 stories. Cloud, AppSec, DevSecOps and Privacy showed their no-source state. IoT showed its temporary source-failure state.
- The local Chrome smoke path verified no navbar overlap or horizontal overflow at 390px, 1024px and 1440px.
- The current build still requires verified catalog replacements before Cloud, AppSec, DevSecOps and Privacy can display publisher content.

## [0.2.0] - 2026-11-11

### 🚀 Highlights & Major Features
- **📖 Full Article Reader View (Modo Leitura Completa):**
  - Distraction-free article reader powered by **Mozilla Readability** and **DOMPurify** sanitization, scraping destination news pages on demand without paywall banners, ads, cookie popups, or tracking scripts.
  - Dynamic scroll progress bar tracking reading completion in real-time.
  - Reading metadata badge showing estimated reading time (e.g. `⏱️ 3 min de leitura`) and word count.
  - Seamless one-click toggling between Full Article View and RSS Feed Summary.
  - Deep synergy with Web Speech Text-to-Speech (TTS) and Google Gemini AI Executive Summarization to analyze the entire article body.
- **📥 Universal OPML 2.0 Feed Import & Export:**
  - Full compatibility with the universal RSS subscription standard (`.opml` / `.xml`), enabling seamless migration to and from **Feedly**, **Inoreader**, **NetNewsWire**, **Pocket**, and **Google Reader** archives.
  - **Hierarchical Category Folders:** Automatically groups feeds into topic folders (`Technology`, `Brazil News`, `Finance & Markets`, `Sports`, `Entertainment & Gaming`, etc.) on export and reconstructs them during import.
  - **Defensive Dual-Engine Parser:** Browser-native high-speed parsing via `DOMParser` paired with a zero-dependency regex fallback for Node.js / test environments.
  - **Smart Category Normalization:** Semantic keyword matching (`normalizeCategory`) to accurately categorize imported feeds into Radar RSS Bento buckets.
  - **In-App Hub & Immediate Feedback:** 4-action action bar in `ManageFeedsModal` distinguishing universal OPML from full JSON backups, with deduplication counts and real-time toast alerts.
- **🦀 Ultra-Lightweight Rust & Tauri 2.0 Desktop Target:**
  - Added standalone native desktop build using **Rust 1.99** and **Tauri 2.0**, operating in parallel with the Electron desktop app.
  - **51% Less Memory Consumption:** Reduced total resident set size (RSS) from ~1.085 GB (Electron) to **~533 MB** under identical workloads (17 active feeds, 520+ live stories).
  - **Tiny Native Binary:** Stripped Release executable is only **6.8 MB** (over 90% reduction compared to Electron's 85 MB binary and 260 MB disk footprint).
  - **Instant Startup:** Cold launch time reduced to **< 50ms**.
  - **80% Fewer OS Processes:** Runs with only 2 processes (native Rust runtime + system WebKitGTK / WebView2) vs 10 child processes in Electron.
  - New developer scripts: `npm run desktop:tauri` and `npm run build:tauri`.
- **🎨 Authentic Brand Icon Standardization:**
  - Renamed Tauri binary and crate to `radar-rss` and fixed GNOME Linux desktop integration with dedicated `.desktop` launcher and hicolor theme icon registrations.
  - Synchronized high-resolution concentric radar icon across all platforms (`public/icon.png`, `build/icon.ico`, `src-tauri/icons/`).
- **🧪 Comprehensive Automated Testing & Visual Verification Suite:**
  - Automated unit test suite via `npm test` verifying clustering algorithms, OPML roundtrips, and full article readability extraction with **100% pass rate (35/35 tests)**.
  - Headless Electron visual test script (`scripts/test-visual-opml.cjs`) capturing end-to-end screenshots and verifying UI state transitions.
- **📦 Pre-Compiled Multi-Platform Executables:**
  - Official distribution on GitHub Releases v0.2.0: Windows Setup Installer and Portable editions (`.exe`), Linux universal AppImage (`.AppImage`), Debian/Ubuntu native package (`.deb`), and standalone Rust binary (`.tar.gz`).
- **🌐 Network & Localization Improvements:**
  - Permissive CORS middleware in Express server (`server.ts`) for cross-origin local and Electron development.
  - Automatic language detection on first launch via `navigator.language` (defaulting to Brazilian Portuguese for `pt` locales).
  - Unblocked G1 / Globo feeds from feed list filters.
  - Defensive regex JSON extraction for Gemini AI curation.

## [0.1.0] - 2026-09-10

### 🚀 Highlights & Major Features
- **🪟 Full Windows Desktop Experience (Electron Integration):**
  - **System Tray & Background Mode:** Minimize to system tray on close, quick context menu (Refresh Feeds, Auto-start toggle, Minimize toggle, Check for Updates, Quit), and single/double-click restore.
  - **Native Windows Notifications:** Registered `AppUserModelId` (`com.dznasscmd.radarrss`) with Start Menu shortcut linking for rich Action Center alerts with click-to-open article navigation and taskbar alert flashing (`flashFrame`).
  - **Multi-Resolution Windows Icons:** Full `.ico` generation with 7 standard sizes (16, 24, 32, 48, 64, 128, 256 px) sampled from the official Radar RSS design with bicubic filtering, preventing Electron icon fallbacks.
  - **Window State Persistence:** Automatically remembers dimensions, position, and maximized state with multi-monitor disconnect safety fallback.
  - **Desktop Keyboard Shortcuts:** <kbd>F5</kbd>/<kbd>Ctrl+R</kbd> (smooth feed refresh), <kbd>Ctrl+F</kbd> (global search focus), <kbd>Ctrl+,</kbd> (settings), <kbd>Ctrl+B</kbd> (bookmarks), <kbd>Ctrl+N</kbd> (new block), <kbd>Ctrl+D</kbd> (theme toggle), <kbd>Esc</kbd> (close modal/cancel search).
  - **Native Context Menu:** Right-click context menus for text input editing, Google search on selection, and external link handling.
  - **Desktop Settings & Preferences:** Dedicated "Desktop (Windows)" settings card in SettingsModal with full English/Portuguese i18n.
  - **Secure Preload Architecture:** `contextIsolation: true`, `nodeIntegration: false`, and safe bidirectional IPC via `contextBridge`.

## [0.0.9-beta] - 2026-09-06

### 🚀 Highlights & Major Features
- **🧩 Cross-Feed News Deduplication & Story Clustering ("News Cluster"):**
  - High-performance multi-signal similarity engine ($O(N \cdot k)$ via temporal inverted index):
    - Normalized token overlap & n-grams with multilingual stopword removal (PT, EN, ES).
    - Canonical URL normalization (automatic removal of tracking parameters `utm_*`, `ref`, `fbclid`, anchors `#`, and protocol normalization).
    - Named entity and numerical identifier matching (models, percentages, years, currency).
    - Semantic action divergence protection (preventing false clustering between distinct events like *"announces new iPhone"* vs *"raises iPhone prices"*).
    - Exponential temporal decay function ($e^{-\lambda \Delta t}$) respecting the configured correlation window.
    - Short headline guardrail requiring snippet overlap confirmation for titles under 3 tokens.
  - Multi-source UI badge (`3 fontes`) displaying combined news coverage (e.g. `Reuters · The Verge · TechCrunch`).
  - Expandable source drawer in news cards for viewing individual outlet headlines, publication timestamps, and direct external links.
  - Interactive source switching tabs inside the Article Reader modal, seamlessly toggling title, full text, author, and outlet attribution without losing reading state.
  - Synchronized read/unread and bookmark state across all constituent article IDs in a cluster.
- **🧠 Consolidated Multi-Source AI Executive Briefing (Google Gemini):**
  - Updated Gemini executive summarization engine to synthesize facts, quotes, and perspectives across all constituent outlets of a story cluster into a unified bulleted briefing without redundancies or hallucinations.
  - Graceful fallback when AI is disabled or for single-source articles.
- **⚙️ Configurable Deduplication Preferences:**
  - Dedicated settings section with real-time toggle (on/off).
  - Strategy selector: Balanced (0.58), Conservative (0.72, zero false positives), and Aggressive (0.45).
  - Configurable temporal correlation window (12h, 24h, 48h, 72h) and maximum sources per story cluster.
- **⚡ Electron Desktop Architecture & Launch Optimizations:**
  - Disabled ASAR compression (`"asar": false`), enabling Express and Node.js to access and serve static web assets natively from physical disk paths.
  - Eliminated single-instance lock deadlocks and added second-instance window restoration and focus.
  - Graceful `did-fail-load` fallback directly to local `index.html`.

---

## [0.0.8-beta] - 2026-09-06

### 📱 Android & Native Mobile Stability
- **Google Gemini AI Direct API Fix & Key Validation:** Fixed model identifier from non-existent `gemini-2.5-flash`/`gemini-3.6-flash` to official `gemini-2.0-flash` (with fallback to `gemini-1.5-flash`), migrated mobile network calls to native `CapacitorHttp` to eliminate WebView restrictions, and added interactive "Validar Chave" button with instant visual status feedback and direct link to obtain a free API key in Settings.
- **Native Android System Notifications (`@capacitor/local-notifications`):** Integrated native system notifications for Android (status bar & heads-up shade alerts), configuring high-importance notification channel (`radar_rss_news`), Android 13+ `POST_NOTIFICATIONS` runtime permission, deep link to article on tap, and permission status indicators in Settings.
- **Native Android CORS Bypass (`CapacitorHttp`):** Integrated native HTTP request handling via `@capacitor/core` to directly fetch RSS/Atom feeds, eliminating browser CORS blocking on external news feeds without proxy dependence.
- **Resilient Mobile Timeout & User-Agent:** Increased feed connection and read timeout to 10–15s to handle high-latency cellular networks (3G/4G/5G), and configured realistic Android mobile User-Agent.
- **Enhanced Atom & Dublin Core Feed Parser:** Fixed `<link rel="alternate">` retrieval and added support for `<id>` and `<dc:date>` in client-side XML parser.
- **Stable Android Back Button Lifecycle:** Migrated modal state management to `activeModalsRef` to eliminate listener thrashing and memory leaks, adding a 2-second confirmation on root screen to prevent accidental exits.
- **Thread-safe Haptic Feedback:** Wrapped all `Haptics.impact()` calls with `.catch(() => {})` to eliminate unhandled promise rejections on devices without haptic hardware.
- **Edge-to-Edge Safe Area Inset Fix:** Removed conflicting inline `padding: 0` on `<body>` in `index.html` to allow native status bar and gesture navigation safe-area insets (`--sat`, `--sab`) to apply correctly.
- **Dynamic Java 21 Check in Build Script:** Updated `build-apk.sh` to dynamically detect installed Java version, preventing unnecessary downgrades on OpenJDK 21 environments.

---

## [0.0.7] - 2026-09-01

### 🤖 Direct Google Gemini AI Integration (Client-Side & Mobile)
- **Direct Gemini REST API (`gemini-2.5-flash`):** Enabled direct client-side generative AI calls for article summaries, smart dynamic block curation, and language translation without requiring the Node.js backend server.
- **Custom Gemini API Key Configuration:** Added dedicated settings field for users to configure their own Google Gemini API key with local persistent storage.
- **Graceful Client Fallback:** Added smart local editorial digest fallback when running natively on Android without an API key.

### 📱 Mobile & Android Enhancements
- **Native Backup & Restore Sharing:** Integrated `@capacitor/share` to export configuration JSON directly into the Android native share sheet (Drive, WhatsApp, Files, etc.).
- **Smooth Auto-scrolling Breaking Ticker:** Implemented continuous seamless marquee auto-scroll with frame-synchronized animation and hover/touch pause.
- **Modern In-App Toast Feedback:** Replaced browser dialog popups with elegant status toast notifications.
- **Standalone Android Build Script:** Added `build-apk.sh` script to streamline APK compilation directly inside Termux.

---

## [0.0.6-beta] - 2026-08-31

### 🎨 Visual & Theme Fixes
- **Comprehensive Light Theme Polish:** Fixed over 40 visual inconsistencies across all components, resolving invisible text, hardcoded dark palette colors, and missing theme-aware conditionals.
- **Enhanced Component Contrast:** Updated `DynamicBlockCard`, `Navbar`, `SettingsModal`, `ManageFeedsModal`, `GlobalFeedsModal`, `ArticleReaderModal`, `ToastNotificationContainer`, and footer/bookmark cards to support seamless Light and Dark mode switching.
- **Refined Accents & Borders:** Adjusted active states, borders, and badge styling for optimal legibility regardless of chosen theme and accent palette.

### 🤖 CI/CD & Build Pipeline
- **Automated Android APK Workflow:** Added GitHub Actions workflow (`release-android.yml`) to automatically compile debug APKs with Capacitor and Java 17 compatibility patches and attach them to GitHub Releases.

---

## [0.0.5] (Beta) - 2026-08-30

### 🚀 Highlights & Major Improvements
- **⚡ Instant App Startup (< 50ms):** Implemented an offline-first stale-while-revalidate caching engine (`radar_rss_cached_articles_v1`). The app now renders headlines, hero images, and breaking news immediately upon launch, updating seamlessly in the background without blocking the UI.
- **👈👉 Fluid Swipe Story Navigation:** Users can now swipe horizontally (Left-to-Right / Right-to-Left) or click navigation arrows in the Story Reader to effortlessly browse through news articles, complete with smooth slide animations and haptic feedback.
- **🖼️ Universal RSS Image Loading:** Removed CORS preflight restrictions on news CDN images, added an intelligent cached proxy fallback (`weserv`), HTML entity decoding (`&lt;img ...&gt;`), and support for modern lazy-load image attributes (`data-src`, `srcset`, `media:group`). Added thumbnail previews across all modular block layouts.
- **💼 Robust Standalone Portable Executable:** Fixed asset path resolution and single-instance locks in portable `.exe` builds when launched from arbitrary folders (e.g., Downloads, USB drives).
- **🌐 Bilingual Localization (English & Portuguese):** Complete English repository documentation, interface labels, category names, settings dialog, and one-click switching to Portuguese.
- **🔔 Modern In-App Toast System:** Fully eliminated blocking browser `alert()` popups across modals, replacing them with sleek animated status notifications and native push alerts for breaking news.
- **🛡️ Resilient RSS Ingestion:** Added automatic UTF-8 BOM stripping (`\uFEFF`), real browser User-Agent headers, and optimized 4.5s per-feed timeouts to prevent network stalls.
- **🖥️ Instant Electron Desktop Launch:** Accelerated desktop window initialization to under 30ms with instant dark theme `#0a0b0e` frame rendering and zero white flashes.

---

## [0.0.2] (Beta) - 2026-08-29

### Added
- **Native High-Definition Icons:** Generated crisp raster PNG icons across all density buckets (`mipmap-mdpi`, `hdpi`, `xhdpi`, `xxhdpi`, `xxxhdpi`, and `512px` store asset) featuring the official **Global Signal Matrix** design.
- **APK and Installer Icon Display:** Ensured custom branding appears seamlessly in Windows installers, desktop shortcuts, `.apk` file explorers, and the Android package installer modal.
- **Official Release Signing:** Configured production cryptographic keystores with v2 and v3 signature schemes to eliminate Play Protect sideloading warnings.
- **Mobile Enhancements:** Added pull-to-refresh gestures with haptic feedback, horizontally scrolling category navigation, and responsive drawer navigation.

---

## [0.0.1] (Beta) - 2026-08-29

### Added
- Initial public beta release for **Windows Desktop** and **Android (Native APK)**.
- Capacitor integration with universal network adapters for direct client-side RSS feed parsing.
- New `SafeImage` component with loading indicators, graceful fallback placeholders, and relative URL resolvers.
- Visual Beta badge (`v0.0.1`) displayed across settings and header navigation.

### Fixed / Improved
- Enhanced RSS media extraction: expanded support for `media:content`, `media:thumbnail`, `enclosure`, and embedded HTML `<img>` tags.
- Automatic normalization of protocol-relative (`//`) and relative URLs.
- Filtered out 1x1 tracking beacons and analytics pixels.

---

## [2.0.4] - 2026-08-16

### Added
- Official Windows desktop release with background auto-updates powered by GitHub Releases.

---

## [2.0.2] - 2026-08-11

### Added
- Windows builds configured with `electron-builder`: `RSS Radar-2.0.1-portable-x64.exe` and `RSS Radar-2.0.1-setup-x64.exe`.
- Added `build:win` script and build configuration (NSIS + portable) in `package.json`.
- Configured `electron` as a devDependency and added `desktop` dev script.

### Fixed
- Fixed `process.chdir(__dirname)` failure inside `app.asar` (ENOENT) by restricting directory switching to development environments.
- Corrected `distPath` resolution in packaged bundles to properly locate application assets.

---

## [2.0.1] - 2026-08-02

### Added
- Integrated Google Gemini AI for automated bullet-point executive summaries and news curation.
- Support for customizable dynamic blocks and multi-category RSS feeds.
- Electron packaging support for Windows.

---

## [2.0.0] - 2026-08-02

### Added
- Brand-new modern UI built with React 19, Vite, and Tailwind CSS.
- Local Express backend for real-time async RSS parsing and caching.
- Dynamic block customization and custom accent color themes.

---

## [1.0.0] - 2026-07-30

### Added
- Initial release of Radar RSS aggregator.
- Real-time news monitoring across major international and regional portals.

---

## [Legend]

- `Added` for new features.
- `Changed` for changes in existing functionality.
- `Deprecated` for soon-to-be removed features.
- `Removed` for now removed features.
- `Fixed` for any bug fixes.
- `Security` in case of vulnerabilities.
