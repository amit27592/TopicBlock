/**
 * Adapter registry — single place to import and look up all site adapters.
 *
 * Adapters are tested in order; the first match wins.  OldRedditAdapter must
 * precede RedditAdapter because old.reddit.com also satisfies the reddit.com
 * hostname check (it doesn't, but ordering defensively is cheap).
 */

import type { ISiteAdapter } from '../../shared/protocols.js';
import { HackerNewsAdapter } from './hackernews.js';
import { OldRedditAdapter } from './oldreddit.js';
import { RedditAdapter } from './reddit.js';
import { YouTubeAdapter } from './youtube.js';

export const ALL_ADAPTERS: ISiteAdapter[] = [
  new HackerNewsAdapter(),
  new OldRedditAdapter(), // must precede RedditAdapter
  new RedditAdapter(),
  new YouTubeAdapter(),
];

/**
 * Return the first adapter whose `matches()` returns true for the given URL,
 * or null if no adapter supports the site.
 */
export function findAdapter(url: string): ISiteAdapter | null {
  return ALL_ADAPTERS.find((a) => a.matches(url)) ?? null;
}
