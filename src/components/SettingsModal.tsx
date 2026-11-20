import React, { useState, useEffect, useRef } from 'react';
import { X, Settings, RotateCcw, Volume2, Clock, LayoutGrid, BellRing, Sparkles, AlertTriangle, Send, Info, Sun, Moon, Palette, Globe, CheckCircle2, Eye, EyeOff, Layers, Monitor, Keyboard, BookOpen } from 'lucide-react';
import { AppSettings, AccentColor, DeduplicationSettings } from '../types';
import { getTranslation } from '../i18n/translations';
import {
  checkNotificationPermission,
  requestNotificationPermission,
  sendNativeNotification,
} from '../services/notificationService';
import { checkServerAiStatus } from '../services/apiAdapter';
import { AiKeySection } from './AiKeySection';
import { AuthPanel } from './AuthPanel';

interface SettingsModalProps {
  isOpen: boolean;
  accountOnly?: boolean;
  onClose: () => void;
  settings: AppSettings;
  onUpdateSettings: (newSettings: AppSettings) => void;
  onResetToDefaults: () => void;
  onTriggerToast?: (toast: { title: string; message: string; type?: 'breaking' | 'info' | 'success' | 'warning' }) => void;
}

const ACCENT_COLORS: {
  id: AccentColor;
  colorBg: string;
  activeBorder: string;
  bgLight: string;
  ringColor: string;
}[] = [
  { id: 'orange', colorBg: 'bg-orange-500', activeBorder: 'border-orange-500 text-orange-400', bgLight: 'bg-orange-500/10', ringColor: 'ring-orange-500/50' },
  { id: 'emerald', colorBg: 'bg-emerald-500', activeBorder: 'border-emerald-500 text-emerald-400', bgLight: 'bg-emerald-500/10', ringColor: 'ring-emerald-500/50' },
  { id: 'cyan', colorBg: 'bg-cyan-500', activeBorder: 'border-cyan-500 text-cyan-400', bgLight: 'bg-cyan-500/10', ringColor: 'ring-cyan-500/50' },
  { id: 'purple', colorBg: 'bg-purple-500', activeBorder: 'border-purple-500 text-purple-400', bgLight: 'bg-purple-500/10', ringColor: 'ring-purple-500/50' },
  { id: 'red', colorBg: 'bg-red-500', activeBorder: 'border-red-500 text-red-400', bgLight: 'bg-red-500/10', ringColor: 'ring-red-500/50' },
  { id: 'amber', colorBg: 'bg-amber-500', activeBorder: 'border-amber-500 text-amber-400', bgLight: 'bg-amber-500/10', ringColor: 'ring-amber-500/50' },
  { id: 'blue', colorBg: 'bg-blue-500', activeBorder: 'border-blue-500 text-blue-400', bgLight: 'bg-blue-500/10', ringColor: 'ring-blue-500/50' },
  { id: 'pink', colorBg: 'bg-pink-500', activeBorder: 'border-pink-500 text-pink-400', bgLight: 'bg-pink-500/10', ringColor: 'ring-pink-500/50' },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  accountOnly = false,
  onClose,
  settings,
  onUpdateSettings,
  onResetToDefaults,
  onTriggerToast,
}) => {
  const [keywordInput, setKeywordInput] = useState('');
  const [permissionState, setPermissionState] = useState<'granted' | 'denied' | 'prompt' | 'unsupported'>('prompt');
  const [isValidatingGemini, setIsValidatingGemini] = useState<boolean>(false);
  const [geminiValidation, setGeminiValidation] = useState<{ status: 'idle' | 'valid' | 'invalid'; message?: string }>({ status: 'idle' });
  const [autoStart, setAutoStart] = useState<boolean>(settings.launchOnStartup ?? false);
  const [minimizeToTray, setMinimizeToTray] = useState<boolean>(settings.minimizeToTray ?? true);
  const modalRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const isElectron = typeof window !== 'undefined' && Boolean(window.electronAPI?.isElectron);
  const t = getTranslation(settings.language);

  useEffect(() => {
    if (!isOpen) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => modalRef.current?.focus(), 0);
    checkNotificationPermission().then((status) => {
      setPermissionState(status);
    });
    if (isElectron && window.electronAPI) {
      window.electronAPI.getAutoStart().then((enabled) => setAutoStart(enabled)).catch(() => {});
      window.electronAPI.getMinimizeToTray().then((enabled) => setMinimizeToTray(enabled)).catch(() => {});
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !modalRef.current) return;
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        modalRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modalRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [isOpen, isElectron, onClose]);

  if (!isOpen) return null;

  const handleToggleNotification = async (enabled: boolean) => {
    if (enabled) {
      const current = await checkNotificationPermission();
      if (current !== 'granted') {
        const granted = await requestNotificationPermission();
        const updatedStatus = await checkNotificationPermission();
        setPermissionState(updatedStatus);
        if (!granted) {
          if (onTriggerToast) {
            onTriggerToast({
              title: t.toast.notificationsDenied,
              message: t.toast.notificationsDeniedMsg,
              type: 'warning',
            });
          }
          onUpdateSettings({ ...settings, browserNotifications: false });
          return;
        }
      }
    }
    onUpdateSettings({ ...settings, browserNotifications: enabled });
  };

  const handleTestNotification = async () => {
    const success = await sendNativeNotification({
      title: t.toast.testTitle,
      body: t.toast.testMessage,
      id: 'radar-rss-test-' + Date.now(),
      imageUrl: 'https://images.unsplash.com/photo-1504711434969-e33886168f5c?auto=format&fit=crop&w=120&q=80',
    });

    const status = await checkNotificationPermission();
    setPermissionState(status);

    if (onTriggerToast) {
      onTriggerToast({
        title: t.toast.testTitle,
        message: success ? t.toast.testMessage : `${t.toast.testMessage} (In-App)`,
        type: 'info',
      });
    }
  };

  const handleValidateGemini = async () => {
    setIsValidatingGemini(true);
    setGeminiValidation({ status: 'idle' });

    try {
      const result = await checkServerAiStatus();
      if (result.valid) {
        setGeminiValidation({ status: 'valid', message: result.message });
        if (onTriggerToast) {
          onTriggerToast({
            title: 'Google Gemini AI',
            message: result.message,
            type: 'success',
          });
        }
      } else {
        setGeminiValidation({ status: 'invalid', message: result.message });
        if (onTriggerToast) {
          onTriggerToast({
            title: 'Google Gemini AI',
            message: result.message,
            type: 'warning',
          });
        }
      }
    } catch (err: any) {
      const errMsg = err.message || t.settings.aiStatusUnavailable;
      setGeminiValidation({ status: 'invalid', message: errMsg });
      if (onTriggerToast) {
        onTriggerToast({
          title: 'Google Gemini AI',
          message: errMsg,
          type: 'warning',
        });
      }
    } finally {
      setIsValidatingGemini(false);
    }
  };

  const handleAddKeyword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!keywordInput.trim()) return;
    const kw = keywordInput.trim();
    if (!settings.breakingKeywords.includes(kw)) {
      onUpdateSettings({
        ...settings,
        breakingKeywords: [...settings.breakingKeywords, kw],
      });
    }
    setKeywordInput('');
  };

  const handleRemoveKeyword = (kwToRemove: string) => {
    onUpdateSettings({
      ...settings,
      breakingKeywords: settings.breakingKeywords.filter((kw) => kw !== kwToRemove),
    });
  };

  const handleToggleMinimizeToTray = async (enabled: boolean) => {
    setMinimizeToTray(enabled);
    if (isElectron && window.electronAPI) {
      await window.electronAPI.setMinimizeToTray(enabled);
    }
    onUpdateSettings({ ...settings, minimizeToTray: enabled });
  };

  const handleToggleAutoStart = async (enabled: boolean) => {
    setAutoStart(enabled);
    if (isElectron && window.electronAPI) {
      const updated = await window.electronAPI.setAutoStart(enabled);
      setAutoStart(updated);
    }
    onUpdateSettings({ ...settings, launchOnStartup: enabled });
  };

  const handleToggleFlashTaskbar = (enabled: boolean) => {
    onUpdateSettings({ ...settings, flashTaskbarOnBreaking: enabled });
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="settings-modal-title" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div ref={modalRef} tabIndex={-1} className={`w-full max-w-md rounded-hero border shadow-2xl overflow-hidden flex flex-col max-h-[90vh] ${
        settings.theme === 'dark' ? 'bg-neutral-900 border-neutral-700 text-neutral-100' : 'bg-white border-neutral-300 text-neutral-900'
      }`}>
        
        {/* Header */}
        <div className={`p-5 border-b flex items-center justify-between ${
          settings.theme === 'dark' ? 'bg-neutral-950/80 border-neutral-800' : 'bg-neutral-100 border-neutral-200'
        }`}>
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-orange-500" />
            <h3 id="settings-modal-title" className="font-display font-bold text-heading">
              {accountOnly ? (settings.language === 'pt' ? 'Conta' : 'Account') : t.settings.title}
            </h3>
          </div>
          <button
            onClick={onClose}
            aria-label={t.settings.close}
            className={`p-1.5 rounded-control border transition-colors cursor-pointer ${
              settings.theme === 'dark' ? 'hover:bg-neutral-800 border-neutral-700 text-neutral-300' : 'hover:bg-neutral-200 border-neutral-300 text-neutral-700'
            }`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <div className="p-6 space-y-5 overflow-y-auto">
          {accountOnly ? <AuthPanel theme={settings.theme} /> : <>
          
          {/* Language Selector */}
          <div className={`p-4 rounded-card border space-y-3 ${
            settings.theme === 'dark' ? 'border-neutral-800 bg-neutral-950/60' : 'border-neutral-200 bg-neutral-50/80'
          }`}>
            <div className="flex items-center justify-between">
              <label className="text-sm font-black flex items-center gap-1.5">
                <Globe className="w-4 h-4 text-orange-500" />
                {t.settings.language}
              </label>

              <div className={`flex items-center border rounded-control p-1 gap-1 ${
                settings.theme === 'dark' ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200 shadow-xs'
              }`}>
                <button
                  type="button"
                  onClick={() => onUpdateSettings({ ...settings, language: 'en' })}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-chip text-sm font-extrabold transition-all ${
                    (settings.language || 'en') === 'en' ? 'bg-orange-500 text-black shadow-xs' : settings.theme === 'dark' ? 'text-neutral-400 hover:text-neutral-200' : 'text-neutral-500 hover:text-neutral-900'
                  }`}
                >
                  🇬🇧 English
                </button>
                <button
                  type="button"
                  onClick={() => onUpdateSettings({ ...settings, language: 'pt' })}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-chip text-sm font-extrabold transition-all ${
                    settings.language === 'pt' ? 'bg-orange-500 text-black shadow-xs' : settings.theme === 'dark' ? 'text-neutral-400 hover:text-neutral-200' : 'text-neutral-500 hover:text-neutral-900'
                  }`}
                >
                  🇧🇷 Português
                </button>
              </div>
            </div>
          </div>

          {/* Theme & Accent Color Section */}
          <div className={`p-4 rounded-card border space-y-3.5 ${
            settings.theme === 'dark' ? 'border-neutral-800 bg-neutral-950/60' : 'border-neutral-200 bg-neutral-50/80'
          }`}>
            <div className="flex items-center justify-between">
              <label className="text-sm font-black flex items-center gap-1.5">
                <Palette className="w-4 h-4 text-orange-500" />
                {t.settings.theme}
              </label>

              {/* Light / Dark Mode Toggle Buttons */}
              <div className={`flex items-center border rounded-control p-1 gap-1 ${
                settings.theme === 'dark' ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200 shadow-xs'
              }`}>
                <button
                  type="button"
                  onClick={() => onUpdateSettings({ ...settings, theme: 'dark' })}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-chip text-sm font-extrabold transition-all ${
                    settings.theme === 'dark' ? 'bg-neutral-800 text-white shadow-xs' : 'text-neutral-500 hover:text-neutral-900'
                  }`}
                >
                  <Moon className="w-3.5 h-3.5 text-sky-400" />
                  {t.settings.themeDark}
                </button>
                <button
                  type="button"
                  onClick={() => onUpdateSettings({ ...settings, theme: 'light' })}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-chip text-sm font-extrabold transition-all ${
                    settings.theme === 'light' ? 'bg-amber-500/20 text-amber-600 border border-amber-500/30' : settings.theme === 'dark' ? 'text-neutral-400 hover:text-neutral-200' : 'text-neutral-500 hover:text-neutral-900'
                  }`}
                >
                  <Sun className="w-3.5 h-3.5 text-amber-500" />
                  {t.settings.themeLight}
                </button>
              </div>
            </div>

            {/* Accent Color Palette Selector */}
            <div className={`pt-2 border-t ${
              settings.theme === 'dark' ? 'border-neutral-800/60' : 'border-neutral-200'
            }`}>
              <span className="block text-sm font-bold text-neutral-400 mb-2">
                {t.settings.accentColor}:
              </span>
              <div className="grid grid-cols-4 gap-2">
                {ACCENT_COLORS.map((acc) => {
                  const isSelected = (settings.accentColor || 'orange') === acc.id;
                  const label = t.settings.colors[acc.id] || acc.id;
                  return (
                    <button
                      key={acc.id}
                      type="button"
                      onClick={() => onUpdateSettings({ ...settings, accentColor: acc.id })}
                      className={`flex items-center gap-2 p-2 rounded-control border transition-all text-left cursor-pointer ${
                        isSelected
                          ? `${acc.activeBorder} ${acc.bgLight} font-black ring-1 ${acc.ringColor}`
                          : settings.theme === 'dark'
                          ? 'border-neutral-800 bg-neutral-900/50 hover:border-neutral-700 text-neutral-400'
                          : 'border-neutral-200 bg-white hover:border-neutral-300 text-neutral-600'
                      }`}
                    >
                      <span className={`w-3.5 h-3.5 rounded-full ${acc.colorBg} shrink-0 shadow-sm`} />
                      <span className="text-sm font-bold truncate">{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          
          {/* Global Auto Refresh Interval */}
          <div>
            <label htmlFor="global-refresh-select" className="block text-sm font-black mb-2 flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-orange-500" />
              {t.settings.globalRefresh}
            </label>
            <select
              id="global-refresh-select"
              value={settings.globalRefreshSec ?? 60}
              onChange={(e) => onUpdateSettings({ ...settings, globalRefreshSec: Number(e.target.value) })}
              className={`w-full px-4 py-3 text-sm font-bold rounded-card border ${
                settings.theme === 'dark' ? 'bg-neutral-950 border-neutral-800 focus:border-orange-500' : 'bg-neutral-50 border-neutral-200'
              }`}
            >
              <option value={30}>30s (Real-time)</option>
              <option value={60}>1 min (Recommended)</option>
              <option value={120}>2 min</option>
              <option value={300}>5 min</option>
              <option value={0}>Manual only</option>
            </select>
          </div>

          {/* Default Reader View Mode */}
          <div>
            <label htmlFor="default-reader-mode-select" className="block text-sm font-black mb-2 flex items-center gap-1.5">
              <BookOpen className="w-4 h-4 text-orange-500" />
              {t.settings.defaultReaderMode}
            </label>
            <select
              id="default-reader-mode-select"
              value={settings.defaultReaderMode ?? 'full'}
              onChange={(e) => onUpdateSettings({ ...settings, defaultReaderMode: e.target.value as any })}
              className={`w-full px-4 py-3 text-sm font-bold rounded-card border ${
                settings.theme === 'dark' ? 'bg-neutral-950 border-neutral-800 focus:border-orange-500' : 'bg-neutral-50 border-neutral-200'
              }`}
            >
              <option value="full">{t.settings.readerModeFull}</option>
              <option value="snippet">{t.settings.readerModeSnippet}</option>
            </select>
            <p className="text-sm text-neutral-400 mt-1 pl-1">
              {t.settings.defaultReaderModeDesc}
            </p>
          </div>

          {/* Smart Deduplication & News Clustering */}
          <div className={`p-4 rounded-card border space-y-3.5 ${
            settings.theme === 'dark' ? 'border-neutral-800 bg-neutral-950/60' : 'border-neutral-200 bg-neutral-50/80'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Layers className="w-4 h-4 text-orange-500 shrink-0" />
                <div>
                  <span className="block text-sm font-black">{t.settings.deduplication}</span>
                  <span className="text-sm text-neutral-400">{t.settings.deduplicationDesc}</span>
                </div>
              </div>
              <input
                type="checkbox"
                aria-label={t.settings.deduplication}
                checked={settings.deduplication?.enabled ?? true}
                onChange={(e) => {
                  const current = settings.deduplication ?? {
                    enabled: true,
                    similarityThreshold: 0.58,
                    timeWindowHours: 48,
                    maxArticlesPerCluster: 12,
                    strategy: 'balanced' as const,
                  };
                  onUpdateSettings({
                    ...settings,
                    deduplication: { ...current, enabled: e.target.checked },
                  });
                }}
                className="w-4 h-4 accent-orange-500 rounded cursor-pointer"
              />
            </div>

            {(settings.deduplication?.enabled ?? true) && (
              <div className={`pt-3 border-t space-y-3 ${
                settings.theme === 'dark' ? 'border-neutral-800/60' : 'border-neutral-200'
              }`}>
                {/* Clustering Strategy */}
                <div>
                  <label className="block text-sm font-bold text-neutral-400 mb-1.5">
                    {t.settings.clusteringStrategy}:
                  </label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { id: 'conservative', label: t.settings.strategyConservative.split(' ')[0] },
                      { id: 'balanced', label: t.settings.strategyBalanced.split(' ')[0] },
                      { id: 'aggressive', label: t.settings.strategyAggressive.split(' ')[0] },
                    ].map((st) => {
                      const currentStrategy = settings.deduplication?.strategy ?? 'balanced';
                      const isSelected = currentStrategy === st.id;
                      return (
                        <button
                          key={st.id}
                          type="button"
                          onClick={() => {
                            const current = settings.deduplication ?? {
                              enabled: true,
                              similarityThreshold: 0.58,
                              timeWindowHours: 48,
                              maxArticlesPerCluster: 12,
                              strategy: 'balanced' as const,
                            };
                            onUpdateSettings({
                              ...settings,
                              deduplication: { ...current, strategy: st.id as any },
                            });
                          }}
                          className={`py-1.5 px-2 rounded-control text-sm font-black border transition-all cursor-pointer ${
                            isSelected
                              ? 'bg-orange-500 text-black border-orange-500 font-extrabold'
                              : settings.theme === 'dark'
                              ? 'border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:border-neutral-700'
                              : 'border-neutral-200 bg-white text-neutral-600'
                          }`}
                        >
                          {st.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Time correlation window & Max sources */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="time-window-select" className="block text-sm font-bold text-neutral-400 mb-1">
                      {t.settings.timeWindow}:
                    </label>
                    <select
                      id="time-window-select"
                      value={settings.deduplication?.timeWindowHours ?? 48}
                      onChange={(e) => {
                        const current = settings.deduplication ?? {
                          enabled: true,
                          similarityThreshold: 0.58,
                          timeWindowHours: 48,
                          maxArticlesPerCluster: 12,
                          strategy: 'balanced' as const,
                        };
                        onUpdateSettings({
                          ...settings,
                          deduplication: { ...current, timeWindowHours: Number(e.target.value) },
                        });
                      }}
                      className={`w-full px-2.5 py-1.5 text-sm font-bold rounded-control border ${
                        settings.theme === 'dark' ? 'bg-neutral-950 border-neutral-800 text-neutral-200' : 'bg-white border-neutral-200 text-neutral-800'
                      }`}
                    >
                      <option value={12}>12h</option>
                      <option value={24}>24h</option>
                      <option value={48}>48h (Default)</option>
                      <option value={72}>72h</option>
                      <option value={120}>5 days</option>
                    </select>
                  </div>

                  <div>
                    <label htmlFor="max-sources-select" className="block text-sm font-bold text-neutral-400 mb-1">
                      {t.settings.maxSourcesPerStory}:
                    </label>
                    <select
                      id="max-sources-select"
                      value={settings.deduplication?.maxArticlesPerCluster ?? 12}
                      onChange={(e) => {
                        const current = settings.deduplication ?? {
                          enabled: true,
                          similarityThreshold: 0.58,
                          timeWindowHours: 48,
                          maxArticlesPerCluster: 12,
                          strategy: 'balanced' as const,
                        };
                        onUpdateSettings({
                          ...settings,
                          deduplication: { ...current, maxArticlesPerCluster: Number(e.target.value) },
                        });
                      }}
                      className={`w-full px-2.5 py-1.5 text-sm font-bold rounded-control border ${
                        settings.theme === 'dark' ? 'bg-neutral-950 border-neutral-800 text-neutral-200' : 'bg-white border-neutral-200 text-neutral-800'
                      }`}
                    >
                      <option value={5}>5 sources</option>
                      <option value={8}>8 sources</option>
                      <option value={12}>12 sources (Default)</option>
                      <option value={20}>20 sources</option>
                    </select>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Browser Notifications Section */}
          <div className={`p-4 rounded-card border space-y-3 ${
            settings.theme === 'dark' ? 'border-neutral-800 bg-neutral-950/60' : 'border-neutral-200 bg-neutral-50/80'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <BellRing className="w-4 h-4 text-orange-500 shrink-0" />
                <div>
                  <span className="block text-sm font-black">{t.settings.notifications}</span>
                  <span className="text-sm text-neutral-400">{t.settings.notificationsDesc}</span>
                </div>
              </div>
              <input
                type="checkbox"
                aria-label={t.settings.notifications}
                checked={settings.browserNotifications ?? false}
                onChange={(e) => handleToggleNotification(e.target.checked)}
                className="w-4 h-4 accent-orange-500 rounded cursor-pointer"
              />
            </div>

            {/* Permission status bar & Test button */}
            <div className={`flex items-center justify-between pt-2 border-t text-sm ${
              settings.theme === 'dark' ? 'border-neutral-800/80' : 'border-neutral-200'
            }`}>
              <span className="flex items-center gap-1 text-neutral-400">
                Status:
                {permissionState === 'granted' && <span className="text-emerald-400 font-bold">● Active</span>}
                {permissionState === 'denied' && <span className="text-red-400 font-bold">● Blocked by OS</span>}
                {(permissionState === 'prompt' || (permissionState as string) === 'default') && <span className="text-amber-400 font-bold">● Pending</span>}
                {permissionState === 'unsupported' && <span className="text-neutral-500 font-bold">● Unsupported</span>}
              </span>

              <button
                type="button"
                onClick={handleTestNotification}
                className="px-2.5 py-1 rounded-control bg-orange-500/20 border border-orange-500/40 text-orange-400 hover:bg-orange-500/30 font-bold text-sm flex items-center gap-1 transition-colors"
              >
                <Send className="w-3 h-3" />
                <span>{t.settings.testNotification}</span>
              </button>
            </div>
          </div>

          {/* Breaking News Keywords Manager */}
          <div>
            <label htmlFor="breaking-keyword-input" className="block text-sm font-black mb-2 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-orange-500" />
              {t.settings.breakingKeywords}
            </label>
            <p className="text-sm text-neutral-400 mb-2">
              {t.settings.breakingKeywordsDesc}
            </p>
            
            <div className="flex flex-wrap gap-1.5 mb-2">
              {settings.breakingKeywords.map((kw) => (
                <span
                  key={kw}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-control bg-orange-500/10 border border-orange-500/30 text-orange-400 text-sm font-bold"
                >
                  {kw}
                  <button
                    onClick={() => handleRemoveKeyword(kw)}
                    aria-label={`Remove ${kw}`}
                    className="hover:text-red-400 ml-0.5 text-sm font-bold"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>

            <form onSubmit={handleAddKeyword} className="flex gap-2">
              <input
                type="text"
                id="breaking-keyword-input"
                value={keywordInput}
                onChange={(e) => setKeywordInput(e.target.value)}
                placeholder={t.settings.keywordPlaceholder}
                className={`flex-1 px-3 py-2 text-sm font-semibold rounded-control border ${
                  settings.theme === 'dark' ? 'bg-neutral-950 border-neutral-800 focus:border-orange-500' : 'bg-neutral-50 border-neutral-200'
                }`}
              />
              <button
                type="submit"
                className="px-3 py-2 rounded-control bg-orange-500 text-black font-black text-sm hover:bg-orange-400 transition-colors"
              >
                + {t.settings.addKeyword}
              </button>
            </form>
          </div>

          {/* Sound Alert Toggle */}
          <div className={`flex items-center justify-between p-4 rounded-card border ${
            settings.theme === 'dark' ? 'border-neutral-800 bg-neutral-950/60' : 'border-neutral-200 bg-neutral-50/80'
          }`}>
            <div className="flex items-center gap-2.5">
              <Volume2 className="w-4 h-4 text-orange-500 shrink-0" />
              <div>
                <span className="block text-sm font-black">{t.settings.soundAlerts}</span>
                <span className="text-sm text-neutral-400">{t.settings.soundAlertsDesc}</span>
              </div>
            </div>
            <input
              type="checkbox"
              aria-label={t.settings.soundAlerts}
              checked={settings.soundAlerts ?? true}
              onChange={(e) => onUpdateSettings({ ...settings, soundAlerts: e.target.checked })}
              className="w-4 h-4 accent-orange-500 rounded cursor-pointer"
            />
          </div>

          {/* Windows Desktop Integration Section */}
          {isElectron && (
            <div className={`p-4 rounded-card border space-y-4 ${
              settings.theme === 'dark' ? 'border-neutral-800 bg-neutral-950/60' : 'border-neutral-200 bg-neutral-50/80'
            }`}>
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4 text-orange-500 shrink-0" />
                <span className="font-extrabold text-sm">
                  {t.settings.desktop.title}
                </span>
              </div>

              {/* Minimize to Tray */}
              <div className="flex items-center justify-between pt-1">
                <div className="pr-3">
                  <span className="block text-sm font-bold">{t.settings.desktop.minimizeToTray}</span>
                  <span className="text-sm text-neutral-400 block">
                    {t.settings.desktop.minimizeToTrayDesc}
                  </span>
                </div>
                <input
                  type="checkbox"
                  aria-label={t.settings.desktop.minimizeToTray}
                  checked={minimizeToTray}
                  onChange={(e) => handleToggleMinimizeToTray(e.target.checked)}
                  className="w-4 h-4 accent-orange-500 rounded cursor-pointer shrink-0"
                />
              </div>

              {/* Launch on Startup */}
              <div className={`flex items-center justify-between pt-3 border-t ${
                settings.theme === 'dark' ? 'border-neutral-800/80' : 'border-neutral-200'
              }`}>
                <div className="pr-3">
                  <span className="block text-sm font-bold">{t.settings.desktop.launchOnStartup}</span>
                  <span className="text-sm text-neutral-400 block">
                    {t.settings.desktop.launchOnStartupDesc}
                  </span>
                </div>
                <input
                  type="checkbox"
                  aria-label={t.settings.desktop.launchOnStartup}
                  checked={autoStart}
                  onChange={(e) => handleToggleAutoStart(e.target.checked)}
                  className="w-4 h-4 accent-orange-500 rounded cursor-pointer shrink-0"
                />
              </div>

              {/* Flash Taskbar */}
              <div className={`flex items-center justify-between pt-3 border-t ${
                settings.theme === 'dark' ? 'border-neutral-800/80' : 'border-neutral-200'
              }`}>
                <div className="pr-3">
                  <span className="block text-sm font-bold">{t.settings.desktop.flashTaskbar}</span>
                  <span className="text-sm text-neutral-400 block">
                    {t.settings.desktop.flashTaskbarDesc}
                  </span>
                </div>
                <input
                  type="checkbox"
                  aria-label={t.settings.desktop.flashTaskbar}
                  checked={settings.flashTaskbarOnBreaking ?? true}
                  onChange={(e) => handleToggleFlashTaskbar(e.target.checked)}
                  className="w-4 h-4 accent-orange-500 rounded cursor-pointer shrink-0"
                />
              </div>

              {/* Desktop Shortcuts Cheat Sheet */}
              <div className={`pt-3 border-t space-y-2 ${
                settings.theme === 'dark' ? 'border-neutral-800/80' : 'border-neutral-200'
              }`}>
                <div className="flex items-center gap-1.5 text-sm font-bold text-neutral-300">
                  <Keyboard className="w-3.5 h-3.5 text-orange-400" />
                  <span>{t.settings.desktop.shortcutsTitle}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-sm">
                  <div className="flex items-center justify-between p-1.5 rounded-chip bg-neutral-900/60 border border-neutral-800/60">
                    <span className="text-neutral-400 truncate mr-2">{t.settings.desktop.shortcutRefresh}</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 text-orange-400 font-bold shrink-0">F5 / Ctrl+R</kbd>
                  </div>
                  <div className="flex items-center justify-between p-1.5 rounded-chip bg-neutral-900/60 border border-neutral-800/60">
                    <span className="text-neutral-400 truncate mr-2">{t.settings.desktop.shortcutSearch}</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 text-orange-400 font-bold shrink-0">Ctrl+F</kbd>
                  </div>
                  <div className="flex items-center justify-between p-1.5 rounded-chip bg-neutral-900/60 border border-neutral-800/60">
                    <span className="text-neutral-400 truncate mr-2">{t.settings.desktop.shortcutSettings}</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 text-orange-400 font-bold shrink-0">Ctrl+,</kbd>
                  </div>
                  <div className="flex items-center justify-between p-1.5 rounded-chip bg-neutral-900/60 border border-neutral-800/60">
                    <span className="text-neutral-400 truncate mr-2">{t.settings.desktop.shortcutBookmarks}</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 text-orange-400 font-bold shrink-0">Ctrl+B</kbd>
                  </div>
                  <div className="flex items-center justify-between p-1.5 rounded-chip bg-neutral-900/60 border border-neutral-800/60">
                    <span className="text-neutral-400 truncate mr-2">{t.settings.desktop.shortcutNewBlock}</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 text-orange-400 font-bold shrink-0">Ctrl+N</kbd>
                  </div>
                  <div className="flex items-center justify-between p-1.5 rounded-chip bg-neutral-900/60 border border-neutral-800/60">
                    <span className="text-neutral-400 truncate mr-2">{t.settings.desktop.shortcutTheme}</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 text-orange-400 font-bold shrink-0">Ctrl+D</kbd>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Account: login, register, sign out */}
          <AuthPanel theme={settings.theme} />

          {/* Your own Gemini key (stored in the Keychain/Keystore on native; memory on web unless encrypted) */}
          <AiKeySection theme={settings.theme} />

          {/* Layout Grid Columns */}
          <div>
            <label className="block text-sm font-black mb-2 flex items-center gap-1.5">
              <LayoutGrid className="w-4 h-4 text-orange-500" />
              {t.settings.layoutCols}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[1, 2, 3].map((cols) => (
                <button
                  key={cols}
                  type="button"
                  onClick={() => onUpdateSettings({ ...settings, layoutCols: cols })}
                  className={`py-2.5 px-3 rounded-card border text-sm font-black transition-all ${
                    settings.layoutCols === cols
                      ? 'bg-orange-500 text-black border-orange-500'
                      : settings.theme === 'dark'
                      ? 'bg-neutral-950/60 border-neutral-800 text-neutral-400 hover:border-neutral-700'
                      : 'bg-neutral-50 border-neutral-200 text-neutral-600'
                  }`}
                >
                  {cols} {cols === 1 ? 'Column' : 'Columns'}
                </button>
              ))}
            </div>
          </div>

          {/* App Info & Developer Link */}
          <div className={`p-4 rounded-card border ${
            settings.theme === 'dark' ? 'bg-neutral-950/80 border-neutral-800' : 'bg-neutral-50 border-neutral-200'
          } space-y-3`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Info className="w-4 h-4 text-orange-500" />
                <span className="font-extrabold text-sm">CYBERKIWI</span>
              </div>
              <span className="px-2 py-0.5 rounded text-sm bg-amber-500/20 text-amber-400 font-bold border border-amber-500/30">
                v0.2.0
              </span>
            </div>

            <p className="text-sm text-neutral-400 pl-6">
              Version 0.2.0. Global real-time news (English default)
            </p>

            <a
              href="https://t.me/Ahderiva"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-control border border-sky-500/30 bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 font-bold text-sm transition-all shadow-sm group cursor-pointer"
            >
              <Send className="w-3.5 h-3.5 text-sky-400 group-hover:scale-110 transition-transform" />
              <span>Developer: @Ahderiva</span>
            </a>
          </div>

          {/* Reset Defaults */}
          <div className={`pt-4 border-t ${
            settings.theme === 'dark' ? 'border-neutral-800' : 'border-neutral-200'
          }`}>
            <button
              onClick={() => {
                if (window.confirm(t.settings.resetConfirm)) {
                  onResetToDefaults();
                }
              }}
              className="w-full py-3 px-4 rounded-card font-black text-sm border border-red-500/40 bg-red-500/10 hover:bg-red-500/20 text-red-400 transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              <span>{t.settings.resetButton}</span>
            </button>
          </div>

          </>}
        </div>

      </div>
    </div>
  );
};
