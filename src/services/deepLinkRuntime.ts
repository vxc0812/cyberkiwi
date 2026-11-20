/**
 * Opens a story from a link, in three situations:
 *
 *   cold start  the app was closed and was launched by the link. Read with App.getLaunchUrl().
 *   foreground  the app was already running. Arrives as an appUrlOpen event.
 *   web         the page itself was loaded at /story/<id>.
 *
 * All three go through handleAppUrl, so one parser decides what opens. Stories need a signed-in user; App
 * holds a link that arrives before sign-in (or during session restore) and opens it once reads are allowed.
 */
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { parseStoryDeepLink } from './deepLink';

/** Parses one URL and reports the story id, if the URL is a valid story link. Returns whether it was handled. */
export function handleAppUrl(url: string | undefined | null, onStory: (storyId: string) => void): boolean {
  if (!url) return false;
  const id = parseStoryDeepLink(url);
  if (!id) return false;
  onStory(id);
  return true;
}

export async function subscribeStoryLinks(onStory: (storyId: string) => void): Promise<() => void> {
  if (typeof window !== 'undefined') {
    handleAppUrl(`${window.location.origin}${window.location.pathname}`, onStory);
  }
  if (!Capacitor.isNativePlatform()) return () => undefined;

  // Cold start: the launch URL is read once. It is handled here and not again when the listener fires for it.
  const launch = await App.getLaunchUrl().catch(() => undefined);
  let lastHandled: string | undefined = launch?.url;
  handleAppUrl(launch?.url, onStory);

  const handle = await App.addListener('appUrlOpen', ({ url }) => {
    if (url === lastHandled) return;
    lastHandled = url;
    handleAppUrl(url, onStory);
  });
  return () => {
    void handle.remove();
  };
}
