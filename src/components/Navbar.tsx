import React, { useState, useEffect, useRef } from 'react';
import {
  RefreshCw,
  Plus,
  LogIn,
  UserRound,
  ChevronDown,
  Bookmark,
  Settings,
  Sparkles,
  Search,
  Moon,
  Sun,
  ListPlus,
  Globe,
  Archive,
  Menu,
  X
} from 'lucide-react';
import { AppSettings } from '../types';
import { getAccent } from '../utils/theme';
import { getTranslation } from '../i18n/translations';

interface NavbarProps {
  onRefreshAll: () => void;
  isRefreshing: boolean;
  lastUpdated: Date | null;
  autoRefreshSec: number;
  onOpenCreateBlock: () => void;
  onOpenManageFeeds: () => void;
  onOpenGlobalFeeds: () => void;
  onOpenAICurator: () => void;
  onOpenSettings: () => void;
  onOpenAccount: () => void;
  onHome: () => void;
  signedIn: boolean;
  onToggleBookmarks: () => void;
  showBookmarksOnly: boolean;
  bookmarkCount: number;
  onToggleArchive: () => void;
  showArchiveOnly: boolean;
  archivedCount: number;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  settings: AppSettings;
  onUpdateSettings: (newSettings: AppSettings) => void;
  totalArticlesCount: number;
  newArticlesCount: number;
  selectedCategory?: string;
  onSelectCategory?: (cat: string) => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  onRefreshAll,
  isRefreshing,
  lastUpdated,
  autoRefreshSec,
  onOpenCreateBlock,
  onOpenManageFeeds,
  onOpenGlobalFeeds,
  onOpenAICurator,
  onOpenSettings,
  onOpenAccount,
  onHome,
  signedIn,
  onToggleBookmarks,
  showBookmarksOnly,
  bookmarkCount,
  onToggleArchive,
  showArchiveOnly,
  archivedCount,
  searchQuery,
  onSearchChange,
  settings,
  onUpdateSettings,
  totalArticlesCount,
  newArticlesCount,
  selectedCategory = 'all',
  onSelectCategory,
}) => {
  const [countdown, setCountdown] = useState<number>(autoRefreshSec);
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [moreOpen, setMoreOpen] = useState<boolean>(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const items = (): HTMLElement[] =>
      Array.from(moreMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    items()[0]?.focus();
    const close = () => {
      setMoreOpen(false);
      moreTriggerRef.current?.focus();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!moreMenuRef.current?.contains(target) && !moreTriggerRef.current?.contains(target)) setMoreOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === 'Tab') {
        setMoreOpen(false);
        return;
      }
      const list = items();
      if (list.length === 0) return;
      const current = list.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        list[(current + 1) % list.length].focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        list[(current - 1 + list.length) % list.length].focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        list[0].focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        list[list.length - 1].focus();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [moreOpen]);
  const acc = getAccent(settings.accentColor);
  const t = getTranslation(settings.language);

  const accountLabel = settings.language === 'pt'
    ? (signedIn ? 'Conta' : 'Entrar')
    : (signedIn ? 'Account' : 'Sign in');
  const categoryTabs = [
    { id: 'all', label: 'Overview' },
    { id: 'news', label: 'News' },
    { id: 'vulnerabilities', label: 'Vulnerabilities' },
    { id: 'vendor-advisories', label: 'Vendor advisories' },
    { id: 'threat-intel', label: 'Threat intel' },
  ];
  const moreTopics = [
    { id: 'exploits', label: 'Exploits' },
    { id: 'malware', label: 'Malware' },
    { id: 'cloud', label: 'Cloud' },
    { id: 'appsec', label: 'AppSec' },
    { id: 'devsecops', label: 'DevSecOps' },
    { id: 'privacy', label: 'Privacy' },
    { id: 'cert', label: 'CERT' },
    { id: 'bugbounty', label: 'Bug bounty' },
    { id: 'iot', label: 'IoT' },
    { id: 'podcasts', label: 'Podcasts' },
  ];
  const selectedMoreTopic = moreTopics.find((topic) => topic.id === selectedCategory);
  const utilityClass = `flex items-center gap-2 rounded-control px-3 py-2 text-sm font-medium transition-colors hover:bg-amber-500/10 focus-visible:outline-2 focus-visible:outline-amber-500 ${settings.theme === 'dark' ? 'text-neutral-200' : 'text-neutral-800'}`;
  const tools = [
    { label: t.nav.newBlock, icon: Plus, action: onOpenCreateBlock },
    { label: t.nav.aiCurator, icon: Sparkles, action: onOpenAICurator },
    { label: t.nav.manageFeeds, icon: ListPlus, action: onOpenManageFeeds },
    { label: t.nav.globalDirectory, icon: Globe, action: onOpenGlobalFeeds },
    { label: `${t.nav.bookmarks} (${bookmarkCount})`, icon: Bookmark, action: onToggleBookmarks, pressed: showBookmarksOnly },
    { label: `${t.nav.archive} (${archivedCount})`, icon: Archive, action: onToggleArchive, pressed: showArchiveOnly },
    { label: settings.language === 'pt' ? 'English' : 'Português (BR)', icon: Globe, action: () => onUpdateSettings({ ...settings, language: settings.language === 'pt' ? 'en' : 'pt' }) },
    { label: settings.theme === 'dark' ? t.settings.themeLight : t.settings.themeDark, icon: settings.theme === 'dark' ? Sun : Moon, action: () => onUpdateSettings({ ...settings, theme: settings.theme === 'dark' ? 'light' : 'dark' }) },
  ];

  // Countdown timer for next auto refresh
  useEffect(() => {
    if (autoRefreshSec <= 0) return;
    setCountdown(autoRefreshSec);

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          setTimeout(() => {
            onRefreshAll();
          }, 0);
          return autoRefreshSec;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [autoRefreshSec, onRefreshAll]);

  return (
    <header className={`sticky top-0 z-40 border-b transition-colors duration-200 ${
      settings.theme === 'dark'
        ? 'bg-[#0a0b0e]/95 border-neutral-800/80 text-neutral-100 backdrop-blur-xl'
        : 'bg-white/95 border-neutral-200 text-neutral-900 backdrop-blur-xl shadow-xs'
    }`}>
      <div className="max-w-[1680px] w-full mx-auto px-3 sm:px-6 lg:px-8">
        
        {/* Top Bar Row */}
        <div className="flex items-center justify-between h-14 sm:h-16 gap-2 sm:gap-4">
          
          <a
            href="/"
            aria-label="CyberKiwi home"
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              setMobileMenuOpen(false);
              setMoreOpen(false);
              onHome();
            }}
            className="flex shrink-0 items-center gap-2 rounded-control focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-500"
          >
            <span
              aria-hidden="true"
              className="size-8 rounded-control bg-[#f7f2e3] bg-no-repeat sm:size-9"
              style={{
                backgroundImage: 'url(/cyberkiwi-logo.jpeg)',
                backgroundSize: '275% auto',
                backgroundPosition: 'center 24%',
              }}
            />
            <span className="font-display text-base font-bold tracking-tight sm:text-xl">CyberKiwi</span>
          </a>

          {/* Desktop Search Bar */}
          <div className="hidden md:flex flex-1 max-w-xs md:max-w-sm lg:max-w-xs xl:max-w-md relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input
              type="text"
              data-search-input="true"
              aria-label={t.nav.searchPlaceholder}
              value={searchQuery ?? ''}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={`${t.nav.searchPlaceholder} (Ctrl+F)`}
              className={`w-full pl-9 pr-8 py-1.5 text-sm font-medium rounded-control border transition-all ${
                settings.theme === 'dark'
                  ? 'bg-neutral-900/90 border-neutral-800 text-neutral-100 placeholder-neutral-500 focus:border-amber-500/50'
                  : 'bg-neutral-100 border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:border-amber-500/50'
              }`}
            />
            {searchQuery && (
              <button
                onClick={() => onSearchChange('')}
                aria-label={t.nav.clearSearch}
                className={`absolute right-2.5 top-1/2 -translate-y-1/2 text-sm font-bold transition-colors cursor-pointer ${
                  settings.theme === 'dark' ? 'text-neutral-400 hover:text-white' : 'text-neutral-500 hover:text-neutral-900'
                }`}
              >
                ✕
              </button>
            )}
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">

            {/* Refresh Button */}
            <button
              onClick={onRefreshAll}
              disabled={isRefreshing}
              aria-label={t.nav.refresh}
              title={`${t.nav.autoRefreshIn} ${countdown}s. ${t.nav.refresh} (F5 / Ctrl+R)`}
              className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-card text-sm font-bold border transition-all ${
                isRefreshing
                  ? `${acc.bgLight} ${acc.borderLight} ${acc.textDark}`
                  : settings.theme === 'dark'
                  ? 'bg-neutral-900 border-neutral-800 text-neutral-300 hover:border-neutral-600'
                  : 'bg-neutral-100 border-neutral-300 text-neutral-700 hover:border-neutral-400'
              }`}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? `animate-spin ${acc.text}` : ''}`} />
              <span className="hidden text-sm sm:inline">{isRefreshing ? '...' : `${countdown}s`}</span>
            </button>

            <button
              type="button"
              onClick={onOpenAccount}
              className={`flex items-center gap-1.5 rounded-control px-2.5 py-2 text-sm font-bold whitespace-nowrap text-black ${acc.bg} ${acc.bgHover}`}
            >
              {signedIn ? <UserRound className="size-4" aria-hidden="true" /> : <LogIn className="size-4" aria-hidden="true" />}
              {accountLabel}
            </button>

            {/* Settings */}
            <button
              onClick={onOpenSettings}
              aria-label={t.nav.settings}
              title={`${t.nav.settings} (Ctrl+,)`}
              className={`p-2 rounded-card border transition-all ${
                settings.theme === 'dark'
                  ? 'bg-neutral-900 border-neutral-800 text-neutral-300 hover:bg-neutral-800'
                  : 'bg-neutral-100 border-neutral-300 text-neutral-700 hover:bg-neutral-200'
              }`}
            >
              <Settings className="w-4 h-4" />
            </button>

            {/* Dashboard tools */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={settings.language === 'pt' ? 'Ferramentas do painel' : 'Dashboard tools'}
              aria-expanded={mobileMenuOpen}
              aria-controls="dashboard-tools"
              className={`p-2 rounded-card border transition-colors ${
                settings.theme === 'dark'
                  ? 'border-neutral-800 bg-neutral-900 text-neutral-300'
                  : 'border-neutral-300 bg-neutral-100 text-neutral-700'
              }`}
              title={settings.language === 'pt' ? 'Ferramentas' : 'Tools'}
            >
              {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <div id="dashboard-tools" className={`mb-2 flex flex-wrap gap-1 rounded-card border p-2 ${settings.theme === 'dark' ? 'border-neutral-800 bg-neutral-900' : 'border-neutral-200 bg-white'}`}>
            {tools.map(({ label, icon: Icon, action, pressed }) => (
              <button
                type="button"
                key={label}
                aria-pressed={pressed}
                onClick={() => { setMobileMenuOpen(false); action(); }}
                className={utilityClass}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
        )}

        <nav aria-label="Security topics" className={`relative flex items-center gap-2 border-t py-2 ${settings.theme === 'dark' ? 'border-neutral-800' : 'border-neutral-200'}`}>
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto no-scrollbar">
            {categoryTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                aria-pressed={selectedCategory === tab.id}
                onClick={() => onSelectCategory?.(tab.id)}
                className={`${utilityClass} shrink-0 whitespace-nowrap ${selectedCategory === tab.id ? 'bg-amber-500/15 ring-1 ring-inset ring-amber-500/40' : ''}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="relative shrink-0">
            <button
              type="button"
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              ref={moreTriggerRef}
              onClick={() => setMoreOpen((open) => !open)}
              className={`${utilityClass} whitespace-nowrap ${selectedMoreTopic ? 'bg-amber-500/15 ring-1 ring-inset ring-amber-500/40' : ''}`}
            >
              {selectedMoreTopic?.label ?? 'More topics'}
              <ChevronDown className="size-3.5" aria-hidden="true" />
            </button>
            {moreOpen && (
              <div ref={moreMenuRef} role="menu" className={`absolute top-full right-0 z-50 mt-2 w-44 rounded-control border p-1 shadow-xl sm:right-auto sm:left-0 ${settings.theme === 'dark' ? 'border-neutral-700 bg-neutral-900' : 'border-neutral-200 bg-white'}`}>
                {moreTopics.map((topic) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selectedCategory === topic.id}
                    key={topic.id}
                    onClick={() => { onSelectCategory?.(topic.id); setMoreOpen(false); moreTriggerRef.current?.focus(); }}
                    className={`${utilityClass} w-full text-left`}
                  >
                    {topic.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </nav>

        {/* Mobile Search Bar */}
        <div className="md:hidden pb-2.5 pt-0.5">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input
              type="text"
              aria-label={t.nav.searchPlaceholder}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={t.nav.searchPlaceholder}
              className={`w-full pl-8 pr-7 py-1 text-sm rounded-control border transition-all ${
                settings.theme === 'dark'
                  ? 'bg-neutral-900 border-neutral-800 text-neutral-100 placeholder-neutral-500'
                  : 'bg-neutral-100 border-neutral-200 text-neutral-900 placeholder-neutral-400'
              }`}
            />
            {searchQuery && (
              <button
                onClick={() => onSearchChange('')}
                aria-label={t.nav.clearSearch}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-neutral-400"
              >
                ✕
              </button>
            )}
          </div>
        </div>


      </div>
    </header>
  );
};
