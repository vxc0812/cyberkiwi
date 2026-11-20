/**
 * Server-side HTML sanitization for extracted article content.
 *
 * DOMPurify returns its input unchanged when it has no working DOM (`isSupported` is false). This
 * module binds DOMPurify to a real DOM through isomorphic-dompurify and fails closed: if the
 * sanitizer is unavailable, nothing is returned rather than unsanitized HTML.
 */
import DOMPurify from 'isomorphic-dompurify';

export const ARTICLE_ALLOWED_TAGS = [
  'div', 'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'strong', 'b', 'em', 'i',
  'u', 'a', 'img', 'figure', 'figcaption', 'code', 'pre', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'time',
];

export const ARTICLE_ALLOWED_ATTR = [
  'src', 'href', 'alt', 'title', 'target', 'rel', 'class', 'id', 'loading', 'datetime',
];

export class SanitizerUnavailableError extends Error {
  constructor() {
    super('HTML sanitizer is unavailable; refusing to return unsanitized content');
    this.name = 'SanitizerUnavailableError';
  }
}

/**
 * Sanitizes article HTML with the article allowlist. Throws SanitizerUnavailableError when DOMPurify
 * has no working DOM. Event-handler attributes, script and SVG-based payloads, and javascript: URLs
 * are removed by DOMPurify's default rules, which this function does not relax.
 */
export function sanitizeArticleHtml(html: string): string {
  if (!DOMPurify.isSupported) {
    throw new SanitizerUnavailableError();
  }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ARTICLE_ALLOWED_TAGS,
    ALLOWED_ATTR: ARTICLE_ALLOWED_ATTR,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}
