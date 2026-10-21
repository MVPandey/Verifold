import { Marked } from 'marked';
import { escapeHtml as e } from '../ui/dom.ts';

/**
 * Harness Markdown for the desk. Raw HTML stays visible as text, links keep
 * only http, https, and mailto targets, and images show only their text.
 * The desk page sanitizes the result again before it reaches the document.
 */
const marked = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) => e(text),
    image: ({ text }) => e(text),
    heading({ tokens, depth }) {
      // A desk section has its own h2, so Markdown headings start at h3.
      const level = Math.min(6, depth + 2);
      return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
    },
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      return /^(https?:|mailto:)/i.test(href)
        ? `<a href="${e(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : text;
    },
  },
});

export function markdownHtml(value: string): string {
  return marked.parse(value, { async: false });
}
