import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Navbar } from './components/Navbar';
import { TickerBar } from './components/TickerBar';
import { DynamicBlockCard } from './components/DynamicBlockCard';
import { ArticleReaderModal } from './components/ArticleReaderModal';
import { CreateBlockModal } from './components/CreateBlockModal';
import { ManageFeedsModal } from './components/ManageFeedsModal';
import { AICuratorModal } from './components/AICuratorModal';
import { SettingsModal } from './components/SettingsModal';
import { GlobalFeedsModal } from './components/GlobalFeedsModal';
import { ToastNotificationContainer } from './components/ToastNotificationContainer';
import { CYBERSEC_DEFAULT_FEEDS } from './data/cybersecFeeds';
import { CYBERSEC_DEFAULT_BLOCKS, migrateCybersecBlocks } from './data/cybersecBlocks';
import { DynamicBlock, NewsItem, NewsStory, RssFeed, AppSettings, BlockLayout, ToastItem } from './types';
import { authedFetchUrl } from './services/apiClient';
import { useAuth } from './auth/AuthContext';
import { readerKey, serverReadGate } from './services/serverReadGate';
import { CyberkiwiApiError, createCyberkiwiApiClient, configuredApiBaseUrl, describeApiError, storyQueryForBlock, type CyberkiwiApiClient } from './services/cyberkiwiApi';
import { storyToNewsStory, groupItemsByStory, mergeArticles, articleToNewsItem } from './services/storyMapper';
import { subscribeStoryLinks } from './services/deepLinkRuntime';
import type { FeedHealthItem } from '../server/api/types';
import { emptyStateFor } from './services/emptyState';

/** Stories requested per page from the CyberKiwi server (the server caps this at 50). */
const STORY_PAGE_SIZE = 50;
import { getAccent } from './utils/theme';
import { Bookmark, Sparkles, Plus, Radio, Layers, RefreshCw, Archive, Trash2, CheckCircle2 } from 'lucide-react';
import { fetchRssFeeds, isNativePlatform, summarizeBlockWithAi } from './services/apiAdapter';
import {
  initializeNotificationChannels,
  sendNativeNotification,
  addNotificationActionListener,
} from './services/notificationService';
import { clusterNewsItems } from './services/clustering/newsClusterService';
import { exportFeedsToOpml, parseOpml } from './services/opmlService';
import { getTranslation } from './i18n/translations';
import { App as CapApp } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Share } from '@capacitor/share';

const STORAGE_KEYS = {
  BLOCKS: 'cyberkiwi_blocks_v1',
  FEEDS: 'cyberkiwi_feeds_v1',
  BOOKMARKS: 'cyberkiwi_bookmarks_v1',
  SETTINGS: 'cyberkiwi_settings_v1',
  ARCHIVED: 'cyberkiwi_archived_ids_v1',
  ARTICLES: 'cyberkiwi_cached_articles_v1',
};

export default function App() {
  // --- Persistent States ---
  const [blocks, setBlocks] = useState<DynamicBlock[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.BLOCKS);
      return saved ? migrateCybersecBlocks(JSON.parse(saved)) : CYBERSEC_DEFAULT_BLOCKS;
  });

  const [feeds, setFeeds] = useState<RssFeed[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.FEEDS);
    if (!saved) return CYBERSEC_DEFAULT_FEEDS;
    try {
      const parsed: RssFeed[] = JSON.parse(saved);
      const mapped = parsed.map((feed): RssFeed => {
        if (feed.url.includes('feeds.folha.uol.com.br')) {
          return { ...feed, id: 'cnn_brasil', title: 'CNN Brasil', url: 'https://www.cnnbrasil.com.br/feed/' };
        }
        if (feed.url.includes('omelete.com.br') || feed.url.includes('jovemnerd.com.br') || feed.id === 'omelete') {
          return { ...feed, id: 'b9', title: 'B9 Cultura e Mídia', url: 'https://www.b9.com.br/feed/', category: 'entertainment', icon: '🎬' };
        }
        return feed;
      });

      // Deduplicate by ID
      const seen = new Set<string>();
      return mapped.filter((f) => {
        if (seen.has(f.id)) return false;
        seen.add(f.id);
        return true;
      });
    } catch {
      return CYBERSEC_DEFAULT_FEEDS;
    }
  });

  const [bookmarkedArticles, setBookmarkedArticles] = useState<NewsItem[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.BOOKMARKS);
    return saved ? JSON.parse(saved) : [];
  });

  const [archivedArticleIds, setArchivedArticleIds] = useState<Set<string>>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.ARCHIVED);
    if (!saved) return new Set();
    try {
      return new Set(JSON.parse(saved));
    } catch {
      return new Set();
    }
  });

  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    const parsed = saved ? JSON.parse(saved) : null;
    const isPtSystem = typeof navigator !== 'undefined' && navigator.language && navigator.language.toLowerCase().startsWith('pt');
    const defaultLang = isPtSystem ? 'pt' : 'en';
    // If the system is PT and user hasn't explicitly selected another language, use pt
    const effectiveLang = (parsed?.languageExplicitlySet) ? parsed.language : (isPtSystem ? 'pt' : (parsed?.language || defaultLang));
    return {
      theme: 'dark',
      globalRefreshSec: 60,
      soundAlerts: true,
      browserNotifications: true,
      breakingKeywords: ['Breaking', 'Urgent', 'Alert', 'Exclusive', 'Developing', 'Bomba', 'Urgente', 'Última Hora'],
      layoutCols: 2,
      deduplication: {
        enabled: true,
        similarityThreshold: 0.58,
        timeWindowHours: 48,
        maxArticlesPerCluster: 12,
        strategy: 'balanced',
      },
      ...parsed,
      language: effectiveLang,
    };
  });

  // --- Runtime States (Instant Hydration from offline cache) ---
  const [allNewsItems, setAllNewsItems] = useState<NewsItem[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.ARTICLES);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  // --- CyberKiwi server (optional): stories are built on the server when configured ---
  const localGuest = (import.meta as any).env?.VITE_CYBERKIWI_LOCAL_GUEST === 'true'
    && !isNativePlatform()
    && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  const apiClient = useMemo<CyberkiwiApiClient | null>(() => {
    try {
      const base = localGuest ? '' : configuredApiBaseUrl((import.meta as any).env ?? {}, isNativePlatform());
      // Story and article reads require sign-in, so requests carry the session (see authedFetchUrl).
      return base === null ? null : createCyberkiwiApiClient({ baseUrl: base, fetchImpl: authedFetchUrl });
    } catch (err) {
      // A misconfigured URL must not break the app: fall back to the local adapter.
      console.error('[CyberKiwi API] disabled:', (err as Error).message);
      return null;
    }
  }, [localGuest]);
  // Stored stories and articles require sign-in: reads wait for session restore, are skipped while
  // signed out, and run again when the signed-in user changes (see serverReadGate.ts).
  const { user: authUser, isLoading: authLoading } = useAuth();
  const authUserId = authUser?.id ?? null;
  const readGate = serverReadGate(apiClient !== null, authLoading, authUserId, localGuest);
  const currentReaderKey = readerKey(readGate, authUserId);
  // Read inside async callbacks to drop answers that belong to a reader who is no longer current.
  const readerKeyRef = useRef<string | null>(currentReaderKey);
  readerKeyRef.current = currentReaderKey;
  const [serverStories, setServerStories] = useState<NewsStory[] | null>(null);
  const [storiesCursor, setStoriesCursor] = useState<string | null>(null);
  const [storiesHasMore, setStoriesHasMore] = useState<boolean>(false);
  const [apiStatus, setApiStatus] = useState<{ state: 'idle' | 'loading' | 'ok' | 'error'; code?: string }>({ state: 'idle' });
  const [blockStories, setBlockStories] = useState<Record<string, NewsStory[]>>({});
  const blockRequestGenRef = useRef<number>(0);
  const [sourceHealth, setSourceHealth] = useState<FeedHealthItem[] | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>('');

  // Debounce search input to avoid re-rendering on every keystroke
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  const [showBookmarksOnly, setShowBookmarksOnly] = useState<boolean>(false);
  const [showArchiveOnly, setShowArchiveOnly] = useState<boolean>(false);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback((toastData: {
    title: string;
    message?: string;
    imageUrl?: string;
    article?: NewsItem;
    type?: 'breaking' | 'info' | 'success' | 'warning';
  }) => {
    const newToast: ToastItem = {
      id: 'toast-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      timestamp: Date.now(),
      ...toastData,
    };
    setToasts((prev) => [newToast, ...prev].slice(0, 5));
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Ref to track notified breaking news IDs to prevent duplicates
  const notifiedIdsRef = useRef<Set<string>>(new Set());
  const isInitialFetchRef = useRef<boolean>(true);

  // Check if an item is breaking news
  const checkIsBreaking = useCallback((item: NewsItem): boolean => {
    if (item.isBreaking) return true;
    const keywords = settings.breakingKeywords || ['Urgente', 'Bomba', 'Atenção', 'Breaking', 'Exclusivo', 'Última Hora'];
    const text = `${item.title} ${item.contentSnippet}`.toLowerCase();
    return keywords.some((kw) => kw.trim() && text.includes(kw.trim().toLowerCase()));
  }, [settings.breakingKeywords]);

  // Audio Chime generator using Web Audio API
  const playAudioChime = useCallback(() => {
    if (!settings.soundAlerts) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15); // A5
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch (err) {
      // Audio context policy ignored
    }
  }, [settings.soundAlerts]);

  // Trigger notification (both Toast Banner & Native OS/Browser Notification safely)
  const triggerNativeNotification = useCallback((item: NewsItem) => {
    // 1. Always show in-app toast for visual guarantee
    addToast({
      title: item.title,
      message: `${item.sourceName}: ${item.contentSnippet || ''}`,
      imageUrl: item.imageUrl,
      article: item,
      type: 'breaking',
    });

    // 2. Play audio alert sound if enabled
    playAudioChime();

    // 3. Native system notification (Windows Toast / Android status bar / Web Notification)
    if (settings.browserNotifications) {
      sendNativeNotification({
        title: `⚡ URGENTE: ${item.sourceName}`,
        body: item.title,
        id: item.id,
        imageUrl: item.imageUrl || 'https://images.unsplash.com/photo-1504711434969-e33886168f5c?auto=format&fit=crop&w=120&q=80',
        article: item,
        onClick: () => {
          setSelectedArticle(item);
          setArchivedArticleIds((prev) => new Set(prev).add(item.id));
        },
      }).catch((err) => {
        console.warn('[Native Notification error]:', err);
      });
    }

    // 4. Flash taskbar frame on Windows if configured
    if (settings.flashTaskbarOnBreaking !== false && window.electronAPI) {
      window.electronAPI.flashFrame(true).catch(() => {});
    }
  }, [settings.browserNotifications, settings.flashTaskbarOnBreaking, addToast, playAudioChime]);

  // --- Modal States ---
  const [selectedArticle, setSelectedArticle] = useState<NewsItem | null>(null);

  // Story deep links (notification taps and story URLs) open the story in the reader. Stories need a
  // signed-in user, so a link that arrives during session restore, or while signed out, waits until
  // reads are allowed (for example, a cold start from a notification on native).
  const [pendingStoryId, setPendingStoryId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void subscribeStoryLinks((storyId) => {
      if (active) setPendingStoryId(storyId);
    }).then((off) => {
      unsubscribe = off;
      if (!active) off();
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);
  useEffect(() => {
    if (!apiClient || !pendingStoryId || currentReaderKey === null) return;
    const key = currentReaderKey;
    setPendingStoryId(null);
    void (async () => {
      try {
        const detail = await apiClient.getStory(pendingStoryId);
        const first = detail.story.articles[0];
        if (readerKeyRef.current === key && first) setSelectedArticle(articleToNewsItem(first));
      } catch {
        // An unknown or unreachable story is ignored. The link never shows an error to the user.
      }
    })();
  }, [apiClient, pendingStoryId, currentReaderKey]);
  const [isCreateBlockOpen, setIsCreateBlockOpen] = useState<boolean>(false);
  const [editingBlock, setEditingBlock] = useState<DynamicBlock | null>(null);
  const [isManageFeedsOpen, setIsManageFeedsOpen] = useState<boolean>(false);
  const [isGlobalFeedsOpen, setIsGlobalFeedsOpen] = useState<boolean>(false);
  const [isAICuratorOpen, setIsAICuratorOpen] = useState<boolean>(false);
  const [settingsView, setSettingsView] = useState<'settings' | 'account' | null>(null);
  const isSettingsOpen = settingsView !== null;
  const [generatingAiBlockId, setGeneratingAiBlockId] = useState<string | null>(null);

  // Persistence Effects
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.BLOCKS, JSON.stringify(blocks));
  }, [blocks]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.FEEDS, JSON.stringify(feeds));
  }, [feeds]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify(bookmarkedArticles));
  }, [bookmarkedArticles]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.ARCHIVED, JSON.stringify(Array.from(archivedArticleIds)));
  }, [archivedArticleIds]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    // Apply HTML dark class
    if (settings.theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    // Apply HTML accent color attribute
    document.documentElement.setAttribute('data-accent', settings.accentColor || 'orange');
  }, [settings]);

  // Handle article selection and mark as archived/read automatically
  const handleSelectArticle = useCallback((item: NewsItem) => {
    setSelectedArticle(item);
    setArchivedArticleIds((prev) => {
      const next = new Set(prev);
      next.add(item.id);
      const story = item as any;
      if (story.articles && Array.isArray(story.articles)) {
        story.articles.forEach((a: NewsItem) => next.add(a.id));
      }
      return next;
    });
  }, []);

  const currentArticleIndex = useMemo(() => {
    if (!selectedArticle) return -1;
    return allNewsItems.findIndex((it) => it.id === selectedArticle.id);
  }, [selectedArticle, allNewsItems]);

  const handleNextArticle = useCallback(() => {
    if (currentArticleIndex >= 0 && currentArticleIndex < allNewsItems.length - 1) {
      handleSelectArticle(allNewsItems[currentArticleIndex + 1]);
    }
  }, [currentArticleIndex, allNewsItems, handleSelectArticle]);

  const handlePrevArticle = useCallback(() => {
    if (currentArticleIndex > 0) {
      handleSelectArticle(allNewsItems[currentArticleIndex - 1]);
    } else {
      setSelectedArticle(null);
    }
  }, [currentArticleIndex, allNewsItems, handleSelectArticle]);

  const handleToggleArchiveItem = useCallback((item: NewsItem) => {
    setArchivedArticleIds((prev) => {
      const next = new Set(prev);
      const story = item as any;
      const ids = (story.articles && Array.isArray(story.articles))
        ? story.articles.map((a: NewsItem) => a.id)
        : [item.id];
      const isArchived = next.has(item.id);
      ids.forEach((id: string) => {
        if (isArchived) next.delete(id);
        else next.add(id);
      });
      return next;
    });
  }, []);

  // --- Shared intake: breaking alerts, chime, and the offline cache ---
  const applyIncomingItems = useCallback((items: NewsItem[]) => {
    setAllNewsItems((prev) => {
      // Detect if new items came in
      if (prev.length > 0 && items.length > prev.length) {
        playAudioChime();
      }

      // Check for Breaking News and trigger native notifications
      items.forEach((item: NewsItem) => {
        if (checkIsBreaking(item) && !notifiedIdsRef.current.has(item.id)) {
          notifiedIdsRef.current.add(item.id);

          // Only trigger if not initial fetch or if news is recent (within last 2 hours)
          const isRecent = (Date.now() - item.timestamp) < (2 * 60 * 60 * 1000);
          if (!isInitialFetchRef.current || isRecent) {
            triggerNativeNotification(item);
          }
        }
      });

      try {
        localStorage.setItem(STORAGE_KEYS.ARTICLES, JSON.stringify(items.slice(0, 150)));
      } catch { }

      isInitialFetchRef.current = false;
      return items;
    });
  }, [playAudioChime, checkIsBreaking, triggerNativeNotification]);

  // --- Per-block server queries: each dashboard block asks for the stories it needs ---
  const loadBlockStories = useCallback(async () => {
    if (!apiClient || currentReaderKey === null) return;
    const generation = ++blockRequestGenRef.current;
    const failures: string[] = [];
    const results = await Promise.all(
      blocks.map(async (block) => {
        try {
          const page = await apiClient.listStories(storyQueryForBlock(block));
          return { id: block.id, stories: page.items.filter((s) => s.articles.length > 0).map(storyToNewsStory) };
        } catch (err) {
          failures.push(err instanceof CyberkiwiApiError ? err.code : 'unknown');
          return null; // keep this block's last good results
        }
      })
    );
    // A newer request has started, or the reader changed: drop this one so the latest results win.
    if (generation !== blockRequestGenRef.current || readerKeyRef.current !== currentReaderKey) return;

    const liveIds = new Set(blocks.map((b) => b.id));
    setBlockStories((prev) => {
      const next: Record<string, NewsStory[]> = {};
      for (const id of Object.keys(prev)) if (liveIds.has(id)) next[id] = prev[id];
      for (const r of results) if (r) next[r.id] = r.stories;
      return next;
    });
    if (failures.length > 0) {
      addToast({ title: 'CyberKiwi', message: describeApiError(failures[0]), type: 'warning' });
    }
  }, [apiClient, blocks, addToast, currentReaderKey]);

  // --- Source health from the server: decides why a block is empty ---
  const loadSourceHealth = useCallback(async () => {
    if (!apiClient) return;
    try {
      const health = await apiClient.getFeedHealth();
      setSourceHealth(health.items);
    } catch {
      // Keep the previous health. Empty blocks then fall back to the generic "no matching stories".
    }
  }, [apiClient]);

  /**
   * Explains an empty block. "No active sources" and "all sources failing" are different problems
   * from "no matching stories", and users should be able to tell them apart.
   */
  const emptyKeyForBlock = useCallback((block: DynamicBlock): 'noArticles' | 'noSources' | 'sourcesFailing' => {
    return emptyStateFor(block, sourceHealth);
  }, [sourceHealth]);

  // --- CyberKiwi server stories (when VITE_CYBERKIWI_API_BASE_URL is configured) ---
  const fetchStoriesFromServer = useCallback(async () => {
    if (!apiClient || currentReaderKey === null) return;
    const key = currentReaderKey;
    setIsRefreshing(true);
    setApiStatus({ state: 'loading' });
    try {
      const page = await apiClient.listStories({ limit: STORY_PAGE_SIZE });
      if (readerKeyRef.current !== key) return; // signed out or another user signed in meanwhile
      const stories = page.items.filter((s) => s.articles.length > 0).map(storyToNewsStory);
      setServerStories(stories);
      setStoriesCursor(page.nextCursor);
      setStoriesHasMore(page.hasMore);
      applyIncomingItems(stories.flatMap((s) => s.articles));
      setLastUpdated(new Date());
      setApiStatus({ state: 'ok' });
      void loadBlockStories();
      void loadSourceHealth();
    } catch (err) {
      if (readerKeyRef.current !== key) return;
      // Keep the cached articles already on screen: this is the stale-cache path.
      const code = err instanceof CyberkiwiApiError ? err.code : 'unknown';
      console.warn('[CyberKiwi API] refresh failed:', code);
      setApiStatus({ state: 'error', code });
      addToast({ title: 'CyberKiwi', message: describeApiError(code), type: 'warning' });
    } finally {
      setIsRefreshing(false);
    }
    // loadBlockStories is left out on purpose, as before: editing a block must not refetch every story.
    // This callback is recreated whenever the reader changes, so it never runs with another reader's key.
  }, [apiClient, applyIncomingItems, addToast, currentReaderKey]);

  const loadMoreStories = useCallback(async () => {
    if (!apiClient || currentReaderKey === null || !storiesHasMore || !storiesCursor) return;
    const key = currentReaderKey;
    try {
      const page = await apiClient.listStories({ limit: STORY_PAGE_SIZE, cursor: storiesCursor });
      if (readerKeyRef.current !== key) return;
      const more = page.items.filter((s) => s.articles.length > 0).map(storyToNewsStory);
      setServerStories((prev) => [...(prev ?? []), ...more]);
      setStoriesCursor(page.nextCursor);
      setStoriesHasMore(page.hasMore);
      setAllNewsItems((prev) => mergeArticles(prev, more.flatMap((s) => s.articles)));
    } catch (err) {
      const code = err instanceof CyberkiwiApiError ? err.code : 'unknown';
      addToast({ title: 'CyberKiwi', message: describeApiError(code), type: 'warning' });
    }
  }, [apiClient, storiesCursor, storiesHasMore, addToast, currentReaderKey]);

  // --- Fetch Feeds: CyberKiwi server when configured, otherwise the local universal adapter ---
  const fetchAllFeeds = useCallback(async () => {
    if (apiClient) {
      // Wait for session restore; the effect below runs again when it finishes.
      if (readGate === 'restoring') return;
      if (readGate === 'signed_out') {
        // Nothing from the server is shown while signed out; saved articles stay on screen.
        blockRequestGenRef.current++;
        setServerStories(null);
        setBlockStories({});
        setStoriesCursor(null);
        setStoriesHasMore(false);
        setApiStatus({ state: 'error', code: 'unauthorized' });
        return;
      }
      await fetchStoriesFromServer();
      return;
    }

    const activeFeeds = feeds.filter((f) => f.active);
    if (activeFeeds.length === 0) return;

    setIsRefreshing(true);
    try {
      const urls = activeFeeds.map((f) => f.url);
      const data = await fetchRssFeeds(urls);

      if (data.success && Array.isArray(data.items)) {
        applyIncomingItems(data.items);
        setLastUpdated(new Date());
      }
    } catch (err) {
      console.error('[Fetch Feeds Error]:', err);
    } finally {
      setIsRefreshing(false);
    }
  }, [apiClient, readGate, fetchStoriesFromServer, feeds, fetchRssFeeds, applyIncomingItems]);

  // --- Mobile Pull-to-Refresh State & Gesture ---
  const [pullDistance, setPullDistance] = useState<number>(0);
  const [isPullRefreshing, setIsPullRefreshing] = useState<boolean>(false);
  const pullDistanceRef = useRef<number>(0);
  const touchStartXRef = useRef<number>(0);
  const touchStartYRef = useRef<number>(0);
  const hasTriggeredHapticRef = useRef<boolean>(false);
  const isPullingActiveRef = useRef<boolean>(false);
  const isHorizontalGestureRef = useRef<boolean>(false);

  // Keep ref in sync with state
  useEffect(() => {
    pullDistanceRef.current = pullDistance;
  }, [pullDistance]);

  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      // Don't activate pull-to-refresh if a modal is open or already refreshing
      if (
        selectedArticle ||
        isSettingsOpen ||
        isManageFeedsOpen ||
        isCreateBlockOpen ||
        isAICuratorOpen ||
        isGlobalFeedsOpen ||
        isRefreshing ||
        isPullRefreshing
      ) {
        isPullingActiveRef.current = false;
        return;
      }

      if (window.scrollY <= 5) {
        touchStartXRef.current = e.touches[0].clientX;
        touchStartYRef.current = e.touches[0].clientY;
        hasTriggeredHapticRef.current = false;
        isPullingActiveRef.current = true;
        isHorizontalGestureRef.current = false;
      } else {
        isPullingActiveRef.current = false;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!isPullingActiveRef.current || window.scrollY > 10) return;

      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;
      const diffX = currentX - touchStartXRef.current;
      const diffY = currentY - touchStartYRef.current;

      // Cancel pull-to-refresh if the user is swiping horizontally (stories, category pills, etc.)
      if (Math.abs(diffX) > Math.abs(diffY) || isHorizontalGestureRef.current) {
        isHorizontalGestureRef.current = true;
        isPullingActiveRef.current = false;
        setPullDistance(0);
        return;
      }

      if (diffY > 0) {
        const distance = Math.min(diffY * 0.45, 80);
        setPullDistance(distance);
        if (distance >= 55 && !hasTriggeredHapticRef.current) {
          hasTriggeredHapticRef.current = true;
          Haptics.impact({ style: ImpactStyle.Light }).catch(() => { });
        }
      } else {
        setPullDistance(0);
      }
    };

    const handleTouchEnd = () => {
      if (!isPullingActiveRef.current) {
        setPullDistance(0);
        return;
      }
      isPullingActiveRef.current = false;
      if (pullDistanceRef.current >= 55) {
        setIsPullRefreshing(true);
        setPullDistance(55);
        fetchAllFeeds().finally(() => {
          setIsPullRefreshing(false);
          setPullDistance(0);
        });
      } else {
        setPullDistance(0);
      }
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, [
    fetchAllFeeds,
    isRefreshing,
    isPullRefreshing,
    selectedArticle,
    isSettingsOpen,
    isManageFeedsOpen,
    isCreateBlockOpen,
    isAICuratorOpen,
    isGlobalFeedsOpen,
  ]);

  // Initial fetch. In server mode this runs again when session restore finishes and whenever the
  // signed-in user changes (sign-in, sign-out, a different account), because fetchAllFeeds depends on it.
  useEffect(() => {
    fetchAllFeeds();
  }, [fetchAllFeeds]);

  // Blocks changed (added, removed, or edited): re-query the server for each block
  useEffect(() => {
    void loadBlockStories();
  }, [loadBlockStories]);

  // Electron IPC Integration (Bandeja / Atalhos Nativos / Notificações)
  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubRefresh = window.electronAPI.onRefreshFeeds(() => {
      fetchAllFeeds();
    });

    const unsubSettings = window.electronAPI.onOpenSettings(() => {
      setSettingsView('settings');
    });

    const unsubSearch = window.electronAPI.onFocusSearch(() => {
      const searchInput = document.querySelector<HTMLInputElement>('input[data-search-input="true"]') ||
                          document.querySelector<HTMLInputElement>('header input[type="text"]');
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    });

    const unsubBookmarks = window.electronAPI.onToggleBookmarks(() => {
      setShowBookmarksOnly((prev) => !prev);
    });

    const unsubCreateBlock = window.electronAPI.onOpenCreateBlock(() => {
      setEditingBlock(null);
      setIsCreateBlockOpen(true);
    });

    const unsubTheme = window.electronAPI.onToggleTheme(() => {
      setSettings((prev) => ({
        ...prev,
        theme: prev.theme === 'dark' ? 'light' : 'dark',
      }));
    });

    const unsubArticle = window.electronAPI.onNavigateToArticle((article: NewsItem) => {
      handleSelectArticle(article);
    });

    return () => {
      unsubRefresh();
      unsubSettings();
      unsubSearch();
      unsubBookmarks();
      unsubCreateBlock();
      unsubTheme();
      unsubArticle();
    };
  }, [fetchAllFeeds, handleSelectArticle]);

  // Atalhos Globais de Teclado Desktop (Esc, Ctrl+F, Ctrl+,, Ctrl+B, F5)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape: fecha o modal ou leitor que estiver ativo no topo
      if (e.key === 'Escape') {
        const state = activeModalsRef.current;
        if (state.selectedArticle) {
          setSelectedArticle(null);
        } else if (state.isSettingsOpen) {
          setSettingsView(null);
        } else if (state.isCreateBlockOpen) {
          setIsCreateBlockOpen(false);
        } else if (state.isManageFeedsOpen) {
          setIsManageFeedsOpen(false);
        } else if (state.isGlobalFeedsOpen) {
          setIsGlobalFeedsOpen(false);
        } else if (state.isAICuratorOpen) {
          setIsAICuratorOpen(false);
        } else if (searchQuery) {
          setSearchQuery('');
        }
        return;
      }

      // Evita disparar atalhos de letra única se o usuário estiver digitando em campo de texto
      const target = e.target as HTMLElement | null;
      const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key.toLowerCase() === 'f') {
          e.preventDefault();
          const searchInput = document.querySelector<HTMLInputElement>('input[data-search-input="true"]') ||
                              document.querySelector<HTMLInputElement>('header input[type="text"]');
          if (searchInput) {
            searchInput.focus();
            searchInput.select();
          }
        } else if (e.key === ',') {
          e.preventDefault();
          setSettingsView((prev) => prev ? null : 'settings');
        } else if (e.key.toLowerCase() === 'b' && !isInput) {
          e.preventDefault();
          setShowBookmarksOnly((prev) => !prev);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchQuery]);

  // Ref para rastrear modais abertos sem recriar o listener do botão Voltar
  const activeModalsRef = useRef({
    selectedArticle,
    isManageFeedsOpen,
    isCreateBlockOpen,
    isGlobalFeedsOpen,
    isAICuratorOpen,
    isSettingsOpen,
    showBookmarksOnly,
    showArchiveOnly,
  });

  useEffect(() => {
    activeModalsRef.current = {
      selectedArticle,
      isManageFeedsOpen,
      isCreateBlockOpen,
      isGlobalFeedsOpen,
      isAICuratorOpen,
      isSettingsOpen,
      showBookmarksOnly,
      showArchiveOnly,
    };
  });

  // Atualização da barra de status no Android nativo conforme o tema
  useEffect(() => {
    if (isNativePlatform()) {
      StatusBar.setBackgroundColor({ color: settings.theme === 'dark' ? '#0a0b0e' : '#f4f4f5' }).catch(() => { });
      StatusBar.setStyle({ style: settings.theme === 'dark' ? Style.Dark : Style.Light }).catch(() => { });
    }
  }, [settings.theme]);

  // Listener estável do botão Voltar do Android
  useEffect(() => {
    if (!isNativePlatform()) return;

    let lastBackPressTime = 0;

    const backListener = CapApp.addListener('backButton', ({ canGoBack }) => {
      const state = activeModalsRef.current;
      if (state.selectedArticle) {
        setSelectedArticle(null);
      } else if (state.isManageFeedsOpen) {
        setIsManageFeedsOpen(false);
      } else if (state.isCreateBlockOpen) {
        setIsCreateBlockOpen(false);
      } else if (state.isGlobalFeedsOpen) {
        setIsGlobalFeedsOpen(false);
      } else if (state.isAICuratorOpen) {
        setIsAICuratorOpen(false);
      } else if (state.isSettingsOpen) {
        setSettingsView(null);
      } else if (state.showBookmarksOnly) {
        setShowBookmarksOnly(false);
      } else if (state.showArchiveOnly) {
        setShowArchiveOnly(false);
      } else if (canGoBack) {
        window.history.back();
      } else {
        const now = Date.now();
        if (now - lastBackPressTime < 2000) {
          CapApp.exitApp();
        } else {
          lastBackPressTime = now;
          Haptics.impact({ style: ImpactStyle.Light }).catch(() => { });
        }
      }
    });

    return () => {
      backListener.then((handle) => handle.remove());
    };
  }, []);

  // Inicialização de canais de notificação nativos e listener de toque
  useEffect(() => {
    initializeNotificationChannels();

    const cleanupListener = addNotificationActionListener((article) => {
      setSelectedArticle(article);
      setArchivedArticleIds((prev) => new Set(prev).add(article.id));
    });

    return () => {
      cleanupListener();
    };
  }, []);

  // Bookmarks helper lookup
  const bookmarkedIds = useMemo(() => {
    return new Set(bookmarkedArticles.map((item) => item.id));
  }, [bookmarkedArticles]);

  const toggleBookmark = (item: NewsItem) => {
    setBookmarkedArticles((prev) => {
      if (prev.some((b) => b.id === item.id)) {
        return prev.filter((b) => b.id !== item.id);
      }
      return [item, ...prev];
    });
  };

  // Filter items per Dynamic Block
  const getBlockNewsItems = useCallback((block: DynamicBlock): NewsItem[] => {
    // Server mode: the block shows the stories its own query returned. Archive and search still apply.
    if (apiClient && serverStories !== null) {
      const stories = blockStories[block.id] ?? [];
      const q = debouncedSearchQuery.trim().toLowerCase();
      const articles = stories
        .flatMap((s) => s.articles)
        .filter((it) => (showArchiveOnly ? archivedArticleIds.has(it.id) : !archivedArticleIds.has(it.id)))
        .filter((it) => !q || it.title.toLowerCase().includes(q) || it.sourceName.toLowerCase().includes(q));
      return groupItemsByStory(articles, stories);
    }

    let list = allNewsItems;

    // Archive / Active filter:
    // If showArchiveOnly is true, show ONLY archived/clicked items.
    // If showArchiveOnly is false, show ONLY non-archived items (so new items overlay on top).
    if (showArchiveOnly) {
      list = list.filter((it) => archivedArticleIds.has(it.id));
    } else {
      list = list.filter((it) => !archivedArticleIds.has(it.id));
    }

    // Search query filter overrides if active
    if (debouncedSearchQuery.trim()) {
      const q = debouncedSearchQuery.toLowerCase();
      list = list.filter(
        (it) =>
          it.title.toLowerCase().includes(q) ||
          it.contentSnippet.toLowerCase().includes(q) ||
          it.sourceName.toLowerCase().includes(q)
      );
    }

    // Category filter
    if (block.categoryFilter && block.categoryFilter !== 'all') {
      if (serverStories) {
        // Server articles carry their feed's category, and their sourceId is a server feed id,
        // so match on the category itself.
        list = list.filter((it) => it.sourceCategory === block.categoryFilter);
      } else {
        const matchingFeedUrls = new Set(
          feeds
            .filter((f) => f.category === block.categoryFilter && f.active)
            .map((f) => f.url)
        );
        list = list.filter((it) => matchingFeedUrls.has(it.sourceId));
      }
    }

    // Keyword Filter (supports regex OR pipe syntax: e.g. "IA|AI|Gemini")
    if (block.filterKeyword) {
      // Terms separated by "|" are matched as plain text. The keyword is never compiled as a regex, so a
      // saved or imported block cannot make the filter backtrack (report F30, F45).
      const terms = String(block.filterKeyword)
        .split('|')
        .map((t) => t.trim().toLowerCase().slice(0, 80))
        .filter(Boolean)
        .slice(0, 20);
      list = list.filter((it) => {
        const haystack = `${it.title} ${it.contentSnippet}`.toLowerCase();
        return terms.some((term) => haystack.includes(term));
      });
    }

    // Cluster items into unified multi-source stories
    // With server stories, the server already clustered them: regroup filtered articles by story.
    // Otherwise (no server, or before the first successful load) cluster on the client as before.
    if (serverStories) return groupItemsByStory(list, serverStories);
    return clusterNewsItems(list, settings.deduplication);
  }, [allNewsItems, feeds, debouncedSearchQuery, showArchiveOnly, archivedArticleIds, settings.deduplication, serverStories, apiClient, blockStories]);

  // Generate AI Summary for Block
  const handleGenerateAISummaryForBlock = async (block: DynamicBlock) => {
    const items = getBlockNewsItems(block);
    if (items.length === 0) return;

    setGeneratingAiBlockId(block.id);
    try {
      const data = await summarizeBlockWithAi(items.slice(0, 8), block.title);
      if (data.success && data.summary) {
        setBlocks((prev) =>
          prev.map((b) =>
            b.id === block.id ? { ...b, aiSummary: data.summary, aiSummaryDate: Date.now() } : b
          )
        );
        addToast({
          title: '🤖 Resumo por IA Gerado',
          message: `Resumo atualizado para o bloco "${block.title}".`,
          type: 'info',
        });
      } else {
        addToast({
          title: 'IA Indisponível',
          message: data.error || 'Erro ao gerar resumo da IA.',
          type: 'warning',
        });
      }
    } catch (err: any) {
      console.error(err);
      addToast({
        title: 'Erro na IA',
        message: 'Falha ao comunicar com o serviço de IA.',
        type: 'warning',
      });
    } finally {
      setGeneratingAiBlockId(null);
    }
  };

  // Handlers for Block CRUD
  const handleSaveBlock = (savedBlock: DynamicBlock) => {
    setBlocks((prev) => {
      const index = prev.findIndex((b) => b.id === savedBlock.id);
      if (index >= 0) {
        const copy = [...prev];
        copy[index] = savedBlock;
        return copy;
      }
      return [...prev, savedBlock];
    });
  };

  const handleDeleteBlock = (blockId: string) => {
    setBlocks((prev) => prev.filter((b) => b.id !== blockId));
  };

  const handleUpdateBlockLayout = (blockId: string, layout: BlockLayout) => {
    setBlocks((prev) =>
      prev.map((b) => (b.id === blockId ? { ...b, layout } : b))
    );
  };

  // Feed Handlers
  const handleToggleFeed = (feedId: string) => {
    setFeeds((prev) =>
      prev.map((f) => (f.id === feedId ? { ...f, active: !f.active } : f))
    );
  };

  const handleAddCustomFeed = (newFeed: RssFeed) => {
    setFeeds((prev) => [newFeed, ...prev]);
  };

  const handleRemoveFeed = (feedId: string) => {
    setFeeds((prev) => prev.filter((f) => f.id !== feedId));
  };

  // Export / Import Config
  const handleExportConfig = async () => {
    const configData = {
      blocks,
      feeds,
      settings,
      exportedAt: new Date().toISOString(),
    };
    const jsonString = JSON.stringify(configData, null, 2);

    if (isNativePlatform()) {
      try {
        await Share.share({
          title: 'CyberKiwi Backup',
          text: jsonString,
          dialogTitle: 'Exportar Backup CyberKiwi',
        });
        addToast({
          title: 'Backup Exportado',
          message: 'Configurações exportadas com sucesso!',
          type: 'success',
        });
        return;
      } catch (err: any) {
        if (err.name === 'AbortError') return;
      }
    }

    try {
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cyberkiwi_backup_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      addToast({
        title: 'Backup Exportado',
        message: 'Arquivo JSON gerado e salvo!',
        type: 'success',
      });
    } catch {
      addToast({
        title: 'Erro ao Exportar',
        message: 'Não foi possível salvar o arquivo de backup.',
        type: 'warning',
      });
    }
  };

  // Export Feeds to OPML (Standard RSS Format)
  const handleExportOpml = async () => {
    const opmlText = exportFeedsToOpml(feeds, 'CyberKiwi Subscriptions');

    if (isNativePlatform()) {
      try {
        await Share.share({
          title: 'CyberKiwi OPML Export',
          text: opmlText,
          dialogTitle: settings.language === 'pt' ? 'Exportar Feeds (OPML)' : 'Export Feeds (OPML)',
        });
        addToast({
          title: settings.language === 'pt' ? 'Feeds Exportados' : 'Feeds Exported',
          message: settings.language === 'pt' ? 'Arquivo OPML compartilhado com sucesso!' : 'OPML file shared successfully!',
          type: 'success',
        });
        return;
      } catch (err: any) {
        if (err.name === 'AbortError') return;
      }
    }

    try {
      const blob = new Blob([opmlText], { type: 'text/x-opml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cyberkiwi_feeds_${Date.now()}.opml`;
      a.click();
      URL.revokeObjectURL(url);
      addToast({
        title: settings.language === 'pt' ? 'Feeds Exportados' : 'Feeds Exported',
        message: settings.language === 'pt' ? 'Arquivo OPML gerado e salvo com sucesso!' : 'OPML file generated and saved successfully!',
        type: 'success',
      });
    } catch {
      addToast({
        title: settings.language === 'pt' ? 'Erro ao Exportar' : 'Export Failed',
        message: settings.language === 'pt' ? 'Não foi possível salvar o arquivo OPML.' : 'Could not save OPML file.',
        type: 'warning',
      });
    }
  };

  // Import Feeds from OPML / XML
  const handleImportOpml = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const result = parseOpml(text);

        if (result.totalParsed === 0) {
          addToast({
            title: settings.language === 'pt' ? 'Nenhuma Fonte Encontrada' : 'No Feeds Found',
            message: settings.language === 'pt'
              ? 'Nenhum feed RSS válido foi encontrado no arquivo selecionado.'
              : 'No valid RSS feeds found in the selected file.',
            type: 'warning',
          });
          return;
        }

        // Compare with existing feeds by lowercase URL
        const existingUrls = new Set(feeds.map((f) => f.url.toLowerCase().trim()));
        const newFeeds = result.feeds.filter((f) => !existingUrls.has(f.url.toLowerCase().trim()));
        const duplicateCount = result.totalParsed - newFeeds.length;

        if (newFeeds.length > 0) {
          setFeeds((prev) => [...newFeeds, ...prev]);
          const msg = settings.language === 'pt'
            ? `${newFeeds.length} novas fontes importadas com sucesso! ${duplicateCount > 0 ? `(${duplicateCount} já cadastradas)` : ''}`
            : `${newFeeds.length} new feeds imported successfully! ${duplicateCount > 0 ? `(${duplicateCount} already existed)` : ''}`;
          addToast({
            title: settings.language === 'pt' ? 'Feeds Importados' : 'Feeds Imported',
            message: msg,
            type: 'success',
          });
          // Trigger a feed refresh to fetch the newly imported feeds
          fetchAllFeeds();
        } else {
          addToast({
            title: settings.language === 'pt' ? 'Nenhum Feed Novo' : 'No New Feeds',
            message: settings.language === 'pt'
              ? `Todas as ${result.totalParsed} fontes deste arquivo já estão cadastradas.`
              : `All ${result.totalParsed} feeds in this file are already subscribed.`,
            type: 'info',
          });
        }
      } catch (err: any) {
        addToast({
          title: settings.language === 'pt' ? 'Falha na Importação' : 'Import Failed',
          message: settings.language === 'pt'
            ? 'Erro ao processar o arquivo OPML/XML selecionado.'
            : 'Error processing the selected OPML/XML file.',
          type: 'warning',
        });
      } finally {
        e.target.value = '';
      }
    };
    reader.readAsText(file);
  };

  const handleImportConfig = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;

        // Smart fallback: if user selected an OPML/XML file here, delegate to OPML parser
        if (text.trim().startsWith('<?xml') || text.includes('<opml') || file.name.endsWith('.opml') || file.name.endsWith('.xml')) {
          const result = parseOpml(text);
          if (result.totalParsed > 0) {
            const existingUrls = new Set(feeds.map((f) => f.url.toLowerCase().trim()));
            const newFeeds = result.feeds.filter((f) => !existingUrls.has(f.url.toLowerCase().trim()));
            if (newFeeds.length > 0) {
              setFeeds((prev) => [...newFeeds, ...prev]);
              addToast({
                title: settings.language === 'pt' ? 'Feeds Importados (OPML)' : 'Feeds Imported (OPML)',
                message: settings.language === 'pt'
                  ? `${newFeeds.length} fontes importadas com sucesso via OPML!`
                  : `${newFeeds.length} feeds imported successfully via OPML!`,
                type: 'success',
              });
              fetchAllFeeds();
            }
            return;
          }
        }

        const parsed = JSON.parse(text);
        if (parsed.blocks && Array.isArray(parsed.blocks)) setBlocks(parsed.blocks);
        if (parsed.feeds && Array.isArray(parsed.feeds)) setFeeds(parsed.feeds);
        if (parsed.settings) setSettings(parsed.settings);
        addToast({
          title: 'Backup Restaurado',
          message: 'Configurações e fontes importadas com sucesso!',
          type: 'success',
        });
      } catch (err) {
        addToast({
          title: 'Falha na Importação',
          message: 'Arquivo de backup JSON inválido ou corrompido.',
          type: 'warning',
        });
      } finally {
        e.target.value = '';
      }
    };
    reader.readAsText(file);
  };

  // Reset to Defaults
  const handleResetToDefaults = () => {
    if (confirm('Deseja redefinir os blocos e feeds para o estado inicial padrão?')) {
      setBlocks(CYBERSEC_DEFAULT_BLOCKS);
      setFeeds(CYBERSEC_DEFAULT_FEEDS);
      localStorage.removeItem(STORAGE_KEYS.BLOCKS);
      localStorage.removeItem(STORAGE_KEYS.FEEDS);
      setSettingsView(null);
      fetchAllFeeds();
    }
  };

  // Filter visible blocks when category tab is selected
  const visibleBlocks = useMemo(() => {
    if (selectedCategory === 'all') return blocks;
    if (selectedCategory === 'podcasts') return blocks.filter((b) => b.categoryFilter === 'podcasts' || b.id.includes('podcast'));
    return blocks.filter((b) => b.categoryFilter === selectedCategory || b.id.includes(selectedCategory));
  }, [blocks, selectedCategory]);

  const handleSelectCategory = (cat: string) => {
    setSelectedCategory(cat);
    if (cat === 'saved') {
      setShowBookmarksOnly(true);
      setShowArchiveOnly(false);
    } else {
      setShowBookmarksOnly(false);
      setShowArchiveOnly(false);
    }
  };

  const goHome = () => {
    handleSelectCategory('all');
    setSearchQuery('');
    setDebouncedSearchQuery('');
    setPendingStoryId(null);
    setSelectedArticle(null);
    if (window.location.pathname !== '/' || window.location.search || window.location.hash) {
      window.history.replaceState(null, '', '/');
    }
    window.scrollTo(0, 0);
  };

  return (
    <div className={`min-h-screen transition-colors duration-200 font-sans relative ${settings.theme === 'dark' ? 'bg-[#0a0b0e] text-neutral-100' : 'bg-neutral-100 text-neutral-900'
      }`}>

      {/* Ambient background glow in dark mode */}
      {settings.theme === 'dark' && (
        <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden opacity-30">
          <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-gradient-to-b from-amber-500/10 via-amber-500/5 to-transparent blur-3xl" />
        </div>
      )}

      {/* Top Navbar */}
      <Navbar
        onRefreshAll={fetchAllFeeds}
        isRefreshing={isRefreshing}
        lastUpdated={lastUpdated}
        autoRefreshSec={settings.globalRefreshSec}
        onOpenCreateBlock={() => {
          setEditingBlock(null);
          setIsCreateBlockOpen(true);
        }}
        onOpenManageFeeds={() => setIsManageFeedsOpen(true)}
        onOpenGlobalFeeds={() => setIsGlobalFeedsOpen(true)}
        onOpenAICurator={() => setIsAICuratorOpen(true)}
        onOpenSettings={() => setSettingsView('settings')}
        onOpenAccount={() => setSettingsView('account')}
        onHome={goHome}
        signedIn={authUser !== null}
        onToggleBookmarks={() => {
          setShowBookmarksOnly(!showBookmarksOnly);
          setShowArchiveOnly(false);
          if (!showBookmarksOnly) setSelectedCategory('saved');
          else setSelectedCategory('all');
        }}
        showBookmarksOnly={showBookmarksOnly}
        bookmarkCount={bookmarkedArticles.length}
        onToggleArchive={() => {
          setShowArchiveOnly(!showArchiveOnly);
          setShowBookmarksOnly(false);
        }}
        showArchiveOnly={showArchiveOnly}
        archivedCount={archivedArticleIds.size}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        settings={settings}
        onUpdateSettings={setSettings}
        totalArticlesCount={allNewsItems.length}
        newArticlesCount={0}
        selectedCategory={selectedCategory}
        onSelectCategory={handleSelectCategory}
      />

      {/* Breaking News Ticker Bar */}
      <TickerBar
        items={allNewsItems}
        onSelectArticle={handleSelectArticle}
        theme={settings.theme}
        accentColor={settings.accentColor}
        language={settings.language}
      />

      {/* Pull to Refresh Mobile Indicator */}
      {pullDistance > 0 && (
        <div
          style={{ height: `${pullDistance}px`, opacity: Math.min(pullDistance / 45, 1) }}
          className="overflow-hidden flex items-center justify-center transition-all duration-75 pointer-events-none sticky top-16 z-30"
        >
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-neutral-900/95 border border-amber-500/60 shadow-[0_0_20px_rgba(245,158,11,0.25)] text-amber-400 text-sm font-bold">
            <RefreshCw
              className={`w-4 h-4 ${isPullRefreshing ? 'animate-spin' : ''}`}
              style={{ transform: isPullRefreshing ? undefined : `rotate(${pullDistance * 5}deg)` }}
            />
            <span>
              {isPullRefreshing
                ? (settings.language === 'pt' ? 'Sincronizando Feeds...' : 'Syncing Feeds...')
                : pullDistance >= 55
                  ? (settings.language === 'pt' ? 'Solte para Atualizar!' : 'Release to Refresh!')
                  : (settings.language === 'pt' ? 'Puxe para Atualizar' : 'Pull to Refresh')}
            </span>
          </div>
        </div>
      )}

      {/* Main Content Dashboard */}
      <main className="max-w-[1680px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">

        {readGate === 'signed_out' && !showBookmarksOnly && !showArchiveOnly && (
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-amber-500/40 bg-amber-500/10 p-4">
            <p className="text-sm">
              {settings.language === 'pt'
                ? 'Entre ou crie uma conta para ler as notícias.'
                : 'Sign in or create an account to read stories.'}
            </p>
            <button
              type="button"
              onClick={() => setSettingsView('account')}
              className="cursor-pointer rounded-control bg-amber-500 px-3 py-2 text-sm font-bold text-black hover:bg-amber-400"
            >
              {settings.language === 'pt' ? 'Entrar' : 'Sign in'}
            </button>
          </section>
        )}
        {(readGate === 'ready' || readGate === 'guest') && apiStatus.state === 'error' && (
          <p role="status" className="rounded-card border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
            {describeApiError(apiStatus.code ?? 'unknown')}
          </p>
        )}

        {/* Archive View Header Banner */}
        {showArchiveOnly && (
          <div className="p-4 rounded-hero bg-amber-500/10 border border-amber-500/40 flex flex-wrap items-center justify-between gap-4 shadow-lg">
            <div className="flex items-center gap-3">
              <Archive className="w-6 h-6 text-amber-500" />
              <div>
                <h2 className="font-display font-bold text-heading flex items-center gap-2">
                  {settings.language === 'pt' ? `Notícias Arquivadas / Lidas (${archivedArticleIds.size})` : `Archived / Read Articles (${archivedArticleIds.size})`}
                  <span className="text-sm bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded border border-amber-500/30">
                    {settings.language === 'pt' ? 'Auto-arquivadas ao clicar' : 'Auto-archived on click'}
                  </span>
                </h2>
                <p className={`text-sm ${settings.theme === 'dark' ? 'text-neutral-400' : 'text-neutral-600'}`}>
                  {settings.language === 'pt'
                    ? 'As notícias que você clica são guardadas aqui para manter seu feed principal limpo e focado em novidades.'
                    : 'Articles you click are preserved here to keep your main dashboard clean and focused on breaking stories.'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {archivedArticleIds.size > 0 && (
                <button
                  onClick={() => {
                    if (confirm(settings.language === 'pt' ? 'Deseja limpar todo o histórico de notícias arquivadas?' : 'Clear all archived reading history?')) {
                      setArchivedArticleIds(new Set());
                    }
                  }}
                  className="px-3 py-2 rounded-card text-sm font-bold bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30 transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{settings.language === 'pt' ? 'Esvaziar Arquivo' : 'Clear Archive'}</span>
                </button>
              )}

              <button
                onClick={() => setShowArchiveOnly(false)}
                className="px-4 py-2 rounded-card text-sm font-black bg-amber-500 text-black hover:bg-amber-400 transition-colors cursor-pointer"
              >
                {settings.language === 'pt' ? 'Voltar às Novidades' : 'Back to News'}
              </button>
            </div>
          </div>
        )}

        {/* Bookmarks Only View Header */}
        {showBookmarksOnly && (
          <div className={`p-4 rounded-hero ${getAccent(settings.accentColor).bgLight} border ${getAccent(settings.accentColor).borderLight} flex items-center justify-between gap-4 shadow-lg`}>
            <div className="flex items-center gap-3">
              <Bookmark className={`w-6 h-6 ${getAccent(settings.accentColor).text} ${getAccent(settings.accentColor).fill}`} />
              <div>
                <h2 className="font-display font-bold text-heading">
                  {settings.language === 'pt' ? `Suas Matérias Salvas (${bookmarkedArticles.length})` : `Saved Bookmarks (${bookmarkedArticles.length})`}
                </h2>
                <p className={`text-sm ${settings.theme === 'dark' ? 'text-neutral-400' : 'text-neutral-600'}`}>
                  {settings.language === 'pt' ? 'Leitura offline e artigos marcados para ler mais tarde' : 'Offline bookmarks and saved stories for later'}
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowBookmarksOnly(false)}
              className={`px-4 py-2 rounded-card text-sm font-black ${getAccent(settings.accentColor).bg} text-black ${getAccent(settings.accentColor).bgHover} transition-colors cursor-pointer`}
            >
              {settings.language === 'pt' ? 'Voltar ao Painel' : 'Back to Dashboard'}
            </button>
          </div>
        )}

        {/* Display Bookmarks List View if active */}
        {showBookmarksOnly ? (
          bookmarkedArticles.length === 0 ? (
            <div className={`text-center py-20 text-sm ${settings.theme === 'dark' ? 'text-neutral-400' : 'text-neutral-600'}`}>
              {settings.language === 'pt'
                ? 'Nenhuma matéria salva no seu banco local. Clique no ícone de bookmark para salvar notícias.'
                : 'No bookmarked articles yet. Click the bookmark icon on any article to save it here.'}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {bookmarkedArticles.map((item) => (
                <div
                  key={item.id}
                  onClick={() => handleSelectArticle(item)}
                  className={`p-5 rounded-hero border flex flex-col justify-between group cursor-pointer transition-all ${settings.theme === 'dark' ? `bg-neutral-800 border-neutral-700 ${getAccent(settings.accentColor).borderHover}` : `bg-white border-neutral-200 ${getAccent(settings.accentColor).borderHover}`
                    }`}
                >
                  <div>
                    <span className={`text-sm font-black ${getAccent(settings.accentColor).text} mb-2 block`}>{item.sourceName}</span>
                    <h3 className={`font-display font-bold text-heading mb-2 ${getAccent(settings.accentColor).groupTextHover} transition-colors leading-snug`}>{item.title}</h3>
                    <p className={`text-sm line-clamp-3 leading-relaxed ${settings.theme === 'dark' ? 'text-neutral-400' : 'text-neutral-600'}`}>{item.contentSnippet}</p>
                  </div>
                  <div className={`pt-3 border-t mt-4 flex items-center justify-between text-sm ${settings.theme === 'dark' ? 'text-neutral-400' : 'text-neutral-600'} ${
                    settings.theme === 'dark' ? 'border-neutral-700/50' : 'border-neutral-200'
                  }`}>
                    <span>{item.pubDate}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleBookmark(item);
                      }}
                      className={`${getAccent(settings.accentColor).text} hover:underline font-bold cursor-pointer`}
                    >
                      {settings.language === 'pt' ? 'Remover' : 'Remove'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : readGate !== 'signed_out' || allNewsItems.length > 0 || showArchiveOnly ? (
          /* Dynamic Blocks Layout Grid */
          <div className={`grid grid-cols-1 ${settings.layoutCols === 1
              ? 'lg:grid-cols-1'
              : settings.layoutCols === 2
                ? 'lg:grid-cols-2'
                : 'lg:grid-cols-3'
            } gap-6`}>
            {visibleBlocks.map((block) => {
              const blockItems = getBlockNewsItems(block);
              return (
                <DynamicBlockCard
                  key={block.id}
                  block={block}
                  items={blockItems}
                  emptyKey={emptyKeyForBlock(block)}
                  isLoading={isRefreshing}
                  onRefreshBlock={fetchAllFeeds}
                  onSelectArticle={handleSelectArticle}
                  onToggleBookmark={toggleBookmark}
                  onEditBlock={() => {
                    setEditingBlock(block);
                    setIsCreateBlockOpen(true);
                  }}
                  onDeleteBlock={() => handleDeleteBlock(block.id)}
                  onUpdateBlockLayout={(layout) => handleUpdateBlockLayout(block.id, layout)}
                  onGenerateAISummary={() => handleGenerateAISummaryForBlock(block)}
                  isGeneratingAI={generatingAiBlockId === block.id}
                  theme={settings.theme}
                  accentColor={settings.accentColor}
                  bookmarkedIds={bookmarkedIds}
                  archivedIds={archivedArticleIds}
                  onToggleArchive={handleToggleArchiveItem}
                  language={settings.language}
                />
              );
            })}
          </div>
        ) : null}

        {/* Dashboard status */}
        {readGate !== 'signed_out' && <footer className={`rounded-card p-3 border flex items-center gap-3 text-sm ${settings.theme === 'dark'
            ? 'bg-neutral-900/80 border-neutral-800 text-neutral-400'
            : 'bg-neutral-200/60 border-neutral-300 text-neutral-700'
          }`}>
          <span>{allNewsItems.length} {settings.language === 'pt' ? 'artigos' : 'articles'}</span>
          {lastUpdated && <span>{settings.language === 'pt' ? 'Atualizado' : 'Updated'} {lastUpdated.toLocaleTimeString()}</span>}
        </footer>}

        {apiClient && storiesHasMore && (
          <div className="flex flex-col items-center gap-2 py-4">
            <button
              type="button"
              onClick={() => void loadMoreStories()}
              className="px-4 py-2 rounded-control border text-sm font-bold border-neutral-700 hover:border-neutral-500 transition-colors"
            >
              {settings.language === 'en' ? 'Load more stories' : 'Carregar mais histórias'}
            </button>
          </div>
        )}
      </main>

      {/* --- Modals --- */}

      {/* Article Reader Modal */}
      <ArticleReaderModal
        article={selectedArticle}
        onClose={() => setSelectedArticle(null)}
        onToggleBookmark={toggleBookmark}
        isBookmarked={selectedArticle ? bookmarkedIds.has(selectedArticle.id) : false}
        theme={settings.theme}
        accentColor={settings.accentColor}
        language={settings.language}
        defaultReaderMode={settings.defaultReaderMode || 'full'}
        onNextArticle={handleNextArticle}
        onPrevArticle={handlePrevArticle}
        hasNext={currentArticleIndex >= 0 && currentArticleIndex < allNewsItems.length - 1}
        hasPrev={currentArticleIndex > 0}
      />

      {/* Create / Edit Dynamic Block Modal */}
      <CreateBlockModal
        isOpen={isCreateBlockOpen}
        onClose={() => {
          setIsCreateBlockOpen(false);
          setEditingBlock(null);
        }}
        onSaveBlock={handleSaveBlock}
        initialBlock={editingBlock}
        availableFeeds={feeds}
        theme={settings.theme}
        language={settings.language}
      />

      {/* Manage Feeds Catalog Modal */}
      <ManageFeedsModal
        isOpen={isManageFeedsOpen}
        onClose={() => setIsManageFeedsOpen(false)}
        feeds={feeds}
        onToggleFeed={handleToggleFeed}
        onAddCustomFeed={handleAddCustomFeed}
        onRemoveFeed={handleRemoveFeed}
        onExportConfig={handleExportConfig}
        onImportConfig={handleImportConfig}
        onExportOpml={handleExportOpml}
        onImportOpml={handleImportOpml}
        theme={settings.theme}
        language={settings.language}
      />

      {/* Gemini AI Smart Curator Modal */}
      <AICuratorModal
        isOpen={isAICuratorOpen}
        onClose={() => setIsAICuratorOpen(false)}
        onBlockCurated={handleSaveBlock}
        theme={settings.theme}
        language={settings.language}
      />

      {/* Global Feeds Recommendations Modal */}
      <GlobalFeedsModal
        isOpen={isGlobalFeedsOpen}
        onClose={() => setIsGlobalFeedsOpen(false)}
        activeFeeds={feeds}
        onAddFeed={handleAddCustomFeed}
        theme={settings.theme}
        language={settings.language}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        accountOnly={settingsView === 'account'}
        onClose={() => setSettingsView(null)}
        settings={settings}
        onUpdateSettings={setSettings}
        onResetToDefaults={handleResetToDefaults}
        onTriggerToast={(toast) => addToast(toast)}
      />

      {/* Floating In-App Toast Notifications */}
      <ToastNotificationContainer
        toasts={toasts}
        onDismiss={removeToast}
        onSelectArticle={handleSelectArticle}
        accentColor={settings.accentColor}
        theme={settings.theme}
        language={settings.language}
      />

    </div>
  );
}
