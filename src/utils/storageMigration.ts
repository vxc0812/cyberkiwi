/**
 * One-time migration from the legacy Radar RSS / RadarSec storage keys to the
 * CyberKiwi keys. Safe to run on every start: it only copies when the new key is
 * missing, and it never throws (private mode or blocked storage must not stop startup).
 */
const LEGACY_TO_CURRENT: Array<[string, string]> = [
  ['radarsec_blocks_v1', 'cyberkiwi_blocks_v1'],
  ['radarsec_feeds_v1', 'cyberkiwi_feeds_v1'],
  ['radarsec_bookmarks_v1', 'cyberkiwi_bookmarks_v1'],
  ['radarsec_settings_v1', 'cyberkiwi_settings_v1'],
  ['radarsec_archived_ids_v1', 'cyberkiwi_archived_ids_v1'],
  ['radarsec_cached_articles_v1', 'cyberkiwi_cached_articles_v1'],
  ['radar_rss_bookmarks_v1', 'cyberkiwi_service_bookmarks_v1'],
  ['radar_rss_settings_v1', 'cyberkiwi_settings_v1'],
];

export function migrateLocalStorage(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    for (const [oldKey, newKey] of LEGACY_TO_CURRENT) {
      const legacy = localStorage.getItem(oldKey);
      if (legacy !== null && localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, legacy);
      }
      if (legacy !== null) localStorage.removeItem(oldKey);
    }
    // API keys must never persist in browser storage (product plan, Phase 0).
    const rawSettings = localStorage.getItem('cyberkiwi_settings_v1');
    if (rawSettings) {
      const parsed = JSON.parse(rawSettings);
      if (parsed && typeof parsed === 'object' && 'geminiApiKey' in parsed) {
        delete parsed.geminiApiKey;
        localStorage.setItem('cyberkiwi_settings_v1', JSON.stringify(parsed));
      }
    }
  } catch {
    // Malformed or unavailable storage must not block app startup.
  }
}
