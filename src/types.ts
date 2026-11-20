export type Sentiment = 'positive' | 'negative' | 'neutral';

export type FeedCategory = 
  // Cybersec categories (new)
  | 'vulnerabilities' 
  | 'vendor-advisories'
  | 'threat-intel'
  | 'exploits'
  | 'malware'
  | 'news'
  | 'cloud'
  | 'iot'
  | 'appsec'
  | 'devsecops'
  | 'privacy'
  | 'crypto'
  | 'cert'
  | 'bugbounty'
  | 'podcasts'
  // Legacy categories (for backward compatibility with globalFeeds, OPML)
  | 'tech'
  | 'brazil'
  | 'world'
  | 'finance'
  | 'sports'
  | 'entertainment'
  | 'ai'
  | 'custom';

export interface CveData {
  cveIds: string[];
  maxCVSS: number;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  isKnownExploited: boolean;
  maxEPSS: number;
  cwes: string[];
  affectedProducts: string[];
}

export interface NewsItem {
  id: string;
  title: string;
  link: string;
  contentSnippet: string;
  contentHtml?: string;
  pubDate: string; // ISO or formatted
  timestamp: number;
  sourceId: string;
  sourceName: string;
  sourceCategory: string;
  author?: string;
  imageUrl?: string;
  sentiment?: Sentiment;
  isRead?: boolean;
  isBookmarked?: boolean;
  isBreaking?: boolean;
  tags?: string[];
  cveData?: CveData;
  mitreTechniques?: string[];
}

export interface RssFeed {
  id: string;
  title: string;
  url: string;
  category: FeedCategory;
  icon?: string;
  active: boolean;
  status: 'ok' | 'error' | 'loading';
  lastUpdated?: number;
  errorMsg?: string;
  severityFilter?: ('critical' | 'high' | 'medium' | 'low')[];
  tags?: string[];
}

export type BlockLayout = 'hero' | 'grid' | 'compact' | 'list' | 'media-wall' | 'ticker';

/** Enrichment filters for a block. Each maps to one query parameter of GET /api/v1/stories. */
export interface EnrichmentFilters {
  minEpss?: number;
  kev?: boolean;
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'none';
  vendor?: string;
  technique?: string;
  cve?: string;
}

export interface DynamicBlock {
  id: string;
  enrichment?: EnrichmentFilters;
  title: string;
  categoryFilter?: string; // 'all' or specific feed category
  feedIds?: string[]; // specific feeds to pull from (if empty, pulls from all active category feeds)
  filterKeyword?: string; // e.g. "Inteligência Artificial" or "Mercado"
  layout: BlockLayout;
  itemCount: number; // 3 to 20
  autoRefreshSec: number;
  isPinned?: boolean;
  aiSummary?: string;
  aiSummaryDate?: number;
  accentColor?: string;
}

export type AccentColor = 'orange' | 'emerald' | 'cyan' | 'purple' | 'red' | 'amber' | 'blue' | 'pink' | 'violet' | 'kev-red' | 'epss-purple';

export interface ClusterSource {
  sourceName: string;
  sourceId: string;
  link: string;
  title: string;
  timestamp: number;
  pubDate: string;
  author?: string;
  imageUrl?: string;
  contentSnippet: string;
  contentHtml?: string;
}

export interface NewsStory extends NewsItem {
  articles: NewsItem[];
  sourcesCount: number;
  uniqueSources: ClusterSource[];
  isCluster: boolean;
  clusterId: string;
  consolidatedAiSummary?: string;
}

export type ClusteringStrategy = 'balanced' | 'conservative' | 'aggressive';

export type ReaderViewMode = 'full' | 'snippet';

export interface ExtractedArticle {
  title: string;
  byline?: string;
  siteName?: string;
  excerpt?: string;
  contentHtml: string;
  textContent: string;
  length: number;
  wordCount: number;
  readingTimeMinutes: number;
  leadImageUrl?: string;
  url: string;
  extractedAt: number;
}

export interface DeduplicationSettings {
  enabled: boolean;
  similarityThreshold: number; // 0.0 to 1.0 (e.g. 0.62)
  timeWindowHours: number; // hours e.g. 48
  maxArticlesPerCluster: number; // e.g. 10
  strategy: ClusteringStrategy;
}

export interface AppSettings {
  language?: 'en' | 'pt';
  theme: 'dark' | 'light';
  accentColor?: AccentColor;
  globalRefreshSec: number; // e.g., 60
  soundAlerts: boolean;
  browserNotifications: boolean;
  breakingKeywords: string[];
  layoutCols: number; // 1, 2, 3
  defaultReaderMode?: ReaderViewMode;
  deduplication?: DeduplicationSettings;
  minimizeToTray?: boolean;
  launchOnStartup?: boolean;
  flashTaskbarOnBreaking?: boolean;
}

export interface ToastItem {
  id: string;
  title: string;
  message?: string;
  imageUrl?: string;
  article?: NewsItem;
  timestamp?: number;
  type?: 'breaking' | 'info' | 'success' | 'warning';
}

export interface ElectronNotificationOptions {
  title: string;
  body: string;
  icon?: string;
  silent?: boolean;
  article?: NewsItem;
}

export interface ElectronAPI {
  isElectron: boolean;
  platform: string;
  showNotification: (options: ElectronNotificationOptions) => Promise<boolean>;
  flashFrame: (flag: boolean) => Promise<void>;
  getAutoStart: () => Promise<boolean>;
  setAutoStart: (enabled: boolean) => Promise<boolean>;
  getMinimizeToTray: () => Promise<boolean>;
  setMinimizeToTray: (enabled: boolean) => Promise<boolean>;
  checkForUpdates: () => Promise<any>;
  openExternal: (url: string) => Promise<void>;
  getAiAccessToken?: () => Promise<string | null>;
  onNavigateToArticle: (callback: (article: NewsItem) => void) => () => void;
  onRefreshFeeds: (callback: () => void) => () => void;
  onOpenSettings: (callback: () => void) => () => void;
  onFocusSearch: (callback: () => void) => () => void;
  onToggleBookmarks: (callback: () => void) => () => void;
  onOpenCreateBlock: (callback: () => void) => () => void;
  onToggleTheme: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

