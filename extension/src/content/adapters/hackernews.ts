/**
 * Site adapter for Hacker News (news.ycombinator.com).
 *
 * Each story is a pair of <tr> elements:
 *   <tr class="athing" id="<itemId>">   ← title row  (this is the segment element)
 *   <tr><td class="subtext">...</td></tr> ← metadata row
 *
 * Segment content:
 *   headline = story title text
 *   subtitle = metadata row text (author, score, time, comment count)
 *   body     = headline (plain text; no HTML cleaning needed)
 *   extractionHint = 'plain_text'
 *
 * domPath is stable via the numeric item ID on the athing row.
 */

import type { ContentSegment, ISiteAdapter } from '../../shared/protocols.js';

export class HackerNewsAdapter implements ISiteAdapter {
  readonly siteId = 'hackernews';

  matches(url: string): boolean {
    try {
      return new URL(url).hostname === 'news.ycombinator.com';
    } catch {
      return false;
    }
  }

  findSegments(root: ParentNode): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>('tr.athing'));
  }

  extract(el: HTMLElement): Omit<ContentSegment, 'id' | 'element' | 'meta'> {
    const titleLink = el.querySelector<HTMLAnchorElement>('.titleline > a');
    const headline = titleLink?.textContent?.trim() ?? '';

    // Subtext row is the immediately following sibling <tr>
    const subtextEl = el.nextElementSibling?.querySelector<HTMLElement>('.subtext');
    const subtitle = subtextEl?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

    return {
      headline,
      subtitle,
      body: headline,
      extractionHint: 'plain_text',
    };
  }

  observeTargets(): Node[] {
    // itemlist is the <table> that wraps all story rows
    const table = document.querySelector<HTMLElement>('table.itemlist');
    return table != null ? [table] : [document.body];
  }
}
