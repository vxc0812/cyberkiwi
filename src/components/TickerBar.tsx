import React, { useRef, useEffect, useState } from 'react';
import { NewsItem, AccentColor } from '../types';
import { getAccent } from '../utils/theme';
import { Language, getTranslation } from '../i18n/translations';
import { Pause, Play } from 'lucide-react';

interface TickerBarProps {
  items: NewsItem[];
  onSelectArticle: (item: NewsItem) => void;
  theme: 'dark' | 'light';
  accentColor?: AccentColor;
  language?: Language;
}

export const TickerBar: React.FC<TickerBarProps> = ({ items, onSelectArticle, theme, accentColor, language = 'en' }) => {
  const t = getTranslation(language);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  // Take top 12 newest articles, doubled for seamless loop
  const breakingItems = items.slice(0, 12);
  const doubledItems = [...breakingItems, ...breakingItems];

  // Auto-scroll animation
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setPrefersReducedMotion(media.matches);
    updatePreference();
    media.addEventListener?.('change', updatePreference);
    return () => media.removeEventListener?.('change', updatePreference);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || isPaused || isHovered || prefersReducedMotion) return;

    let animId: number;
    let scrollPos = el.scrollLeft;
    const speed = 0.5; // px per frame

    const tick = () => {
      scrollPos += speed;
      // Reset when we've scrolled through the first set
      if (scrollPos >= el.scrollWidth / 2) {
        scrollPos = 0;
      }
      el.scrollLeft = scrollPos;
      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [isPaused, isHovered, prefersReducedMotion, breakingItems.length]);

  return (
    <div className="w-full">
      <div className={`w-full overflow-hidden text-sm py-2 px-4 rounded-card border transition-all shadow-md flex items-center gap-3 ${
        theme === 'dark'
          ? 'bg-gradient-to-r from-amber-950/40 via-[#19150d] to-amber-950/40 border-amber-500/40 text-neutral-200'
          : 'bg-amber-50 border-amber-300 text-amber-950'
      }`}>
        
        {/* Left Label Prefix with border separator */}
        <div className="flex items-center gap-1.5 shrink-0 text-amber-400 font-extrabold text-sm pr-3 border-r border-amber-500/30 z-10 select-none">
          <span className="text-amber-400 font-black">{t.ticker.breaking}</span>
        </div>

        <button
          type="button"
          onClick={() => setIsPaused((paused) => !paused)}
          aria-label={isPaused ? t.ticker.resume : t.ticker.pause}
          aria-pressed={isPaused}
          className="shrink-0 rounded-chip p-1.5 text-amber-400 hover:bg-amber-500/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
        >
          {isPaused ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>

        {/* Horizontal Scrolling Headlines with soft gradient edge mask */}
        <div
          ref={scrollRef}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          className="min-w-0 flex-1 overflow-x-auto no-scrollbar stories-scroll-container whitespace-nowrap flex items-center gap-5 py-0.5 px-3"
          style={{
            maskImage: 'linear-gradient(to right, transparent 0%, black 20px, black calc(100% - 20px), transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 20px, black calc(100% - 20px), transparent 100%)',
          }}
        >
          {doubledItems.map((item, idx) => (
            <button
              key={`${item.id}-${idx}`}
              aria-hidden={idx >= breakingItems.length || undefined}
              tabIndex={idx >= breakingItems.length ? -1 : undefined}
              onClick={() => onSelectArticle(item)}
              onMouseEnter={() => setIsHovered(true)}
              onMouseLeave={() => setIsHovered(false)}
              className="inline-flex items-center gap-2 group cursor-pointer text-left transition-colors shrink-0"
            >
              <span className={`font-semibold text-sm transition-colors max-w-sm sm:max-w-md truncate ${
                theme === 'dark' ? 'text-neutral-100 group-hover:text-amber-400' : 'text-neutral-900 group-hover:text-amber-700'
              }`}>
                {item.title}
              </span>
              <span className={`text-sm font-bold ${
                theme === 'dark' ? 'text-amber-400/90' : 'text-amber-700'
              }`}>
                [{item.sourceName}]
              </span>
              <span className="text-amber-500/60 font-bold ml-3 text-sm select-none">•</span>
            </button>
          ))}
        </div>

      </div>
    </div>
  );
};
