import React, { useState, useEffect, useRef } from 'react';
import {
  Rss,
  RefreshCw,
  Plus,
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
      Array.from(moreMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    items()[0]?.focus();
    const close = () => {
      setMoreOpen(false);
      moreTriggerRef.current?.focus();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) setMoreOpen(false);
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

  const categoryTabs = [
    { id: 'vulnerabilities', label: 'Vulnerabilities' },
    { id: 'vendor-advisories', label: 'Vendor advisories' },
    { id: 'threat-intel', label: 'Threat intel' },
    { id: 'exploits', label: 'Exploits' },
    { id: 'malware', label: 'Malware' },
    { id: 'cloud', label: 'Cloud' },
    { id: 'appsec', label: 'AppSec' },
    { id: 'devsecops', label: 'DevSecOps' },
    { id: 'privacy', label: 'Privacy' },
    { id: 'cert', label: 'CERT' },
    { id: 'bugbounty', label: 'Bug bounty' },
    { id: 'iot', label: 'IoT' },
  ];
  const moreTopics = [
    { id: 'all', label: 'News' },
    { id: 'podcasts', label: 'Podcasts' },
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

  const toggleTheme = () => {
    const next = settings.theme === 'dark' ? 'light' : 'dark';
    onUpdateSettings({ ...settings, theme: next });
  };

  return (
    <header className={`sticky top-0 z-40 border-b transition-colors duration-200 ${
      settings.theme === 'dark'
        ? 'bg-[#0a0b0e]/95 border-neutral-800/80 text-neutral-100 backdrop-blur-xl'
        : 'bg-white/95 border-neutral-200 text-neutral-900 backdrop-blur-xl shadow-xs'
    }`}>
      <div className="max-w-[1680px] w-full mx-auto px-3 sm:px-6 lg:px-8">
        
        {/* Top Bar Row */}
        <div className="flex items-center justify-between h-14 sm:h-16 gap-2 sm:gap-4">
          
          {/* Brand Logo */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <div className={`flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-control ${acc.bg} text-black shadow-md font-black`}>
              <Rss className="w-4 h-4 sm:w-5 sm:h-5 animate-pulse" />
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`font-black text-base sm:text-xl tracking-tight flex items-center ${
                settings.theme === 'dark' ? 'text-neutral-100' : 'text-neutral-900'
              }`}>
                CYBER<span className={`${settings.theme === 'dark' ? 'text-amber-400' : 'text-amber-600'} ml-1`}>KIWI</span>
              </span>
              <span className="text-sm font-black px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 hidden xs:inline-block">
                v0.2.0
              </span>
            </div>
          </div>

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
              <span className="text-sm">{isRefreshing ? '...' : `${countdown}s`}</span>
            </button>

            {/* AI Curator Button */}
            <button
              onClick={onOpenAICurator}
              aria-label={t.nav.aiCurator}
              className={`hidden sm:flex items-center gap-1.5 px-2.5 xl:px-3 py-1.5 rounded-card text-sm font-black bg-gradient-to-r ${acc.gradientFrom} ${acc.gradientTo} text-black shadow-md transition-all`}
              title={t.nav.aiCurator}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span className="hidden xl:inline">{t.nav.aiCurator}</span>
            </button>

            {/* Add Dynamic Block Button */}
            <button
              onClick={onOpenCreateBlock}
              aria-label={t.nav.newBlock}
              className={`flex items-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-card text-sm font-black ${acc.bg} ${acc.bgHover} text-black transition-all shadow-md`}
              title={`${t.nav.newBlock} (Ctrl+N)`}
            >
              <Plus className="w-3.5 h-3.5 stroke-[3]" />
              <span className="hidden xl:inline">{t.nav.newBlock}</span>
            </button>

            {/* Feeds Manager */}
            <button
              onClick={onOpenManageFeeds}
              aria-label={t.nav.manageFeeds}
              title={t.nav.manageFeeds}
              className={`hidden sm:block p-2 rounded-card border transition-all ${
                settings.theme === 'dark'
                  ? 'bg-neutral-900 border-neutral-800 text-neutral-300 hover:bg-neutral-800'
                  : 'bg-neutral-100 border-neutral-300 text-neutral-700 hover:bg-neutral-200'
              }`}
            >
              <ListPlus className="w-4 h-4" />
            </button>

            {/* Bookmarks Quick Toggle */}
            <button
              onClick={onToggleBookmarks}
              aria-label={`${t.nav.bookmarks}${showBookmarksOnly ? ' (active)' : ''}`}
              aria-pressed={showBookmarksOnly}
              title={`${t.nav.bookmarks} (Ctrl+B)`}
              className={`relative hidden sm:block p-2 rounded-card border transition-all ${
                showBookmarksOnly
                  ? `${acc.bgLight} ${acc.borderLight} ${acc.textDark}`
                  : settings.theme === 'dark'
                  ? 'bg-neutral-900 border-neutral-800 text-neutral-300 hover:bg-neutral-800'
                  : 'bg-neutral-100 border-neutral-300 text-neutral-700 hover:bg-neutral-200'
              }`}
            >
              <Bookmark className={`w-4 h-4 ${showBookmarksOnly ? acc.fill : ''}`} />
              {bookmarkCount > 0 && (
                <span className={`absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full ${acc.bg} text-sm font-black text-black`}>
                  {bookmarkCount}
                </span>
              )}
            </button>

            {/* Quick Language Switcher */}
            <button
              onClick={() => {
                const nextLang = settings.language === 'pt' ? 'en' : 'pt';
                onUpdateSettings({ ...settings, language: nextLang });
              }}
              title={settings.language === 'pt' ? 'Mudar idioma para Inglês' : 'Mudar idioma para Português (Brasil)'}
              className={`hidden sm:flex px-2.5 py-1.5 rounded-card border text-sm font-bold transition-all cursor-pointer items-center gap-1 ${
                settings.theme === 'dark'
                  ? 'bg-neutral-900 border-neutral-800 text-amber-400 hover:bg-neutral-800 hover:border-amber-500/50'
                  : 'bg-neutral-100 border-neutral-300 text-amber-700 hover:bg-neutral-200 hover:border-amber-500/50'
              }`}
            >
              <span>{settings.language === 'pt' ? '🇧🇷 PT' : '🇺🇸 EN'}</span>
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

            {/* Mobile Menu Toggle */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={mobileMenuOpen ? t.nav.closeMenu : t.nav.openMenu}
              aria-expanded={mobileMenuOpen}
              className={`p-2 rounded-card border lg:hidden transition-colors ${
                settings.theme === 'dark'
                  ? 'border-neutral-800 bg-neutral-900 text-neutral-300'
                  : 'border-neutral-300 bg-neutral-100 text-neutral-700'
              }`}
              title="Menu"
            >
              {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Desktop Category Tabs */}
        <nav
          aria-label="Security topics"
          className={`relative hidden lg:flex min-w-0 items-center gap-4 overflow-x-auto no-scrollbar border-t py-2 ${
            settings.theme === 'dark' ? 'border-neutral-800/40' : 'border-neutral-200'
          }`}
        >
          <div className="flex min-w-max items-center gap-4 px-1">
            {categoryTabs.map((tab) => {
              const isActive = selectedCategory === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => onSelectCategory && onSelectCategory(tab.id)}
                  className={`relative py-1 text-sm font-bold tracking-wide transition-colors cursor-pointer whitespace-nowrap ${
                    isActive
                      ? 'text-amber-400'
                      : settings.theme === 'dark'
                        ? 'text-neutral-400 hover:text-neutral-200'
                        : 'text-neutral-500 hover:text-neutral-900'
                  }`}
                >
                  {tab.label}
                  {isActive && (
                    <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-amber-400 rounded-full shadow-[0_0_8px_rgba(251,191,36,0.8)]" />
                  )}
                </button>
              );
            })}
            <button
              type="button"
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              ref={moreTriggerRef}
              onClick={() => setMoreOpen((open) => !open)}
              className={`relative py-1 text-sm font-bold tracking-wide transition-colors cursor-pointer whitespace-nowrap ${moreOpen ? 'text-amber-400' : settings.theme === 'dark' ? 'text-neutral-400 hover:text-neutral-200' : 'text-neutral-500 hover:text-neutral-900'}`}
            >
              More
            </button>
          </div>
          {moreOpen && (
            <div ref={moreMenuRef} role="menu" className={`absolute right-1 top-11 z-50 min-w-36 rounded-control border p-1 shadow-xl ${settings.theme === 'dark' ? 'border-neutral-700 bg-neutral-900 text-neutral-100' : 'border-neutral-200 bg-white text-neutral-900'}`}>
              {moreTopics.map((topic) => (
                <button
                  type="button"
                  role="menuitem"
                  key={topic.id}
                  onClick={() => { onSelectCategory?.(topic.id); setMoreOpen(false); moreTriggerRef.current?.focus(); }}
                  className="w-full rounded-chip px-3 py-2 text-left text-sm font-semibold hover:bg-amber-500/10"
                >
                  {topic.label}
                </button>
              ))}
            </div>
          )}
        </nav>

        {/* Mobile Horizontal Category Pills Bar */}
        <div aria-label="Security topics" className={`flex lg:hidden items-center gap-2 overflow-x-auto no-scrollbar stories-scroll-container py-2 border-t ${
          settings.theme === 'dark' ? 'border-neutral-800/40' : 'border-neutral-200'
        }`}>
          {categoryTabs.map((tab) => {
            const isActive = selectedCategory === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => onSelectCategory && onSelectCategory(tab.id)}
                className={`px-3 py-1 rounded-control text-sm font-bold whitespace-nowrap transition-all ${
                  isActive
                    ? 'bg-amber-500 text-black shadow-sm'
                    : settings.theme === 'dark'
                      ? 'bg-neutral-900/90 text-neutral-400 border border-neutral-800/80 hover:text-white'
                      : 'bg-neutral-200/90 text-neutral-600 border border-neutral-300/80 hover:text-neutral-900'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
          <button
            type="button"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
            className={`px-3 py-1 rounded-control text-sm font-bold whitespace-nowrap border ${moreOpen ? 'bg-amber-500 text-black border-amber-500' : settings.theme === 'dark' ? 'bg-neutral-900/90 text-neutral-300 border-neutral-800/80' : 'bg-neutral-200/90 text-neutral-700 border-neutral-300/80'}`}
          >
            More
          </button>
        </div>

        {moreOpen && (
          <div className={`lg:hidden flex gap-2 overflow-x-auto no-scrollbar px-1 pb-2 ${settings.theme === 'dark' ? 'text-neutral-100' : 'text-neutral-900'}`}>
            {moreTopics.map((topic) => (
              <button
                type="button"

                key={topic.id}
                onClick={() => { onSelectCategory?.(topic.id); setMoreOpen(false); }}
                className="rounded-control border border-amber-500/40 px-3 py-1 text-sm font-semibold whitespace-nowrap hover:bg-amber-500/10"
              >
                {topic.label}
              </button>
            ))}
          </div>
        )}

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

        {/* Mobile Extra Drawer Menu */}
        {mobileMenuOpen && (
          <div className={`lg:hidden p-3 border-t rounded-b-2xl mb-2 flex flex-wrap gap-2 text-sm transition-all ${
            settings.theme === 'dark'
              ? 'border-neutral-800 bg-[#0d0e12] text-neutral-100'
              : 'border-neutral-200 bg-neutral-100 text-neutral-900 shadow-md'
          }`}>
            <button
              onClick={() => {
                onOpenAICurator();
                setMobileMenuOpen(false);
              }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-control bg-amber-500/20 text-amber-500 border border-amber-500/40 font-bold cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{t.nav.aiCurator}</span>
            </button>

            <button
              onClick={() => {
                onOpenManageFeeds();
                setMobileMenuOpen(false);
              }}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-control border font-bold cursor-pointer ${
                settings.theme === 'dark'
                  ? 'bg-neutral-900 text-neutral-300 border-neutral-800 hover:bg-neutral-800'
                  : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-200'
              }`}
            >
              <ListPlus className="w-3.5 h-3.5" />
              <span>{t.nav.manageFeeds}</span>
            </button>

            <button
              onClick={() => {
                onToggleBookmarks();
                setMobileMenuOpen(false);
              }}
              aria-pressed={showBookmarksOnly}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-control border font-bold cursor-pointer ${
                showBookmarksOnly
                  ? `${acc.bgLight} ${acc.borderLight} ${acc.textDark}`
                  : settings.theme === 'dark'
                    ? 'bg-neutral-900 text-neutral-300 border-neutral-800 hover:bg-neutral-800'
                    : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-200'
              }`}
            >
              <Bookmark className={`w-3.5 h-3.5 ${showBookmarksOnly ? acc.fill : ''}`} />
              <span>{t.nav.bookmarks}{bookmarkCount > 0 ? ` (${bookmarkCount})` : ''}</span>
            </button>

            <button
              onClick={() => {
                const nextLang = settings.language === 'pt' ? 'en' : 'pt';
                onUpdateSettings({ ...settings, language: nextLang });
                setMobileMenuOpen(false);
              }}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-control border font-bold cursor-pointer ${
                settings.theme === 'dark'
                  ? 'bg-neutral-900 text-amber-400 border-neutral-800 hover:bg-neutral-800'
                  : 'bg-white text-amber-700 border-neutral-300 hover:bg-neutral-200'
              }`}
            >
              <Globe className="w-3.5 h-3.5" />
              <span>{settings.language === 'pt' ? 'Português (BR)' : 'English (US)'}</span>
            </button>

            <button
              onClick={() => {
                onOpenGlobalFeeds();
                setMobileMenuOpen(false);
              }}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-control border font-bold cursor-pointer ${
                settings.theme === 'dark'
                  ? 'bg-neutral-900 text-neutral-300 border-neutral-800 hover:bg-neutral-800'
                  : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-200'
              }`}
            >
              <Globe className="w-3.5 h-3.5" />
              <span>{t.nav.globalDirectory}</span>
            </button>

            <button
              onClick={() => {
                onToggleArchive();
                setMobileMenuOpen(false);
              }}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-control border font-bold cursor-pointer ${
                settings.theme === 'dark'
                  ? 'bg-neutral-900 text-neutral-300 border-neutral-800 hover:bg-neutral-800'
                  : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-200'
              }`}
            >
              <Archive className="w-3.5 h-3.5" />
              <span>{t.nav.archive} ({archivedCount})</span>
            </button>

            <button
              onClick={toggleTheme}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-control border font-bold cursor-pointer ${
                settings.theme === 'dark'
                  ? 'bg-neutral-900 text-neutral-300 border-neutral-800 hover:bg-neutral-800'
                  : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-200'
              }`}
            >
              {settings.theme === 'dark' ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5" />}
              <span>{settings.theme === 'dark' ? t.settings.themeLight : t.settings.themeDark}</span>
            </button>
          </div>
        )}

      </div>
    </header>
  );
};
