import React, { useEffect, useRef, useState } from 'react';
import { normalizeExternalUrl } from '../utils/externalUrl';
import {
  Sparkles,
  RefreshCw,
  Settings2,
  Bookmark,
  Share2,
  Trash2,
  LayoutGrid,
  List,
  Columns,
  MessageSquareText,
  X,
  Smile,
  Frown,
  Clock,
  Layers,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
} from 'lucide-react';
import { DynamicBlock, NewsItem, NewsStory, BlockLayout, AccentColor } from '../types';
import { getAccent } from '../utils/theme';
import { SafeImage } from './SafeImage';
import { shareArticle } from '../services/shareService';
import { Language, getTranslation } from '../i18n/translations';

interface DynamicBlockCardProps {
  block: DynamicBlock;
  items: NewsItem[];
  /** Which empty message to show: no matches, no active sources, or all sources failing. */
  emptyKey?: 'noArticles' | 'noSources' | 'sourcesFailing';
  isLoading: boolean;
  onRefreshBlock: () => void;
  onSelectArticle: (item: NewsItem) => void;
  onToggleBookmark: (item: NewsItem) => void;
  onEditBlock: () => void;
  onDeleteBlock: () => void;
  onUpdateBlockLayout: (layout: BlockLayout) => void;
  onGenerateAISummary: () => void;
  isGeneratingAI: boolean;
  theme: 'dark' | 'light';
  accentColor?: AccentColor;
  bookmarkedIds: Set<string>;
  archivedIds?: Set<string>;
  onToggleArchive?: (item: NewsItem) => void;
  language?: Language;
}

export const DynamicBlockCard: React.FC<DynamicBlockCardProps> = ({
  block,
  items,
  emptyKey = 'noArticles',
  isLoading,
  onRefreshBlock,
  onSelectArticle,
  onToggleBookmark,
  onEditBlock,
  onDeleteBlock,
  onUpdateBlockLayout,
  onGenerateAISummary,
  isGeneratingAI,
  theme,
  accentColor,
  bookmarkedIds,
  archivedIds = new Set(),
  onToggleArchive,
  language = 'en',
}) => {
  const [showSummary, setShowSummary] = useState<boolean>(!!block.aiSummary);
  const [showControls, setShowControls] = useState<boolean>(false);
  const controlsRef = useRef<HTMLDivElement>(null);
  const controlsTriggerRef = useRef<HTMLButtonElement>(null);
  const acc = getAccent(accentColor);
  const t = getTranslation(language);

  const displayItems = items.slice(0, block.itemCount);

  const handleArticleCardKeyDown = (event: React.KeyboardEvent<HTMLElement>, item: NewsItem) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelectArticle(item);
  };

  useEffect(() => {
    if (!showControls) return;
    // Menu items in DOM order. Disabled items are skipped by keyboard navigation.
    const menuItems = (): HTMLElement[] =>
      Array.from(controlsRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ?? []).filter(
        (el) => !(el as HTMLButtonElement).disabled
      );
    menuItems()[0]?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      if (!controlsRef.current?.contains(event.target as Node)) setShowControls(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowControls(false);
        controlsTriggerRef.current?.focus();
        return;
      }
      if (event.key === 'Tab') {
        setShowControls(false);
        return;
      }
      const items = menuItems();
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        items[(current + 1) % items.length].focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        items[(current - 1 + items.length) % items.length].focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        items[0].focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        items[items.length - 1].focus();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showControls]);

  // Helper for source badge icon and colors (stable reference, pure function)
  const getSourceBadge = (sourceName: string) => {
    const s = sourceName.toLowerCase();
    if (s.includes('g1')) return { bg: 'bg-red-600', text: 'text-white', dot: 'bg-red-500', name: 'G1' };
    if (s.includes('techcrunch')) return { bg: 'bg-emerald-600', text: 'text-white', dot: 'bg-emerald-400', name: 'TechCrunch' };
    if (s.includes('verge')) return { bg: 'bg-purple-600', text: 'text-white', dot: 'bg-purple-400', name: 'The Verge' };
    if (s.includes('guardian')) return { bg: 'bg-blue-700', text: 'text-white', dot: 'bg-blue-400', name: 'The Guardian' };
    if (s.includes('folha')) return { bg: 'bg-neutral-700', text: 'text-white', dot: 'bg-neutral-300', name: 'Folha de S.Paulo' };
    if (s.includes('cnn')) return { bg: 'bg-red-700', text: 'text-white', dot: 'bg-red-400', name: 'CNN' };
    if (s.includes('bbc')) return { bg: 'bg-red-800', text: 'text-white', dot: 'bg-red-300', name: 'BBC News' };
    if (s.includes('wired')) return { bg: 'bg-zinc-800', text: 'text-white', dot: 'bg-zinc-400', name: 'WIRED' };
    if (s.includes('hackernews') || s.includes('hacker news')) return { bg: 'bg-orange-600', text: 'text-white', dot: 'bg-orange-400', name: 'HN' };
    return { bg: 'bg-neutral-700', text: 'text-white', dot: 'bg-amber-400', name: sourceName };
  };

  // Helper for sentiment badge
  const renderSentiment = (sentiment?: string) => {
    if (sentiment === 'positive') {
      return (
        <span className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-md" title={t.block.positive}>
          <Smile className="w-3 h-3" />
          <span>{t.block.positive}</span>
        </span>
      );
    }
    if (sentiment === 'negative') {
      return (
        <span className="inline-flex items-center gap-1 text-sm font-semibold text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded-md" title={t.block.negative}>
          <Frown className="w-3 h-3" />
          <span>{t.block.negative}</span>
        </span>
      );
    }
    return null;
  };

  // Helper for relative time string
  const getRelativeTime = (timestamp: number) => {
    const diffMin = Math.floor((Date.now() - timestamp) / (1000 * 60));
    if (diffMin < 1) return t.block.justNow;
    if (diffMin < 60) return `${diffMin}${t.block.minutesAgo}`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}${t.block.hoursAgo}`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d`;
  };

  const [expandedStoryIds, setExpandedStoryIds] = useState<Set<string>>(new Set());

  const toggleSources = (storyId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setExpandedStoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(storyId)) next.delete(storyId);
      else next.add(storyId);
      return next;
    });
  };

  const renderMultiSourceWidget = (item: NewsItem) => {
    const story = item as NewsStory;
    if (!story.isCluster || story.sourcesCount <= 1) return null;
    const isExpanded = expandedStoryIds.has(story.id);

    return (
      <div className={`mt-2.5 pt-2 border-t border-dashed ${
        theme === 'dark' ? 'border-neutral-800' : 'border-neutral-200'
      }`}>
        <div className="flex items-center justify-between gap-2 flex-wrap text-sm">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <span className={`inline-flex items-center gap-1 font-black text-sm px-2 py-0.5 rounded-md ${
              theme === 'dark' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-amber-100 text-amber-800 border border-amber-300'
            }`}>
              <Layers className="w-3 h-3" />
              <span>{t.block.sourcesCount.replace('{count}', String(story.sourcesCount))}</span>
            </span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-neutral-400 max-w-[220px]">
              {story.uniqueSources.map((s) => (
                <span key={s.sourceName} className="truncate">{s.sourceName}</span>
              ))}
            </span>
          </div>

          <button
            onClick={(e) => toggleSources(story.id, e)}
            className={`inline-flex items-center gap-1 text-sm font-bold ${acc.text} hover:underline cursor-pointer shrink-0`}
          >
            <span>{isExpanded ? t.block.hideSources : t.block.viewSources.replace('{count}', String(story.sourcesCount))}</span>
            {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>

        {isExpanded && (
          <div className={`mt-2 p-2 rounded-card border space-y-1.5 animate-in fade-in duration-150 ${
            theme === 'dark' ? 'bg-neutral-900/90 border-neutral-800 text-neutral-200' : 'bg-neutral-50 border-neutral-200 text-neutral-800'
          }`}>
            <span className="block text-sm font-bold text-neutral-400 px-1 mb-1">
              {t.reader.storyCoverage} ({story.sourcesCount}):
            </span>
            {story.uniqueSources.map((src, idx) => {
              const srcBadge = getSourceBadge(src.sourceName);
              return (
                <div
                  key={idx}
                  onClick={(e) => {
                    e.stopPropagation();
                    const fullArt = story.articles.find((a) => a.link === src.link) || {
                      ...story,
                      title: src.title,
                      link: src.link,
                      sourceName: src.sourceName,
                      sourceId: src.sourceId,
                      contentSnippet: src.contentSnippet,
                      pubDate: src.pubDate,
                      timestamp: src.timestamp,
                    };
                    onSelectArticle(fullArt);
                  }}
                  className={`p-2 rounded-control border flex items-center justify-between gap-2.5 transition-colors cursor-pointer ${
                    theme === 'dark'
                      ? 'bg-neutral-950/70 border-neutral-800/80 hover:border-amber-500/40 hover:bg-neutral-900'
                      : 'bg-white border-neutral-200 hover:border-amber-500/40 hover:bg-neutral-100'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`w-3 h-3 rounded-full ${srcBadge.bg} flex items-center justify-center text-[7px] font-black text-white`}>
                        {srcBadge.name.charAt(0)}
                      </span>
                      <span className="font-extrabold text-sm text-amber-500">{src.sourceName}</span>
                      <span className="text-sm text-neutral-400 font-mono">{getRelativeTime(src.timestamp)}</span>
                    </div>
                    <div className="text-sm font-semibold leading-snug line-clamp-1">{src.title}</div>
                  </div>

                  <a
                    href={normalizeExternalUrl(src.link) ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    title={t.block.viewOriginal}
                    className={`p-1.5 rounded-chip border text-neutral-400 hover:text-amber-400 transition-colors cursor-pointer shrink-0 ${
                      theme === 'dark' ? 'hover:bg-neutral-800 border-neutral-700' : 'hover:bg-neutral-200 border-neutral-300'
                    }`}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`rounded-hero border transition-all duration-300 overflow-hidden flex flex-col h-full shadow-xl ${
      theme === 'dark'
        ? `bg-[#0e1017]/95 border-neutral-800/90 text-neutral-100 ${acc.borderHover}`
        : `bg-white border-neutral-200 text-neutral-900 ${acc.borderHover} shadow-md`
    }`}>
      
      {/* Block Header */}
      <div className={`relative px-6 py-4 border-b flex items-center justify-between gap-3 ${
        theme === 'dark' ? 'bg-neutral-900/60 border-neutral-700/80' : 'bg-neutral-50 border-neutral-200'
      }`}>
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-2.5 h-2.5 rounded-full ${acc.bg} shadow-xs shrink-0`} />
          <h2 className="font-display font-bold text-heading truncate flex items-center gap-2">
            {block.title}
            {block.filterKeyword && (
              <span className={`text-sm font-black px-2 py-0.5 rounded ${acc.bgLight} ${acc.textDark} border ${acc.borderLight} truncate`}>
                {block.filterKeyword}
              </span>
            )}
          </h2>
          <span className="text-sm font-bold text-neutral-400 shrink-0">
            [{displayItems.length}]
          </span>
        </div>

        {/* Block Controls */}
        <div ref={controlsRef} className="flex items-center gap-1.5 shrink-0">
          <button
            ref={controlsTriggerRef}
            type="button"
            aria-label="More block controls"
            aria-expanded={showControls}
            aria-controls={`block-controls-${block.id}`}
            onClick={() => setShowControls((open) => !open)}
            className={`p-1.5 rounded-control transition-colors ${theme === 'dark' ? 'hover:bg-neutral-700 text-neutral-300' : 'hover:bg-neutral-100 text-neutral-700'}`}
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
          {showControls && (
            <div id={`block-controls-${block.id}`} className={`absolute top-full right-4 mt-2 z-30 min-w-44 rounded-control border p-1 shadow-xl ${theme === 'dark' ? 'border-neutral-700 bg-neutral-900' : 'border-neutral-200 bg-white'}`}>
              <div className="flex items-center gap-1 p-1" aria-label="Layout">
                {([
                  ['hero', Columns, t.createBlock.layouts.hero],
                  ['grid', LayoutGrid, t.createBlock.layouts.grid],
                  ['list', List, t.createBlock.layouts.list],
                  ['compact', MessageSquareText, t.createBlock.layouts.compact],
                ] as const).map(([layout, Icon, label]) => (
                  <button
                    type="button"
                    key={layout}
                    aria-label={label}
                    role="menuitemradio"
                    aria-checked={block.layout === layout}
                    onClick={() => { onUpdateBlockLayout(layout); setShowControls(false); }}
                    className={`p-1 rounded-chip ${block.layout === layout ? `${acc.bg} text-black` : theme === 'dark' ? 'text-neutral-300 hover:bg-neutral-800' : 'text-neutral-600 hover:bg-neutral-100'}`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => { onRefreshBlock(); setShowControls(false); }} className="w-full rounded-chip px-3 py-2 text-left text-sm font-semibold hover:bg-amber-500/10">{t.block.refresh}</button>
              <button type="button" onClick={() => { onEditBlock(); setShowControls(false); }} className="w-full rounded-chip px-3 py-2 text-left text-sm font-semibold hover:bg-amber-500/10">{t.block.edit}</button>
              <button type="button" onClick={() => { onGenerateAISummary(); setShowControls(false); }} disabled={isGeneratingAI || displayItems.length === 0} className="w-full rounded-chip px-3 py-2 text-left text-sm font-semibold hover:bg-amber-500/10 disabled:opacity-50">{isGeneratingAI ? t.block.generatingSummary : t.block.aiSummary}</button>
              <button type="button" onClick={() => { onDeleteBlock(); setShowControls(false); }} className="w-full rounded-chip px-3 py-2 text-left text-sm font-semibold text-red-400 hover:bg-red-500/10">{t.block.remove}</button>
            </div>
          )}
        </div>
      </div>

      {/* AI Digest Drawer Banner if generated */}
      {block.aiSummary && (
        <div className={`p-4 border-b transition-all text-sm ${
          theme === 'dark' ? 'bg-purple-950/30 border-purple-800/40 text-purple-200' : 'bg-purple-50 border-purple-200 text-purple-900'
        }`}>
          <div className={`flex items-center justify-between mb-2 font-bold ${
            theme === 'dark' ? 'text-purple-400' : 'text-purple-700'
          }`}>
            <span className="flex items-center gap-1.5">
              <Sparkles className={`w-4 h-4 ${theme === 'dark' ? 'text-purple-400' : 'text-purple-700'}`} />
              {t.reader.aiSummaryTitle}
            </span>
            <button
              onClick={() => setShowSummary(!showSummary)}
              className={`text-sm underline cursor-pointer ${
                theme === 'dark' ? 'text-purple-400 hover:text-purple-200' : 'text-purple-700 hover:text-purple-500'
              }`}
            >
              {showSummary ? (language === 'pt' ? 'Ocultar' : 'Hide') : (language === 'pt' ? 'Ver Resumo' : 'Show Summary')}
            </button>
          </div>
          {showSummary && (
            <div className={`max-w-none whitespace-pre-wrap leading-relaxed text-sm ${
              theme === 'dark' ? 'prose prose-invert' : ''
            }`}>
              {block.aiSummary}
            </div>
          )}
        </div>
      )}

      {/* Block Body Content */}
      <div className="p-4 flex-1">
        {isLoading && displayItems.length === 0 ? (
          <div className="py-8 space-y-4">
            {/* Loading Skeleton */}
            <div className="flex items-center gap-3 animate-pulse">
              <div className={`w-20 h-20 rounded-control ${theme === 'dark' ? 'bg-neutral-800' : 'bg-neutral-200'}`} />
              <div className="flex-1 space-y-2">
                <div className={`h-3 w-16 rounded ${theme === 'dark' ? 'bg-neutral-800' : 'bg-neutral-200'}`} />
                <div className={`h-4 w-full rounded ${theme === 'dark' ? 'bg-neutral-800' : 'bg-neutral-200'}`} />
                <div className={`h-4 w-3/4 rounded ${theme === 'dark' ? 'bg-neutral-800' : 'bg-neutral-200'}`} />
                <div className={`h-3 w-1/2 rounded ${theme === 'dark' ? 'bg-neutral-800' : 'bg-neutral-200'}`} />
              </div>
            </div>
            <div className="flex items-center gap-3 animate-pulse">
              <div className={`w-20 h-20 rounded-control ${theme === 'dark' ? 'bg-neutral-800' : 'bg-neutral-200'}`} />
              <div className="flex-1 space-y-2">
                <div className={`h-3 w-20 rounded ${theme === 'dark' ? 'bg-neutral-800' : 'bg-neutral-200'}`} />
                <div className={`h-4 w-full rounded ${theme === 'dark' ? 'bg-neutral-800' : 'bg-neutral-200'}`} />
                <div className={`h-3 w-2/3 rounded ${theme === 'dark' ? 'bg-neutral-800' : 'bg-neutral-200'}`} />
              </div>
            </div>
            <div className="flex items-center gap-3 animate-pulse">
              <div className={`w-20 h-20 rounded-control ${theme === 'dark' ? 'bg-neutral-800' : 'bg-neutral-200'}`} />
              <div className="flex-1 space-y-2">
                <div className={`h-3 w-14 rounded ${theme === 'dark' ? 'bg-neutral-800' : 'bg-neutral-200'}`} />
                <div className={`h-4 w-5/6 rounded ${theme === 'dark' ? 'bg-neutral-800' : 'bg-neutral-200'}`} />
                <div className={`h-3 w-3/5 rounded ${theme === 'dark' ? 'bg-neutral-800' : 'bg-neutral-200'}`} />
              </div>
            </div>
            <div className="flex items-center justify-center gap-2 pt-2">
              <RefreshCw className="w-4 h-4 animate-spin text-amber-500" />
              <span className="text-sm text-neutral-400">{t.block.generatingSummary}</span>
            </div>
          </div>
        ) : displayItems.length === 0 ? (
          <div className="py-12 text-center text-zinc-500 text-sm">
            {t.block[emptyKey]}
          </div>
        ) : (
          <>
            {/* HERO LAYOUT */}
            {block.layout === 'hero' && (
              <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                {/* Featured Big Item */}
                {(() => {
                  const source = getSourceBadge(displayItems[0].sourceName);
                  return (
                    <div 
                      onClick={() => onSelectArticle(displayItems[0])}
                      onKeyDown={(event) => handleArticleCardKeyDown(event, displayItems[0])}
                      role="button"
                      tabIndex={0}
                      aria-label={`${t.block.readArticle}: ${displayItems[0].title}`}
                      className={`md:col-span-7 group cursor-pointer rounded-card overflow-hidden border ${
                        theme === 'dark'
                          ? 'border-amber-500/80 bg-[#131520] shadow-[0_0_25px_rgba(245,158,11,0.15)] hover:border-amber-400'
                          : 'border-amber-500/80 bg-white shadow-lg hover:border-amber-500'
                      } transition-all p-4 flex flex-col justify-between`}
                    >
                      <div>
                        {displayItems[0].imageUrl ? (
                          <div className={`relative aspect-video rounded-control overflow-hidden mb-3 ${
                          theme === 'dark' ? 'bg-neutral-950' : 'bg-neutral-200'
                        }`}>
                            <SafeImage 
                              src={displayItems[0].imageUrl} 
                              alt={displayItems[0].title}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              sourceName={displayItems[0].sourceName}
                            />
                            <div className={`absolute top-2.5 left-2.5 flex items-center gap-1.5 px-2 py-0.5 rounded-md backdrop-blur-md z-10 ${
                              theme === 'dark'
                                ? 'bg-neutral-950/80 border border-neutral-700/60'
                                : 'bg-white/80 border border-neutral-300/60'
                            }`}>
                              <span className={`w-3.5 h-3.5 rounded-full ${source.bg} flex items-center justify-center text-sm font-black text-white`}>
                                {source.name.charAt(0)}
                              </span>
                              <span className={`text-sm font-bold ${
                                theme === 'dark' ? 'text-neutral-100' : 'text-neutral-800'
                              }`}>
                                {source.name}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-1.5">
                              <span className={`w-4 h-4 rounded-full ${source.bg} flex items-center justify-center text-sm font-black text-white`}>
                                {source.name.charAt(0)}
                              </span>
                              <span className="text-sm font-bold text-neutral-200">
                                {source.name}
                              </span>
                            </div>
                            {renderSentiment(displayItems[0].sentiment)}
                          </div>
                        )}
                        <h3 className={`font-display font-bold text-heading leading-snug transition-colors mb-2 ${
                          theme === 'dark'
                            ? 'text-neutral-100 group-hover:text-amber-400'
                            : 'text-neutral-900 group-hover:text-amber-600'
                        }`}>
                          {displayItems[0].title}
                        </h3>
                        <p className={`text-sm line-clamp-2 leading-relaxed mb-2 ${
                          theme === 'dark' ? 'text-neutral-400' : 'text-neutral-600'
                        }`}>
                          {displayItems[0].contentSnippet}
                        </p>

                        {/* Summary Pill */}
                        <div className={`mt-2 pt-2 border-t flex items-center gap-2 ${
                          theme === 'dark' ? 'border-neutral-800/60' : 'border-neutral-200'
                        }`}>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-sm font-extrabold tracking-wide shrink-0 ${
                            theme === 'dark'
                              ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-400'
                              : 'bg-emerald-100 border-emerald-300 text-emerald-700'
                          }`}>
                            {t.block.aiSummary}
                          </span>
                          <span className={`text-sm truncate ${
                            theme === 'dark' ? 'text-neutral-300' : 'text-neutral-700'
                          }`}>
                            {displayItems[0].contentSnippet}
                          </span>
                        </div>

                        {renderMultiSourceWidget(displayItems[0])}
                      </div>

                      <div className={`flex items-center justify-between text-sm pt-3 mt-2 border-t ${
                        theme === 'dark'
                          ? 'text-neutral-400 border-neutral-800/50'
                          : 'text-neutral-600 border-neutral-200'
                      }`}>
                        <span className="flex items-center gap-1 text-sm">
                          <Clock className="w-3 h-3 text-neutral-500" />
                          {getRelativeTime(displayItems[0].timestamp)}
                          {archivedIds.has(displayItems[0].id) && (
                            <span className="ml-1 text-sm font-black text-amber-400 bg-amber-500/20 px-1.5 py-0.2 rounded border border-amber-500/30">
                              {t.block.archived}
                            </span>
                          )}
                        </span>
                        <div className="flex items-center gap-2">
                          {onToggleArchive && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onToggleArchive(displayItems[0]);
                              }}
                              aria-label={archivedIds.has(displayItems[0].id) ? t.archive.unarchive : t.block.archive}
                              title={archivedIds.has(displayItems[0].id) ? t.archive.unarchive : t.block.archive}
                              className="p-1 hover:text-amber-400 transition-colors cursor-pointer"
                            >
                              <X className={`w-3.5 h-3.5 ${archivedIds.has(displayItems[0].id) ? 'text-amber-400' : 'text-neutral-500'}`} />
                            </button>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              shareArticle({
                                title: displayItems[0].title,
                                text: displayItems[0].contentSnippet,
                                url: displayItems[0].link,
                              });
                            }}
                            aria-label={t.block.share}
                            title={t.block.share}
                            className="p-1 hover:text-amber-400 transition-colors cursor-pointer"
                          >
                            <Share2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleBookmark(displayItems[0]);
                            }}
                            aria-label={t.block.bookmark}
                            title={t.block.bookmark}
                            className={`p-1 ${acc.textHover} transition-colors cursor-pointer`}
                          >
                            <Bookmark className={`w-3.5 h-3.5 ${bookmarkedIds.has(displayItems[0].id) ? `${acc.fill}` : ''}`} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Secondary List Column (Top 4 Stories) */}
                <div className="md:col-span-5 flex flex-col gap-2.5 justify-between">
                  {displayItems.slice(1, 5).map((item) => {
                    const source = getSourceBadge(item.sourceName);
                    return (
                      <div
                        key={item.id}
                        onClick={() => onSelectArticle(item)}
                        onKeyDown={(event) => handleArticleCardKeyDown(event, item)}
                        role="button"
                        tabIndex={0}
                        aria-label={`${t.block.readArticle}: ${item.title}`}
                        className={`p-3 rounded-card border transition-all cursor-pointer group flex items-center justify-between gap-3 ${
                          theme === 'dark'
                            ? 'bg-[#131520]/80 border-neutral-800/80 hover:border-amber-500/60 hover:shadow-md'
                            : 'bg-neutral-50 border-neutral-200 hover:border-amber-500/60'
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <div className="flex items-center gap-1.5">
                              <span className={`w-3 h-3 rounded-full ${source.bg} flex items-center justify-center text-[7px] font-black text-white`}>
                                {source.name.charAt(0)}
                              </span>
                              <span className={`text-sm font-bold ${
                                theme === 'dark'
                                  ? 'text-neutral-300 group-hover:text-amber-400'
                                  : 'text-neutral-600 group-hover:text-amber-600'
                              }`}>
                                {source.name}
                              </span>
                              {(item as NewsStory).isCluster && (item as NewsStory).sourcesCount > 1 && (
                                <span className="inline-flex items-center gap-0.5 text-sm font-bold px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                                  <Layers className="w-2.5 h-2.5" />
                                  {(item as NewsStory).sourcesCount} {t.block.sources}
                                </span>
                              )}
                            </div>
                            <span className="text-sm text-neutral-400">
                              {getRelativeTime(item.timestamp)}
                            </span>
                          </div>
                          <h4 className={`font-bold text-sm leading-snug line-clamp-2 ${
                            theme === 'dark'
                              ? 'text-neutral-100 group-hover:text-amber-400'
                              : 'text-neutral-900 group-hover:text-amber-600'
                          }`}>
                            {item.title}
                          </h4>
                        </div>
                        {item.imageUrl && (
                          <div className="w-14 h-14 rounded-control overflow-hidden shrink-0 bg-neutral-950 border border-neutral-800/40">
                            <SafeImage
                              src={item.imageUrl}
                              alt={item.title}
                              fallbackType="square"
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              sourceName={item.sourceName}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Additional Stories Grid for Hero Layout when more than 5 items exist */}
            {block.layout === 'hero' && displayItems.length > 5 && (
              <div className={`mt-4 pt-4 border-t ${theme === 'dark' ? 'border-neutral-800/60' : 'border-neutral-200'}`}>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {displayItems.slice(5).map((item) => {
                    const source = getSourceBadge(item.sourceName);
                    return (
                      <div
                        key={item.id}
                        onClick={() => onSelectArticle(item)}
                        onKeyDown={(event) => handleArticleCardKeyDown(event, item)}
                        role="button"
                        tabIndex={0}
                        aria-label={`${t.block.readArticle}: ${item.title}`}
                        className={`p-3 rounded-card border transition-all cursor-pointer group flex items-center justify-between gap-3 ${
                          theme === 'dark'
                            ? 'bg-[#131520]/80 border-neutral-800/80 hover:border-amber-500/60 hover:shadow-md'
                            : 'bg-neutral-50 border-neutral-200 hover:border-amber-500/60'
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <div className="flex items-center gap-1.5">
                              <span className={`w-3 h-3 rounded-full ${source.bg} flex items-center justify-center text-[7px] font-black text-white`}>
                                {source.name.charAt(0)}
                              </span>
                              <span className={`text-sm font-bold ${
                                theme === 'dark'
                                  ? 'text-neutral-300 group-hover:text-amber-400'
                                  : 'text-neutral-600 group-hover:text-amber-600'
                              }`}>
                                {source.name}
                              </span>
                              {(item as NewsStory).isCluster && (item as NewsStory).sourcesCount > 1 && (
                                <span className="inline-flex items-center gap-0.5 text-sm font-bold px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                                  <Layers className="w-2.5 h-2.5" />
                                  {(item as NewsStory).sourcesCount} {t.block.sources}
                                </span>
                              )}
                            </div>
                            <span className="text-sm text-neutral-400">
                              {getRelativeTime(item.timestamp)}
                            </span>
                          </div>
                          <h4 className={`font-bold text-sm leading-snug line-clamp-2 ${
                            theme === 'dark'
                              ? 'text-neutral-100 group-hover:text-amber-400'
                              : 'text-neutral-900 group-hover:text-amber-600'
                          }`}>
                            {item.title}
                          </h4>
                        </div>
                        {item.imageUrl && (
                          <div className="w-12 h-12 rounded-control overflow-hidden shrink-0 bg-neutral-950 border border-neutral-800/40">
                            <SafeImage
                              src={item.imageUrl}
                              alt={item.title}
                              fallbackType="square"
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              sourceName={item.sourceName}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* GRID LAYOUT */}
            {block.layout === 'grid' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
                {displayItems.map((item, idx) => {
                  const source = getSourceBadge(item.sourceName);
                  const isFirst = idx === 0;
                  return (
                    <div
                      key={item.id}
                      onClick={() => onSelectArticle(item)}
                      onKeyDown={(event) => handleArticleCardKeyDown(event, item)}
                      role="button"
                      tabIndex={0}
                      aria-label={`${t.block.readArticle}: ${item.title}`}
                      className={`rounded-card border p-3.5 flex flex-col justify-between group cursor-pointer transition-all duration-200 ${
                        theme === 'dark'
                          ? isFirst
                            ? 'bg-[#141520] border-amber-500/80 shadow-[0_0_20px_rgba(245,158,11,0.15)] hover:border-amber-400'
                            : 'bg-[#13141c]/90 border-neutral-800/80 hover:border-amber-500/60 hover:shadow-[0_0_20px_rgba(245,158,11,0.1)]'
                          : isFirst
                            ? 'bg-white border-amber-500/80 shadow-md'
                            : 'bg-white border-neutral-200 hover:border-amber-500/60 shadow-xs'
                      }`}
                    >
                      <div>
                        {item.imageUrl && (
                          <div className={`aspect-video w-full rounded-control overflow-hidden mb-2.5 ${
                            theme === 'dark' ? 'bg-neutral-950' : 'bg-neutral-200'
                          }`}>
                            <SafeImage 
                              src={item.imageUrl} 
                              alt={item.title} 
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              sourceName={item.sourceName}
                            />
                          </div>
                        )}
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className={`w-3.5 h-3.5 rounded-full ${source.bg} flex items-center justify-center text-sm font-black text-white shrink-0`}>
                              {source.name.charAt(0)}
                            </span>
                            <span className={`text-sm font-bold truncate ${
                              theme === 'dark'
                                ? 'text-neutral-400 group-hover:text-amber-400'
                                : 'text-neutral-600 group-hover:text-amber-600'
                            }`}>
                              {source.name}
                            </span>
                          </div>
                          {renderSentiment(item.sentiment)}
                        </div>

                        <h4 className={`font-extrabold text-sm leading-snug line-clamp-3 mb-2 ${
                          theme === 'dark'
                            ? 'text-neutral-100 group-hover:text-amber-400'
                            : 'text-neutral-900 group-hover:text-amber-600'
                        }`}>
                          {item.title}
                        </h4>
                        <p className="text-sm text-neutral-400 line-clamp-2 leading-relaxed">
                          {item.contentSnippet}
                        </p>
                        {renderMultiSourceWidget(item)}
                      </div>

                      <div className={`flex items-center justify-between text-sm text-neutral-400 pt-3 mt-2 border-t ${
                        theme === 'dark' ? 'border-neutral-800/40' : 'border-neutral-200'
                      }`}>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3 text-neutral-500" />
                          {getRelativeTime(item.timestamp)}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              shareArticle({
                                title: item.title,
                                text: item.contentSnippet,
                                url: item.link,
                              });
                            }}
                            aria-label={t.block.share}
                            title={t.block.share}
                            className="p-1 hover:text-amber-400 transition-colors cursor-pointer"
                          >
                            <Share2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleBookmark(item);
                            }}
                            aria-label={t.block.bookmark}
                            title={t.block.bookmark}
                            className={`p-1 ${acc.textHover} transition-colors cursor-pointer`}
                          >
                            <Bookmark className={`w-3.5 h-3.5 ${bookmarkedIds.has(item.id) ? `${acc.fill}` : ''}`} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* LIST LAYOUT */}
            {block.layout === 'list' && (
              <div className="space-y-2.5">
                {displayItems.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => onSelectArticle(item)}
                    onKeyDown={(event) => handleArticleCardKeyDown(event, item)}
                    role="button"
                    tabIndex={0}
                    aria-label={`${t.block.readArticle}: ${item.title}`}
                    className={`p-3 rounded-card border flex items-center justify-between gap-4 group cursor-pointer transition-all ${
                      theme === 'dark'
                        ? 'bg-[#13141c]/80 border-neutral-800/80 hover:border-amber-500/60'
                        : 'bg-white border-neutral-200 hover:border-amber-500/60'
                    }`}
                  >
                    {item.imageUrl && (
                      <div className="w-16 h-16 rounded-control overflow-hidden shrink-0 bg-neutral-950 border border-neutral-800/40 hidden sm:block">
                        <SafeImage
                          src={item.imageUrl}
                          alt={item.title}
                          fallbackType="square"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          sourceName={item.sourceName}
                        />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-bold text-amber-500">
                          {item.sourceName}
                        </span>
                        <span className="text-sm text-zinc-400">
                          {getRelativeTime(item.timestamp)}
                        </span>
                        {renderSentiment(item.sentiment)}
                      </div>
                      <h4 className="font-bold text-sm sm:text-sm group-hover:text-amber-500 transition-colors truncate">
                        {item.title}
                      </h4>
                      <p className="text-sm text-zinc-500 dark:text-zinc-400 truncate">
                        {item.contentSnippet}
                      </p>
                      {renderMultiSourceWidget(item)}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          shareArticle({
                            title: item.title,
                            text: item.contentSnippet,
                            url: item.link,
                          });
                        }}
                        aria-label={t.block.share}
                        title={t.block.share}
                        className="p-1.5 hover:text-amber-500 transition-colors cursor-pointer"
                      >
                        <Share2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleBookmark(item);
                        }}
                        aria-label={t.block.bookmark}
                        title={t.block.bookmark}
                        className="p-1.5 hover:text-amber-500 transition-colors cursor-pointer"
                      >
                        <Bookmark className={`w-4 h-4 ${bookmarkedIds.has(item.id) ? 'fill-amber-500 text-amber-500' : ''}`} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* COMPACT LAYOUT */}
            {block.layout === 'compact' && (
              <div className={`divide-y ${
                theme === 'dark' ? 'divide-zinc-800/40' : 'divide-neutral-200'
              }`}>
                {displayItems.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => onSelectArticle(item)}
                    onKeyDown={(event) => handleArticleCardKeyDown(event, item)}
                    role="button"
                    tabIndex={0}
                    aria-label={`${t.block.readArticle}: ${item.title}`}
                    className="py-2 px-1 flex items-center justify-between gap-3 group cursor-pointer hover:bg-amber-500/5 rounded-chip transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                      <span className={`text-sm font-bold shrink-0 ${
                        theme === 'dark' ? 'text-zinc-400' : 'text-neutral-600'
                      }`}>
                        [{item.sourceName}]
                      </span>
                      <h4 className={`font-medium text-sm truncate group-hover:text-amber-500 ${
                        theme === 'dark' ? 'text-neutral-200' : 'text-neutral-800'
                      }`}>
                        {item.title}
                      </h4>
                      {(item as NewsStory).isCluster && (item as NewsStory).sourcesCount > 1 && (
                        <span className="inline-flex items-center gap-1 text-sm font-bold px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 shrink-0">
                          <Layers className="w-2.5 h-2.5" />
                          {(item as NewsStory).sourcesCount} {t.block.sources}
                        </span>
                      )}
                    </div>

                    <div className={`flex items-center gap-2 shrink-0 text-sm ${
                      theme === 'dark' ? 'text-zinc-500' : 'text-neutral-500'
                    }`}>
                      <span>{getRelativeTime(item.timestamp)}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          shareArticle({
                            title: item.title,
                            text: item.contentSnippet,
                            url: item.link,
                          });
                        }}
                        aria-label={t.block.share}
                        title={t.block.share}
                        className="hover:text-amber-500 transition-colors cursor-pointer"
                      >
                        <Share2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleBookmark(item);
                        }}
                        aria-label={t.block.bookmark}
                        title={t.block.bookmark}
                        className="hover:text-amber-500 transition-colors cursor-pointer"
                      >
                        <Bookmark className={`w-3.5 h-3.5 ${bookmarkedIds.has(item.id) ? 'fill-amber-500 text-amber-500' : ''}`} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* TICKER LAYOUT */}
            {block.layout === 'ticker' && (
              <div className="flex gap-3 overflow-x-auto no-scrollbar py-1">
                {displayItems.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => onSelectArticle(item)}
                    onKeyDown={(event) => handleArticleCardKeyDown(event, item)}
                    role="button"
                    tabIndex={0}
                    aria-label={`${t.block.readArticle}: ${item.title}`}
                    className={`w-64 p-3 rounded-control border shrink-0 flex flex-col justify-between group cursor-pointer transition-all ${
                      theme === 'dark'
                        ? 'bg-zinc-950/70 border-zinc-800 hover:border-amber-500/40'
                        : 'bg-zinc-50 border-zinc-200 hover:border-amber-500/40'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <span className="text-sm font-bold text-amber-500 truncate">
                          {item.sourceName}
                        </span>
                        {(item as NewsStory).isCluster && (item as NewsStory).sourcesCount > 1 && (
                          <span className="inline-flex items-center gap-0.5 text-sm font-bold px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 shrink-0">
                            <Layers className="w-2.5 h-2.5" />
                            {(item as NewsStory).sourcesCount} {t.block.sources}
                          </span>
                        )}
                      </div>
                      <h4 className="font-bold text-sm line-clamp-2 group-hover:text-amber-500">
                        {item.title}
                      </h4>
                    </div>
                    <span className="text-sm text-zinc-400 mt-2 block">
                      {getRelativeTime(item.timestamp)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

    </div>
  );
};
