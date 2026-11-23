/**
 * Gemini proxy routes: summarize, curate and translate. Mounted in server.ts behind requireAiAccess
 * and requireAiQuota. Every input is type-checked and length-bounded, and every piece of feed, article
 * or user text is wrapped in <untrusted> delimiters before it reaches the model.
 */
import type { Request, Response } from 'express';
import { AI_LIMITS, UNTRUSTED_NOTICE, boundedText, untrusted } from './aiGuard';

const MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite';

type GenerateFn = (args: { model: string; contents: string; config?: Record<string, unknown> }) => Promise<{ text?: string }>;

/** Builds the summarize prompt from validated items. Exported for tests. */
export function buildSummaryPrompt(input: {
  items: { sourceName: string; title: string; snippet: string }[];
  topic: string;
  isMultiSourceStory: boolean;
}): string {
  const sourcesText = input.items
    .map((it, idx) =>
      `Source ${idx + 1}:\n${untrusted('source name', it.sourceName)}\n${untrusted('headline', it.title)}\n${untrusted('excerpt', it.snippet)}`,
    )
    .join('\n\n');

  if (input.isMultiSourceStory && input.items.length > 1) {
    return `You are a senior investigative and executive editor.
${UNTRUSTED_NOTICE}
${input.items.length} sources cover the SAME EVENT (topic: ${untrusted('topic', input.topic || 'Consolidated Story')}):

${sourcesText}

Generate a consolidated journalistic briefing in English containing:
1. **Consolidated Summary**: Direct, objective synthesis of central facts confirmed by sources (2-3 sentences).
2. **Shared Facts**: Common points agreed across coverages.
3. **Source-Specific Nuances**: Highlights, data, or statements from specific sources (name the outlets).
4. **CyberKiwi Verdict**: Neutral, conclusive assessment of impact.

IMPORTANT: Limit yourself to facts cited above. Do not invent information.`;
  }

  return `You are a senior executive journalism editor.
${UNTRUSTED_NOTICE}
Analyze headlines for topic ${untrusted('topic', input.topic || 'General')} and generate a briefing in English containing:
1. Executive summary (2-3 sentences) highlighting key points.
2. 3-5 bullet points with most relevant trends/events.
3. Final "CyberKiwi Verdict" line.

Headlines:
${sourcesText}`;
}

/** Builds the curate prompt. The user's request is data, not instructions to the model. */
export function buildCuratePrompt(userPrompt: string): string {
  return `Create a Dynamic News Block configuration for the request in the untrusted block below.
${UNTRUSTED_NOTICE}
${untrusted('user request', userPrompt)}

Return ONLY valid JSON:
{
  "title": "Creative title with emoji",
  "filterKeyword": "keywords separated by |",
  "categoryFilter": "vulnerabilities|vendor-advisories|threat-intel|exploits|malware|news|cloud|iot|appsec|devsecops|privacy|crypto|cert|bugbounty|podcasts|custom",
  "layout": "hero|grid|compact|list|media-wall|ticker",
  "itemCount": 6,
  "explanation": "Brief reason for this structure"
}`;
}

/** Builds the translate prompt. */
export function buildTranslatePrompt(title: string, content: string): string {
  return `Translate the title and content in the untrusted blocks below to Brazilian Portuguese naturally.
${UNTRUSTED_NOTICE}
${untrusted('title', title)}
${untrusted('content', content)}`;
}

interface SummaryItemInput { sourceName: unknown; title: unknown; contentSnippet?: unknown }

/** Validates summarize input and returns bounded items. Items with no usable title are dropped. */
export function validateSummaryItems(raw: unknown): { items: { sourceName: string; title: string; snippet: string }[] } | null {
  if (!Array.isArray(raw)) return null;
  const items: { sourceName: string; title: string; snippet: string }[] = [];
  for (const entry of raw.slice(0, AI_LIMITS.summaryItems)) {
    if (!entry || typeof entry !== 'object') continue;
    const it = entry as SummaryItemInput;
    const title = boundedText(it.title, AI_LIMITS.title);
    if (!title) continue;
    items.push({
      sourceName: boundedText(it.sourceName, AI_LIMITS.sourceName) ?? '',
      title,
      snippet: boundedText(it.contentSnippet ?? '', AI_LIMITS.snippet) ?? '',
    });
  }
  return items.length > 0 ? { items } : null;
}

/** Summarize handler. Returns the HTTP status and body; the caller sends them. */
export async function handleSummarize(body: any, generate: GenerateFn): Promise<{ status: number; json: unknown }> {
  const validated = validateSummaryItems(body?.items);
  if (!validated) return { status: 400, json: { success: false, error: 'Invalid news items' } };
  const topic = boundedText(body?.topic ?? '', AI_LIMITS.topic);
  if (topic === null) return { status: 400, json: { success: false, error: 'Invalid topic' } };

  const prompt = buildSummaryPrompt({
    items: validated.items,
    topic,
    isMultiSourceStory: body?.isMultiSourceStory === true,
  });
  const response = await generate({ model: MODEL, contents: prompt });
  return { status: 200, json: { success: true, summary: response.text ?? '' } };
}

/** Curate handler. */
export async function handleCurate(body: any, generate: GenerateFn): Promise<{ status: number; json: unknown }> {
  const userPrompt = boundedText(body?.userPrompt, AI_LIMITS.userPrompt);
  if (!userPrompt) return { status: 400, json: { success: false, error: 'Prompt required' } };
  const response = await generate({ model: MODEL, contents: buildCuratePrompt(userPrompt), config: { responseMimeType: 'application/json' } });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text || '{}');
  } catch {
    return { status: 502, json: { success: false, error: 'Model returned invalid JSON' } };
  }
  return { status: 200, json: { success: true, blockConfig: parsed } };
}

/** Translate handler. */
export async function handleTranslate(body: any, generate: GenerateFn): Promise<{ status: number; json: unknown }> {
  const title = boundedText(body?.title, AI_LIMITS.translateTitle);
  const content = boundedText(body?.content ?? '', AI_LIMITS.translateContent);
  if (title === null || content === null) return { status: 400, json: { success: false, error: 'Invalid title or content' } };
  const response = await generate({ model: MODEL, contents: buildTranslatePrompt(title, content) });
  return { status: 200, json: { success: true, translation: response.text ?? '' } };
}

/**
 * Checks a Gemini key with one minimal generateContent call. The result is generic: the upstream
 * message is never returned, because it can echo parts of the request.
 */
export async function handleValidateKey(generate: GenerateFn): Promise<{ status: number; json: unknown }> {
  try {
    await generate({ model: MODEL, contents: 'Reply with OK.', config: { maxOutputTokens: 4 } });
    return { status: 200, json: { valid: true, model: MODEL } };
  } catch (err: any) {
    const status = Number(err?.status ?? err?.code);
    const text = String(err?.message ?? '');
    if (status === 429) return { status: 200, json: { valid: false, error: 'rate_limited' } };
    if (status === 400 || status === 401 || status === 403 || /api key|API_KEY|permission/i.test(text)) {
      return { status: 200, json: { valid: false, error: 'invalid_key' } };
    }
    return { status: 200, json: { valid: false, error: 'unavailable' } };
  }
}

/**
 * Adapts the handlers to Express. The model client comes from the caller (BYOK key or platform key).
 * Errors are logged server-side without the request, and a generic message is returned.
 */
export function asRoute(
  handler: (body: any, generate: GenerateFn) => Promise<{ status: number; json: unknown }>,
  getGenerate: (res: Response) => GenerateFn,
  label: string
) {
  return async (req: Request, res: Response) => {
    try {
      const out = await handler(req.body, getGenerate(res));
      res.status(out.status).json(out.json);
    } catch (err: any) {
      console.error(`[Gemini ${label} Error]:`, err?.message);
      res.status(500).json({ success: false, error: `Failed to ${label}` });
    }
  };
}
