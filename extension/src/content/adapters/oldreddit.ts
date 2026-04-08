/**
 * Site adapter for Old Reddit (old.reddit.com).
 *
 * Each post is a <div class="thing link" id="thing_t3_<id>">. Promoted posts
 * carry the `promoted` class and are excluded.
 *
 * Segment content:
 *   headline = post title text (from a.title)
 *   subtitle = subreddit name  (from a.subreddit)
 *   body     = headline (plain text)
 *   extractionHint = 'plain_text'
 *
 * domPath is stable via the element's HTML id attribute (e.g. "thing_t3_abc").
 */

import type { ContentSegment, ISiteAdapter } from '../../shared/protocols.js';

export class OldRedditAdapter implements ISiteAdapter {
  readonly siteId = 'oldreddit';

  matches(url: string): boolean {
    try {
      return new URL(url).hostname === 'old.reddit.com';
    } catch {
      return false;
    }
  }

  findSegments(root: ParentNode): HTMLElement[] {
    return Array.from(
      root.querySelectorAll<HTMLElement>('div.thing.link:not(.promoted)'),
    );
  }

  extract(el: HTMLElement): Omit<ContentSegment, 'id' | 'element' | 'meta'> {
    const titleEl = el.querySelector<HTMLAnchorElement>('a.title');
    const subredditEl = el.querySelector<HTMLAnchorElement>('a.subreddit');
    const headline = titleEl?.textContent?.trim() ?? '';
    const subtitle = subredditEl?.textContent?.trim() ?? '';
    return {
      headline,
      subtitle,
      body: headline,
      extractionHint: 'plain_text',
    };
  }

  observeTargets(): Node[] {
    // #siteTable is the container for all post listings
    const feed = document.querySelector<HTMLElement>('#siteTable');
    return feed != null ? [feed] : [document.body];
  }
}
