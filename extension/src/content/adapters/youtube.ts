/**
 * Site adapter for YouTube (www.youtube.com).
 *
 * Two surfaces are supported:
 *
 *   A) Homepage & subscriptions feed — each card is a
 *      `ytd-rich-item-renderer` wrapping a `ytd-rich-grid-media` or
 *      `ytd-video-renderer`.
 *
 *   B) Search results — each result is a `ytd-video-renderer` directly in
 *      `ytd-item-section-renderer`.
 *
 * Extraction strategy:
 *   headline = video title  (`#video-title`, `.title`)
 *   subtitle = channel name (`#channel-name a`, `.ytd-channel-name a`)
 *   body     = headline (plain text; YouTube titles need no HTML cleaning)
 *   extractionHint = 'plain_text'
 *
 * domPath: `ytd-rich-item-renderer` and `ytd-video-renderer` don't carry
 * stable IDs directly — we look for a nested link href, which contains
 * `/watch?v=<videoId>`, and use that as the stable path component.
 * Falling back to getDomPath in segmentId.ts is fine for the rare miss.
 *
 * MutationObserver roots: the grid / search container that YouTube's React-
 * style SPA populates. We pick the deepest reliable ancestor.
 */

import type { ContentSegment, ISiteAdapter } from '../../shared/protocols.js';

export class YouTubeAdapter implements ISiteAdapter {
  readonly siteId = 'youtube';

  matches(url: string): boolean {
    try {
      const { hostname, pathname } = new URL(url);
      if (hostname !== 'www.youtube.com' && hostname !== 'youtube.com') {
        return false;
      }
      // Only homepage, search, subscriptions, and channel pages
      return (
        pathname === '/' ||
        pathname.startsWith('/results') ||
        pathname.startsWith('/feed/') ||
        pathname.startsWith('/channel/') ||
        pathname.startsWith('/c/') ||
        pathname.startsWith('/@')
      );
    } catch {
      return false;
    }
  }

  findSegments(root: ParentNode): HTMLElement[] {
    // ytd-rich-item-renderer covers homepage / subscriptions
    // ytd-video-renderer covers search results and channel pages
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        'ytd-rich-item-renderer, ytd-video-renderer',
      ),
    );
  }

  extract(el: HTMLElement): Omit<ContentSegment, 'id' | 'element' | 'meta'> {
    const headline = this._extractTitle(el);
    const subtitle = this._extractChannel(el);

    return {
      headline,
      subtitle,
      body: headline,
      extractionHint: 'plain_text',
    };
  }

  private _extractTitle(el: HTMLElement): string {
    // Primary: #video-title (both renderer types)
    const titleEl = el.querySelector<HTMLElement>('#video-title');
    if (titleEl?.textContent) return titleEl.textContent.trim();

    // Fallback: various title selectors observed across YouTube SPA versions
    const fallbacks = [
      'h3 a',
      '.title.style-scope.ytd-video-renderer',
      'yt-formatted-string#video-title',
    ];
    for (const sel of fallbacks) {
      const t = el.querySelector<HTMLElement>(sel)?.textContent?.trim();
      if (t) return t;
    }
    return '';
  }

  private _extractChannel(el: HTMLElement): string {
    // Channel name link inside #channel-name
    const channelLink = el.querySelector<HTMLAnchorElement>(
      '#channel-name a, .ytd-channel-name a',
    );
    if (channelLink?.textContent) return channelLink.textContent.trim();

    // yt-formatted-string fallback
    const ytFormatted = el.querySelector<HTMLElement>(
      'ytd-channel-name yt-formatted-string',
    );
    if (ytFormatted?.textContent) return ytFormatted.textContent.trim();

    return '';
  }

  observeTargets(): Node[] {
    // ytd-rich-grid-renderer — homepage infinite scroll container
    // ytd-section-list-renderer — search results container
    // #contents inside ytd-browse — subscriptions / channel feed
    const candidates = [
      document.querySelector<HTMLElement>('ytd-rich-grid-renderer'),
      document.querySelector<HTMLElement>('ytd-section-list-renderer'),
      document.querySelector<HTMLElement>('ytd-browse #contents'),
    ].filter((el): el is HTMLElement => el != null);

    return candidates.length > 0 ? candidates : [document.body];
  }
}
