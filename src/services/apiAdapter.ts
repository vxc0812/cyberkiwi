import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { NewsItem, RssFeed } from '../types';
import { normalizeAudioUrl, normalizeFetchTarget } from '../utils/fetchTarget';
import { aiAuthHeaders } from '../utils/aiAuth';
import { apiFetch, getApiBaseUrl } from './apiClient';
import { nativeAiMode } from './aiPolicy';
import { getDefaultAiKeyStore } from './aiKeyStoreFactory';
import { configuredApiBaseUrl } from './cyberkiwiApi';

export { getApiBaseUrl };

export const isNativePlatform = (): boolean => {
  return Capacitor.isNativePlatform();
};

/** The configured API address for native builds, or null when none is set. */
function nativeApiBase(): string | null {
  return configuredApiBaseUrl(((import.meta as any).env ?? {}) as Record<string, unknown>, true);
}

// Client-side image extractor from XML / HTML
function extractImageFromXmlItem(itemXml: Element, defaultBaseUrl?: string): string | undefined {
  // 1. Check enclosure (RSS 2.0)
  const enclosures = Array.from(itemXml.querySelectorAll('enclosure'));
  for (const enc of enclosures) {
    const url = enc.getAttribute('url');
    const type = enc.getAttribute('type') || '';
    if (url && (type.includes('image') || /\.(jpg|jpeg|gif|png|webp|bmp|svg|avif)/i.test(url) || !type)) {
      return url.replace(/&amp;/g, '&').trim();
    }
  }

  // 2. Check media:content / media:thumbnail / media:group (Yahoo Media RSS)
  const mediaNodes = [
    ...Array.from(itemXml.getElementsByTagNameNS('http://search.yahoo.com/mrss/', 'content')),
    ...Array.from(itemXml.getElementsByTagNameNS('http://search.yahoo.com/mrss/', 'thumbnail')),
    ...Array.from(itemXml.querySelectorAll('media\\:content, media\\:thumbnail, content, thumbnail, [medium="image"]'))
  ];

  for (const node of mediaNodes) {
    const url = node.getAttribute('url') || node.getAttribute('href') || node.textContent?.trim();
    if (url && !url.includes('pixel') && !url.includes('1x1') && !url.startsWith('data:image')) {
      return url.replace(/&amp;/g, '&').trim();
    }
  }

  // 3. Check <image><url> or <thumbnail>
  const imgUrlNode = itemXml.querySelector('image > url, thumbnail > url, image, thumbnail, thumb');
  if (imgUrlNode && imgUrlNode.textContent) {
    const url = imgUrlNode.textContent.replace(/&amp;/g, '&').trim();
    if (url.startsWith('http') || url.startsWith('//')) return url;
  }

  // 4. Regex scan description / content:encoded / summary / content with HTML entity decoding
  const rawHtml = (
    (itemXml.querySelector('description')?.textContent || '') + ' ' +
    (itemXml.querySelector('content\\:encoded')?.textContent || '') + ' ' +
    (itemXml.querySelector('summary')?.textContent || '') + ' ' +
    (itemXml.querySelector('content')?.textContent || '')
  );

  const decodedHtml = rawHtml
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  const imgRegexes = [
    /<img[^>]+(?:data-src|data-original|data-lazy-src|data-hi-res-src)=["']([^"'\s>]+)["']/i,
    /<img[^>]+src=["']([^"'\s>]+)["']/i,
    /<img[^>]+srcset=["']([^"'\s,>]+)/i,
    /<source[^>]+srcset=["']([^"'\s,>]+)/i,
    /url\(["']?(https?:\/\/[^'"\)\s]+\.(?:jpg|jpeg|png|webp|avif|gif))["']?\)/i
  ];

  for (const rx of imgRegexes) {
    const match = decodedHtml.match(rx);
    if (match && match[1]) {
      let src = match[1].replace(/&amp;/g, '&').trim();
      if (!src.includes('pixel') && !src.includes('tracker') && !src.includes('1x1') && !src.startsWith('data:image')) {
        if (src.startsWith('//')) src = `https:${src}`;
        if (src.startsWith('/') && defaultBaseUrl) {
          try {
            src = new URL(src, defaultBaseUrl).toString();
          } catch {}
        }
        return src;
      }
    }
  }

  return undefined;
}

// Client-side RSS Parser for native Android direct fetching
async function parseRssClientSide(input: string): Promise<NewsItem[]> {
  // The device fetches this itself, so only public http(s) targets are allowed (report F22).
  const url = normalizeFetchTarget(input);
  if (!url) throw new Error('Feed URL refused: only public http(s) addresses can be fetched');
  let text = '';

  // 1. Tenta CapacitorHttp nativo primeiro no Android para bypass completo de CORS
  if (isNativePlatform()) {
    try {
      const res = await CapacitorHttp.get({
        url,
        headers: {
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 CyberKiwi/0.2.0',
        },
        connectTimeout: 10000,
        readTimeout: 15000,
      });
      if (typeof res.data === 'string') {
        text = res.data;
      } else if (res.data) {
        text = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);
      }
    } catch (httpErr) {
      console.warn('[CapacitorHttp failed, trying fetch fallback]:', httpErr);
    }
  }

  // 2. Fallback para fetch com timeout estendido de 10s
  if (!text) {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(10000),
    });
    text = await response.text();
  }

  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'text/xml');

  const channelTitle = xml.querySelector('channel > title')?.textContent?.trim() ||
    xml.querySelector('feed > title')?.textContent?.trim() ||
    new URL(url).hostname;

  const items = Array.from(xml.querySelectorAll('item, entry'));

  return items.map((item, idx) => {
    const title = item.querySelector('title')?.textContent?.trim() || 'Sem título';
    
    // Suporte aprimorado a links em RSS 2.0 e Atom feeds
    const linkElem = item.querySelector('link[rel="alternate"]') ||
      item.querySelector('link:not([rel])') ||
      item.querySelector('link');
    const link = linkElem?.getAttribute('href')?.trim() ||
      linkElem?.textContent?.trim() ||
      url;

    const rawSnippet = (item.querySelector('description')?.textContent ||
      item.querySelector('summary')?.textContent ||
      item.querySelector('content')?.textContent || '').replace(/<[^>]*>?/gm, '').trim();
    const cleanSnippet = rawSnippet.slice(0, 300) + (rawSnippet.length > 300 ? '...' : '');

    const pubDateStr = item.querySelector('pubDate')?.textContent ||
      item.querySelector('published')?.textContent ||
      item.querySelector('updated')?.textContent ||
      item.querySelector('dc\\:date')?.textContent;
    const timestamp = pubDateStr ? new Date(pubDateStr).getTime() : Date.now();
    
    // Suporte a identificador único (guid em RSS e id em Atom)
    const guid = item.querySelector('guid')?.textContent?.trim() ||
      item.querySelector('id')?.textContent?.trim() ||
      link;
    const imageUrl = extractImageFromXmlItem(item, url);
    const enclosure = item.querySelector('enclosure[type^="audio/"], link[rel="enclosure"][type^="audio/"]');
    const audioUrl = normalizeAudioUrl(enclosure?.getAttribute('url') ?? enclosure?.getAttribute('href'));

    // Simple sentiment analyzer
    const lower = `${title} ${cleanSnippet}`.toLowerCase();
    const pos = ['cresce', 'avanço', 'vitória', 'lucro', 'cura', 'alta', 'sucesso', 'inova', 'recorde'];
    const neg = ['queda', 'crise', 'morte', 'alerta', 'fraude', 'golpe', 'ameaça', 'guerra', 'prejuízo'];
    const pScore = pos.filter((w) => lower.includes(w)).length;
    const nScore = neg.filter((w) => lower.includes(w)).length;
    const sentiment = pScore > nScore ? 'positive' : nScore > pScore ? 'negative' : 'neutral';

    return {
      id: `${guid}-${idx}`,
      title,
      link,
      contentSnippet: cleanSnippet,
      pubDate: pubDateStr || new Date().toLocaleString('pt-BR'),
      timestamp: isNaN(timestamp) ? Date.now() : timestamp,
      sourceName: channelTitle,
      sourceId: url,
      sourceCategory: 'custom',
      imageUrl,
      audioUrl: audioUrl ?? undefined,
      sentiment,
      isBreaking: /urgente|bomba|breaking|alerta/i.test(title),
    };
  });
}

// 1. Fetch RSS Feeds
export async function fetchRssFeeds(urls: string[]): Promise<{ success: boolean; items: NewsItem[] }> {
  if (urls.length === 0) return { success: true, items: [] };

  // On Native Mobile, fetch and parse directly
  if (isNativePlatform()) {
    try {
      const results = await Promise.allSettled(urls.map((u) => parseRssClientSide(u)));
      const allItems: NewsItem[] = [];
      for (const res of results) {
        if (res.status === 'fulfilled') {
          allItems.push(...res.value);
        }
      }
      // Sort newest first
      allItems.sort((a, b) => b.timestamp - a.timestamp);
      return { success: true, items: allItems };
    } catch (err: any) {
      console.error('[Native RSS Fetch Error]:', err);
      return { success: false, items: [] };
    }
  }

  // On Desktop / Web, use local Express server
  const apiBase = getApiBaseUrl();
  // POST keeps subscription URLs (which can contain tokens) out of request logs (report F49).
  const res = await fetch(`${apiBase}/api/rss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: urls.join(',') }),
  });
  return await res.json();
}

// 2. Validate RSS Feed
export async function validateRssFeed(url: string): Promise<{ success: boolean; title?: string; error?: string }> {
  if (isNativePlatform()) {
    try {
      const items = await parseRssClientSide(url);
      return {
        success: true,
        title: items[0]?.sourceName || new URL(url).hostname,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  const apiBase = getApiBaseUrl();
  const res = await fetch(`${apiBase}/api/rss/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return await res.json();
}

// AI availability (server-side key only). The API key never reaches the client.
export async function checkServerAiStatus(): Promise<{ valid: boolean; message: string }> {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/gemini/status`);
    const data = await res.json();
    if (data?.configured) {
      return { valid: true, message: 'IA disponível: chave configurada no servidor CyberKiwi.' };
    }
    return { valid: false, message: 'IA indisponível: o servidor CyberKiwi não tem chave Gemini configurada.' };
  } catch {
    return { valid: false, message: 'Não foi possível contatar o servidor CyberKiwi.' };
  }
}

async function readerAiResponse<T>(response: Response): Promise<T | { success: false; error: string }> {
  if (response.status === 401) {
    return { success: false, error: 'Sign in or add your Gemini key in Settings to use AI.' };
  }
  const result = await response.json() as T & { error?: string };
  if (response.status === 503 && result.error === 'AI features are not enabled on this server') {
    return { success: false, error: 'This server has no Gemini key configured. Add your own under Settings → Gemini API Key.' };
  }
  return result;
}

// 3. AI Summarize Block
export async function summarizeBlockWithAi(
  items: NewsItem[],
  topic?: string,
  isMultiSourceStory?: boolean
): Promise<{ success: boolean; summary?: string; error?: string }> {
  const keyStore = await getDefaultAiKeyStore();
  const hasUserKey = Boolean(await keyStore.get());
  if (isNativePlatform() && nativeAiMode({ hasUserKey, apiBase: nativeApiBase() }) === 'fallback') {
    // Local digest for native builds without the user's key or without an API address
    const digest = [
      `📌 **Síntese Editorial (${items.length} manchetes):**`,
      ...items.slice(0, 4).map((i) => `• **${i.sourceName}**: ${i.title}`),
      `\n💡 *Insira sua chave gratuita da Google Gemini em Configurações para resumos analíticos avançados.*`,
    ].join('\n');
    return { success: true, summary: digest };
  }

  try {
    const res = await apiFetch('/api/gemini/summarize', {
      method: 'POST',
      headers: await aiAuthHeaders(keyStore),
      body: JSON.stringify({
        items: items.slice(0, 10).map(({ title, sourceName, contentSnippet }) => ({
          title: title.slice(0, 300),
          sourceName: sourceName.slice(0, 100),
          contentSnippet: contentSnippet.slice(0, 600),
        })),
        topic,
        isMultiSourceStory,
      }),
    });
    return await readerAiResponse<{ success: boolean; summary?: string; error?: string }>(res);
  } catch (err: any) {
    return { success: false, error: err.message || 'Falha ao conectar com o servidor.' };
  }
}

// 4. AI Curate Block
export async function curateBlockWithAi(userPrompt: string): Promise<{ success: boolean; blockConfig?: any; error?: string }> {
  const keyStore = await getDefaultAiKeyStore();
  const hasUserKey = Boolean(await keyStore.get());
  if (isNativePlatform() && nativeAiMode({ hasUserKey, apiBase: nativeApiBase() }) === 'fallback') {
    const lower = userPrompt.toLowerCase();
    let categoryFilter = 'all';
    if (/ia|inteligencia artificial|ai|machine learning|gpt|gemini|deep learning/i.test(lower)) categoryFilter = 'ai';
    else if (/tech|tecnologia|software|programação|apple|google|gadget/i.test(lower)) categoryFilter = 'tech';
    else if (/brasil|política|governo|stf|nacional/i.test(lower)) categoryFilter = 'brazil';
    else if (/mercado|economia|dolar|bolsa|ações|invest|cripto|bitcoin/i.test(lower)) categoryFilter = 'finance';
    else if (/esporte|futebol|f1|basquete|jogos/i.test(lower)) categoryFilter = 'sports';
    else if (/cinema|filme|música|cultura|série/i.test(lower)) categoryFilter = 'entertainment';

    return {
      success: true,
      blockConfig: {
        title: `🤖 ${userPrompt.slice(0, 28)}`,
        categoryFilter,
        filterKeyword: userPrompt,
        layout: 'grid',
        itemCount: 6,
      },
    };
  }

  try {
    const res = await apiFetch('/api/gemini/curate', {
      method: 'POST',
      headers: await aiAuthHeaders(keyStore),
      body: JSON.stringify({ userPrompt }),
    });
    return await res.json();
  } catch (err: any) {
    return { success: false, error: err.message || 'Falha ao conectar com o servidor.' };
  }
}

// 5. AI Translate Text
export async function translateWithAi(title: string, content: string): Promise<{ success: boolean; translation?: string; error?: string }> {
  const keyStore = await getDefaultAiKeyStore();
  const hasUserKey = Boolean(await keyStore.get());
  if (isNativePlatform() && nativeAiMode({ hasUserKey, apiBase: nativeApiBase() }) === 'fallback') {
    return {
      success: false,
      error: 'Add your Gemini key in Settings to translate on this device.',
    };
  }

  try {
    const res = await apiFetch('/api/gemini/translate', {
      method: 'POST',
      headers: await aiAuthHeaders(keyStore),
      body: JSON.stringify({ title, content }),
    });
    return await readerAiResponse<{ success: boolean; translation?: string; error?: string }>(res);
  } catch (err: any) {
    return { success: false, error: err.message || 'Falha ao conectar com o servidor.' };
  }
}
