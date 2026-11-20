/**
 * Deep links into stories: cyberkiwi://story/<uuid> (notifications) and https://cyberkiwi.app/story/<uuid>.
 *
 * Only a well-formed UUID is accepted. Anything else returns null and the app ignores the link.
 * Stories are public reads, so opening one does not require sign-in.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOM_SCHEME = /^cyberkiwi:\/\/story\/([^/?#]+)\/?$/i;
const WEB = /^https:\/\/cyberkiwi\.app\/story\/([^/?#]+)\/?$/i;

export function parseStoryDeepLink(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const match = CUSTOM_SCHEME.exec(raw.trim()) ?? WEB.exec(raw.trim());
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return UUID.test(id) ? id.toLowerCase() : null;
}
