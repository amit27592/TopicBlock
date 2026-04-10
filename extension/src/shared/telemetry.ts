/**
 * Browser-side telemetry ring buffer.
 *
 * Each entry captures one pipeline stage for one segment. Stages are named
 * with a 'browser.' prefix so they are unambiguous in combined browser+native
 * exports.
 *
 * The buffer lives in the background service worker's module scope. The
 * options page fetches it via the 'get_telemetry' background message.
 *
 * Usage:
 *   // Time a single segment:
 *   const verdict = await measure('browser.classify_roundtrip', seg.id, () =>
 *     nativeClient.classify(req)
 *   );
 *
 *   // Time a batch (records one entry per segment with the shared latency):
 *   const res = await measureBatch('browser.classify_roundtrip', segIds,
 *     () => nativeClient.classify(req),
 *     (r) => new Map(r.verdicts.map(v => [v.segmentId, v]))
 *   );
 */

import type { Verdict } from './protocols.js';

export interface TelemetryEntry {
  ts: number;        // Date.now() at entry recording (wall clock ms)
  stage: string;     // e.g. 'browser.classify_roundtrip'
  segmentId: string;
  latencyMs: number; // high-resolution duration from performance.now()
  source: 'browser';
  verdict?: Verdict;
  text?: string;     // segment body text for debugging
}

const DEFAULT_MAX = 500;
let _maxSize = DEFAULT_MAX;
const _buffer: TelemetryEntry[] = [];

export function configure(opts: { maxSize: number }): void {
  _maxSize = opts.maxSize;
  // Trim if newly smaller
  if (_buffer.length > _maxSize) _buffer.splice(0, _buffer.length - _maxSize);
}

export function record(entry: TelemetryEntry): void {
  _buffer.push(entry);
  if (_buffer.length > _maxSize) _buffer.splice(0, _buffer.length - _maxSize);
}

/**
 * Time `fn` and record one entry for `segmentId`.
 * `extractVerdict` is called with the result to optionally attach a verdict.
 */
export async function measure<T>(
  stage: string,
  segmentId: string,
  fn: () => T | Promise<T>,
  extractVerdict?: (result: T) => Verdict | undefined,
): Promise<T> {
  const t0 = performance.now();
  const result = await fn();
  const latencyMs = performance.now() - t0;
  const entry: TelemetryEntry = { ts: Date.now(), stage, segmentId, latencyMs, source: 'browser' };
  const v = extractVerdict?.(result);
  if (v != null) entry.verdict = v;
  record(entry);
  return result;
}

/**
 * Time `fn` and record one entry per `segmentId` — all sharing the same
 * measured latency (the batch ran as a unit).
 * `extractVerdicts` maps the result to a segmentId → Verdict map.
 */
export async function measureBatch<T>(
  stage: string,
  segmentIds: string[],
  fn: () => T | Promise<T>,
  extractVerdicts?: (result: T) => Map<string, Verdict>,
  textMap?: Map<string, string>,
): Promise<T> {
  const t0 = performance.now();
  const result = await fn();
  const latencyMs = performance.now() - t0;
  const verdictMap = extractVerdicts?.(result);
  const ts = Date.now();
  for (const segmentId of segmentIds) {
    const entry: TelemetryEntry = { ts, stage, segmentId, latencyMs, source: 'browser' };
    const v = verdictMap?.get(segmentId);
    if (v != null) entry.verdict = v;
    const t = textMap?.get(segmentId);
    if (t != null) entry.text = t;
    record(entry);
  }
  return result;
}

/** Return a snapshot of the current buffer, newest first. */
export function getAll(): TelemetryEntry[] {
  return [..._buffer].reverse();
}

export function clear(): void {
  _buffer.length = 0;
}

export function size(): number {
  return _buffer.length;
}

export function maxSize(): number {
  return _maxSize;
}
