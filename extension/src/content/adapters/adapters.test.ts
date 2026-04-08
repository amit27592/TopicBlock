/**
 * Unit tests for all site adapters.
 *
 * Tests use JSDOM fixtures to simulate minimal page structures.
 * `matches()`, `findSegments()`, and `extract()` are exercised for all four adapters.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

import { HackerNewsAdapter } from './hackernews.js';
import { OldRedditAdapter } from './oldreddit.js';
import { RedditAdapter } from './reddit.js';
import { YouTubeAdapter } from './youtube.js';
import { ALL_ADAPTERS, findAdapter } from './index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDoc(html: string) {
  return new JSDOM(html).window.document;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

describe('findAdapter', () => {
  it('returns HackerNewsAdapter for news.ycombinator.com', () => {
    const a = findAdapter('https://news.ycombinator.com/');
    expect(a?.siteId).toBe('hackernews');
  });

  it('returns OldRedditAdapter for old.reddit.com', () => {
    const a = findAdapter('https://old.reddit.com/r/programming');
    expect(a?.siteId).toBe('oldreddit');
  });

  it('returns RedditAdapter for www.reddit.com', () => {
    const a = findAdapter('https://www.reddit.com/r/programming');
    expect(a?.siteId).toBe('reddit');
  });

  it('returns YouTubeAdapter for www.youtube.com', () => {
    const a = findAdapter('https://www.youtube.com/');
    expect(a?.siteId).toBe('youtube');
  });

  it('returns null for unsupported sites', () => {
    expect(findAdapter('https://example.com/')).toBeNull();
    expect(findAdapter('https://twitter.com/')).toBeNull();
  });

  it('exports 4 adapters total', () => {
    expect(ALL_ADAPTERS).toHaveLength(4);
  });
});

// ─── HackerNewsAdapter ────────────────────────────────────────────────────────

describe('HackerNewsAdapter', () => {
  const adapter = new HackerNewsAdapter();

  it('matches news.ycombinator.com', () => {
    expect(adapter.matches('https://news.ycombinator.com/')).toBe(true);
    expect(adapter.matches('https://news.ycombinator.com/item?id=42')).toBe(true);
    expect(adapter.matches('https://www.reddit.com/')).toBe(false);
  });

  const fixture = `
    <html><body>
      <table class="itemlist">
        <tr class="athing" id="42069420">
          <td class="title">
            <span class="titleline"><a href="https://example.com">My HN Post</a></span>
          </td>
        </tr>
        <tr>
          <td class="subtext">
            <span class="score">100 points</span> by <a class="hnuser">user1</a>
            | 50 comments
          </td>
        </tr>
      </table>
    </body></html>
  `;

  it('findSegments returns athing rows', () => {
    const doc = parseDoc(fixture);
    const segs = adapter.findSegments(doc);
    expect(segs).toHaveLength(1);
    expect(segs[0]?.id).toBe('42069420');
  });

  it('extract returns correct headline and body', () => {
    const doc = parseDoc(fixture);
    const el = doc.querySelector<HTMLElement>('tr.athing')!;
    const result = adapter.extract(el);
    expect(result.headline).toBe('My HN Post');
    expect(result.body).toBe('My HN Post');
    expect(result.extractionHint).toBe('plain_text');
  });

  it('extract fills subtitle from .subtext sibling row', () => {
    const doc = parseDoc(fixture);
    const el = doc.querySelector<HTMLElement>('tr.athing')!;
    const result = adapter.extract(el);
    expect(result.subtitle).toMatch(/points/);
  });
});

// ─── OldRedditAdapter ─────────────────────────────────────────────────────────

describe('OldRedditAdapter', () => {
  const adapter = new OldRedditAdapter();

  it('matches old.reddit.com only', () => {
    expect(adapter.matches('https://old.reddit.com/r/news')).toBe(true);
    expect(adapter.matches('https://www.reddit.com/r/news')).toBe(false);
  });

  const fixture = `
    <html><body>
      <div id="siteTable">
        <div class="thing link" id="thing_t3_abc123" data-fullname="t3_abc123">
          <a class="title" href="/r/news/comments/abc123/post">The headline</a>
          <a class="subreddit" href="/r/news">r/news</a>
        </div>
        <div class="thing link promoted" id="thing_t3_promo">
          <a class="title">Promoted Post</a>
        </div>
      </div>
    </body></html>
  `;

  it('findSegments excludes promoted posts', () => {
    const doc = parseDoc(fixture);
    const segs = adapter.findSegments(doc);
    expect(segs).toHaveLength(1);
    expect(segs[0]?.id).toBe('thing_t3_abc123');
  });

  it('extract returns headline, subtitle, body', () => {
    const doc = parseDoc(fixture);
    const el = doc.querySelector<HTMLElement>('.thing.link:not(.promoted)')!;
    const result = adapter.extract(el);
    expect(result.headline).toBe('The headline');
    expect(result.subtitle).toBe('r/news');
    expect(result.body).toBe('The headline');
    expect(result.extractionHint).toBe('plain_text');
  });
});

// ─── RedditAdapter ────────────────────────────────────────────────────────────

describe('RedditAdapter', () => {
  const adapter = new RedditAdapter();

  it('matches www.reddit.com but not old.reddit.com', () => {
    expect(adapter.matches('https://www.reddit.com/r/news')).toBe(true);
    expect(adapter.matches('https://reddit.com/r/news')).toBe(true);
    expect(adapter.matches('https://old.reddit.com/r/news')).toBe(false);
  });

  describe('shreddit-post extraction', () => {
    const fixture = `
      <html><body>
        <shreddit-post
          post-title="Shreddit Post Title"
          subreddit-prefixed-name="r/technology"
          id="t3_shreddit1"
        ></shreddit-post>
      </body></html>
    `;

    it('findSegments finds shreddit-post elements', () => {
      const doc = parseDoc(fixture);
      const segs = adapter.findSegments(doc);
      expect(segs).toHaveLength(1);
    });

    it('extract reads post-title attribute', () => {
      const doc = parseDoc(fixture);
      const el = doc.querySelector<HTMLElement>('shreddit-post')!;
      const result = adapter.extract(el);
      expect(result.headline).toBe('Shreddit Post Title');
      expect(result.subtitle).toBe('r/technology');
      expect(result.extractionHint).toBe('raw_html');
    });
  });

  describe('redesign post-container extraction', () => {
    const fixture = `
      <html><body>
        <div data-testid="post-container">
          <div data-click-id="text"><h3>Redesign Title</h3></div>
          <a data-click-id="subreddit">r/science</a>
        </div>
      </body></html>
    `;

    it('findSegments finds data-testid post-container', () => {
      const doc = parseDoc(fixture);
      const segs = adapter.findSegments(doc);
      expect(segs).toHaveLength(1);
    });

    it('extract reads h3 headline and subreddit link', () => {
      const doc = parseDoc(fixture);
      const el = doc.querySelector<HTMLElement>('[data-testid="post-container"]')!;
      const result = adapter.extract(el);
      expect(result.headline).toBe('Redesign Title');
      expect(result.subtitle).toBe('r/science');
      expect(result.extractionHint).toBe('raw_html');
    });
  });
});

// ─── YouTubeAdapter ───────────────────────────────────────────────────────────

describe('YouTubeAdapter', () => {
  const adapter = new YouTubeAdapter();

  it('matches youtube.com homepage and search', () => {
    expect(adapter.matches('https://www.youtube.com/')).toBe(true);
    expect(adapter.matches('https://www.youtube.com/results?search_query=ai')).toBe(true);
    expect(adapter.matches('https://www.youtube.com/@someChannel')).toBe(true);
    expect(adapter.matches('https://www.youtube.com/watch?v=abc')).toBe(false); // watch pages excluded
    expect(adapter.matches('https://www.reddit.com/')).toBe(false);
  });

  describe('rich-item-renderer (homepage)', () => {
    const fixture = `
      <html><body>
        <ytd-rich-grid-renderer>
          <ytd-rich-item-renderer>
            <a id="video-title">My Video Title</a>
            <div id="channel-name">
              <a href="/c/mychannel">My Channel</a>
            </div>
          </ytd-rich-item-renderer>
        </ytd-rich-grid-renderer>
      </body></html>
    `;

    it('findSegments finds ytd-rich-item-renderer', () => {
      const doc = parseDoc(fixture);
      const segs = adapter.findSegments(doc);
      expect(segs).toHaveLength(1);
    });

    it('extract reads title and channel', () => {
      const doc = parseDoc(fixture);
      const el = doc.querySelector<HTMLElement>('ytd-rich-item-renderer')!;
      const result = adapter.extract(el);
      expect(result.headline).toBe('My Video Title');
      expect(result.subtitle).toBe('My Channel');
      expect(result.extractionHint).toBe('plain_text');
    });
  });

  describe('video-renderer (search)', () => {
    const fixture = `
      <html><body>
        <ytd-section-list-renderer>
          <ytd-video-renderer>
            <a id="video-title">Search Result Video</a>
            <ytd-channel-name>
              <yt-formatted-string>Tech Channel</yt-formatted-string>
            </ytd-channel-name>
          </ytd-video-renderer>
        </ytd-section-list-renderer>
      </body></html>
    `;

    it('findSegments finds ytd-video-renderer', () => {
      const doc = parseDoc(fixture);
      const segs = adapter.findSegments(doc);
      expect(segs).toHaveLength(1);
    });

    it('extract reads title and falls back to yt-formatted-string for channel', () => {
      const doc = parseDoc(fixture);
      const el = doc.querySelector<HTMLElement>('ytd-video-renderer')!;
      const result = adapter.extract(el);
      expect(result.headline).toBe('Search Result Video');
      expect(result.subtitle).toBe('Tech Channel');
    });
  });
});
