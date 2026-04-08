/**
 * Site adapter for New Reddit (www.reddit.com).
 *
 * New Reddit uses web components. Two eras are supported:
 *
 *   A) shreddit-post  (2023+ redesign using Lit/custom elements)
 *      Post title, subreddit, and author are available as HTML attributes,
 *      which makes extraction cheap and avoids Shadow DOM access.
 *
 *   B) div[data-testid="post-container"]  (2018–2022 redesign fallback)
 *      Title lives in a nested h3; subreddit in a data-click-id link.
 *
 * extractionHint = 'raw_html' so the native component can apply Readability-
 * style cleaning when richer text is needed (e.g. self-post body).
 * outerHTML is capped by the pipeline to 30 KB before sending to native.
 *
 * domPath: shreddit-post carries `id="t3_<postId>"` — stable.
 */

import type { ContentSegment, ISiteAdapter } from '../../shared/protocols.js';

export class RedditAdapter implements ISiteAdapter {
  readonly siteId = 'reddit';

  matches(url: string): boolean {
    try {
      const { hostname } = new URL(url);
      // Exclude old.reddit.com — handled by OldRedditAdapter
      return hostname === 'www.reddit.com' || hostname === 'reddit.com';
    } catch {
      return false;
    }
  }

  findSegments(root: ParentNode): HTMLElement[] {
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        'shreddit-post, div[data-testid="post-container"]',
      ),
    );
  }

  extract(el: HTMLElement): Omit<ContentSegment, 'id' | 'element' | 'meta'> {
    if (el.tagName.toLowerCase() === 'shreddit-post') {
      return this._extractShreddit(el);
    }
    return this._extractRedesign(el);
  }

  private _extractShreddit(el: HTMLElement): Omit<ContentSegment, 'id' | 'element' | 'meta'> {
    // shreddit-post exposes attributes before Shadow DOM renders
    const headline =
      el.getAttribute('post-title') ??
      el.querySelector<HTMLElement>('[slot="title"]')?.textContent?.trim() ??
      '';
    const subtitle = el.getAttribute('subreddit-prefixed-name') ?? '';
    return {
      headline,
      subtitle,
      body: headline,
      extractionHint: 'raw_html',
    };
  }

  private _extractRedesign(el: HTMLElement): Omit<ContentSegment, 'id' | 'element' | 'meta'> {
    const titleEl = el.querySelector<HTMLElement>(
      '[data-click-id="text"] h3, h3, h1',
    );
    const headline = titleEl?.textContent?.trim() ?? '';
    const subredditEl = el.querySelector<HTMLAnchorElement>(
      'a[data-click-id="subreddit"]',
    );
    const subtitle = subredditEl?.textContent?.trim() ?? '';
    return {
      headline,
      subtitle,
      body: headline,
      extractionHint: 'raw_html',
    };
  }

  observeTargets(): Node[] {
    const feed = document.querySelector<HTMLElement>(
      'shreddit-feed, div[data-testid="posts-feed"], #main-content',
    );
    return feed != null ? [feed] : [document.body];
  }
}
