/**
 * Which new articles are breaking news, and which devices want them.
 *
 * Breaking is decided from the article title at ingestion time, using phrases that signal active risk. Only
 * new or changed articles are checked, so a re-run of the same feed never re-notifies. This is a title rule,
 * not a CVSS or KEV lookup. It is a precise but deliberately small list.
 */
const BREAKING = /\b(?:zero[- ]day|actively exploited|exploited in the wild|under active attack|emergency patch|out-of-band (?:patch|update)|critical (?:vulnerability|flaw|rce))\b/i;

export function isBreakingTitle(title: string): boolean {
  return BREAKING.test(title);
}

export interface PrefsLike {
  breaking?: unknown;
  categories?: unknown;
}

/**
 * A device wants a breaking alert for a category when breaking is on, and either it has no category list
 * (all categories) or the list includes this category.
 */
export function wantsBreaking(prefs: unknown, category: string): boolean {
  const p = (prefs && typeof prefs === 'object' ? prefs : {}) as PrefsLike;
  if (p.breaking !== true) return false;
  const categories = Array.isArray(p.categories) ? p.categories.filter((c): c is string => typeof c === 'string') : [];
  return categories.length === 0 || categories.includes(category);
}
