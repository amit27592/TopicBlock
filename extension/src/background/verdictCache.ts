/**
 * In-memory verdict cache for the background service worker.
 *
 * Cache key: `${segmentId}:${prefsVersion}`
 * A prefsVersion bump (triggered by any preference change, including model
 * selection) automatically causes cache misses for all prior verdicts, so
 * stale results are never returned after the user changes settings.
 *
 * The cache lives in the service worker's module scope. It is cleared when
 * the service worker is killed (MV3 behaviour), which is acceptable — the
 * cache is a performance optimisation, not a source of truth.
 */

import type { Verdict } from '../shared/protocols.js';

/** Maximum number of verdicts held in memory before FIFO eviction kicks in. */
const MAX_SIZE = 5_000;

const cache = new Map<string, Verdict>();

function makeKey(segmentId: string, prefsVersion: number): string {
  return `${segmentId}:${prefsVersion}`;
}

/**
 * Return the cached verdict for a segment at the given preferences version,
 * or `undefined` on a cache miss.
 */
export function get(segmentId: string, prefsVersion: number): Verdict | undefined {
  return cache.get(makeKey(segmentId, prefsVersion));
}

/**
 * Store a verdict in the cache, evicting the oldest entry if the cache is full.
 */
export function set(verdict: Verdict, prefsVersion: number): void {
  const key = makeKey(verdict.segmentId, prefsVersion);
  if (cache.size >= MAX_SIZE) {
    // Map preserves insertion order; delete the first (oldest) entry.
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, verdict);
}

/** Clear all cached verdicts. */
export function clear(): void {
  cache.clear();
}

/** Number of verdicts currently in the cache. */
export function size(): number {
  return cache.size;
}
