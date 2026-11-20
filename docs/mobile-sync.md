# Mobile sync and conflict rules

Status: rules only. Supported today: foreground synchronization on launch and on resume (Capacitor App events).
Not built yet: the SQLite outbox, background refresh and the client sync engine. Each is a separate task in the implementation plan.

## Principles

- The server is the source of truth. The app keeps a cache and an outbox, and the UI updates optimistically.
- Every write from the app carries a client-generated UUID (`clientId`). The server treats a repeated `clientId` as the same write, so a retry after a dropped connection cannot duplicate or reorder anything.
- Sync runs when the app launches and when it resumes. Background refresh is best-effort only. The server worker keeps articles current whether or not the phone wakes up.
- Nothing about the user is stored in clear text on the device beyond what the UI needs. Session tokens live in the Keychain/Keystore (refresh) and memory (access). They never go to SQLite.

## Outbox

A single SQLite table holds queued writes:

| column | meaning |
|---|---|
| `client_id` | UUID created on the device, unique |
| `kind` | `bookmark`, `read_state`, `chat_message`, `settings` |
| `payload` | JSON of the write |
| `created_at` | device time, used for display only |
| `attempts`, `next_attempt_at` | exponential backoff, capped at 1 hour |

The outbox is flushed in `created_at` order on launch, resume and reconnect. A `401` pauses the flush until the session is refreshed. A `409` (conflict) is handled by the rules below. Anything else keeps the write and retries.

## Bookmarks

Operations: `add(storyId)` and `remove(storyId)`.

- Each bookmark has a server `updatedAt` and a `deletedAt` tombstone. Tombstones are kept for 30 days.
- Conflict rule: **last writer wins per story**, comparing the server-assigned time of each operation. The device never decides which of two operations came last.
- A removal is a tombstone, so an older `add` from another device cannot resurrect it.

## Read and archive state

Operations: `markRead(articleId)`, `markUnread(articleId)`, `archive(articleId)`, `unarchive(articleId)`.

- `read` is **grow-only** by default: once any device marks an article read, it stays read. This matches how people use a news feed and avoids flicker.
- Explicit `markUnread` is recorded as a timestamped operation, and the latest timestamped operation wins for that article.
- `archive` and `unarchive` follow the same latest-operation-wins rule as bookmarks.

## Chat messages

Operations: `sendMessage(storyId, text)` only. Messages are never edited or deleted from the client.

- Each message has a client-generated `clientId`. The server dedupes on it, so a resend stores nothing new.
- Messages are append-only, so there is no content conflict to resolve. Order is the server receive time. The device's clock is shown but never used to order messages.
- If a message fails for good (for example a quota error), it stays in the outbox marked `failed` and the UI offers to discard it. It is never silently dropped.

## Settings and preferences

- Stored on the server as one document per user, with a `revision` counter.
- A client sends the revision it last saw. If the server has moved on, the server returns `409` with the current document, and the client shows the server values. The user's local change is re-applied only if they confirm it.

## Deep links

- A notification carries only `cyberkiwi://story/<id>`, never article text.
- If the user is signed out when the link opens, the app keeps the story id, asks them to sign in, and opens the story afterwards.

## Limits and testing

- Outbox size is capped (for example 500 writes). When it is full, the UI tells the user, and the app does not drop writes silently.
- Before the sync engine is built, these tests should exist: duplicate `clientId` is idempotent; a removed bookmark stays removed after an older add arrives; a read article stays read after a conflicting unread from an older operation; chat order is server order.
