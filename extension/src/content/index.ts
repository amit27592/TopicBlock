/**
 * TopicBlock content script — WP-4 pipeline.
 *
 * Pipeline:
 *  1. Select adapter for the current site.
 *  2. Initial scan: find all visible segments already in the DOM.
 *  3. SegmentObserver: pick up incremental additions (infinite scroll, SPA nav).
 *  4. Deduplicate by segment ID across the lifetime of the page.
 *  5. Coalesce pending segments into batches (≤32, flushed after 50 ms idle).
 *  6. Send a ClassifyRequest to the background service worker.
 *  7. On response, log verdicts. (Filter actions wired in WP-9.)
 *
 * Fail-open: if no adapter matches, or native client is unavailable, content
 * renders normally and no errors are surfaced to the user.
 */

import type { ClassifyRequest, ClassifyResponse, ContentSegment } from '../shared/protocols.js';
import { findAdapter } from './adapters/index.js';
import { SegmentObserver } from './segmentation/observer.js';
import { computeSegmentId, getDomPath } from './segmentation/segmentId.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const BATCH_MAX = 32;
const BATCH_WINDOW_MS = 50;
const RAW_HTML_CAP_BYTES = 30_000; // stay well under 1 MB Native Messaging cap

// ─── State ───────────────────────────────────────────────────────────────────

const seenIds = new Set<string>();
const pending: ContentSegment[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let prefsVersion = 0; // bumped by WP-2 preference changes

// ─── Adapter selection ────────────────────────────────────────────────────────

const adapter = findAdapter(window.location.href);
if (!adapter) {
  // Not a supported site — nothing to do.
  console.debug('[TopicBlock] No adapter for', window.location.href);
} else {
  console.log('[TopicBlock] adapter=' + adapter.siteId + ' initialising');
  init();
}

// ─── Initialisation ───────────────────────────────────────────────────────────

function init(): void {
  if (!adapter) return;

  // Initial scan
  const initialEls = adapter.findSegments(document);
  handleNewElements(initialEls);

  // Observe incremental additions
  const observer = new SegmentObserver(adapter, handleNewElements);
  observer.start();

  console.log(
    `[TopicBlock] adapter=${adapter.siteId} initial segments=${initialEls.length}`,
  );
}

// ─── Element handler ──────────────────────────────────────────────────────────

function handleNewElements(els: HTMLElement[]): void {
  if (!adapter) return;

  const url = window.location.href;
  const site = adapter.siteId;

  for (const el of els) {
    const domPath = getDomPath(el);
    const extracted = adapter.extract(el);
    const body = extracted.body ?? extracted.headline ?? '';

    // Compute segment ID async — enqueue once it resolves
    computeSegmentId(site, domPath, body).then((id) => {
      if (seenIds.has(id)) return;
      seenIds.add(id);

      let finalBody = body;
      // Cap raw_html segments before they hit the wire
      if (
        extracted.extractionHint === 'raw_html' &&
        el.outerHTML.length <= RAW_HTML_CAP_BYTES
      ) {
        finalBody = el.outerHTML;
      } else if (extracted.extractionHint === 'raw_html') {
        // Oversized: fall back to text content and downgrade hint
        finalBody = el.textContent?.trim() ?? body;
        extracted.extractionHint = 'plain_text';
      }

      // exactOptionalPropertyTypes: only spread optional fields when defined
      const segment: ContentSegment = {
        id,
        element: new WeakRef(el),
        ...(extracted.headline !== undefined && { headline: extracted.headline }),
        ...(extracted.subtitle !== undefined && { subtitle: extracted.subtitle }),
        body: finalBody,
        ...(extracted.extractionHint !== undefined && { extractionHint: extracted.extractionHint }),
        meta: { url, site, domPath },
      };

      pending.push(segment);
      scheduleBatch();
    });
  }
}

// ─── Batching ─────────────────────────────────────────────────────────────────

function scheduleBatch(): void {
  if (batchTimer !== null) return;
  if (pending.length >= BATCH_MAX) {
    // Flush immediately when at capacity
    flushBatch();
    return;
  }
  batchTimer = setTimeout(flushBatch, BATCH_WINDOW_MS);
}

function flushBatch(): void {
  batchTimer = null;
  if (pending.length === 0) return;

  // Drain up to BATCH_MAX segments
  const batch = pending.splice(0, BATCH_MAX);

  // If there are still items, schedule the next flush
  if (pending.length > 0) scheduleBatch();

  sendBatch(batch);
}

// ─── Wire ─────────────────────────────────────────────────────────────────────

function sendBatch(segments: ContentSegment[]): void {
  const requestId = crypto.randomUUID();

  const request: ClassifyRequest = {
    requestId,
    prefsVersion,
    segments: segments.map((s) => ({
      id: s.id,
      body: s.body ?? '',
      site: s.meta.site,
      ...(s.headline !== undefined && { headline: s.headline }),
      ...(s.subtitle !== undefined && { subtitle: s.subtitle }),
      ...(s.extractionHint !== undefined && { extractionHint: s.extractionHint }),
    })),
  };

  chrome.runtime.sendMessage(
    { type: 'classify', payload: request },
    (response: ClassifyResponse | undefined) => {
      if (chrome.runtime.lastError) {
        // Native client unavailable — fail open, no UI disruption
        console.debug(
          '[TopicBlock] classify failed (fail-open):',
          chrome.runtime.lastError.message,
        );
        return;
      }
      if (response) {
        handleVerdicts(response, segments);
      }
    },
  );
}

// ─── Verdict handling (WP-9 will attach IFilterAction here) ──────────────────

function handleVerdicts(
  response: ClassifyResponse,
  _segments: ContentSegment[],
): void {
  for (const verdict of response.verdicts) {
    if (verdict.blocked) {
      console.log(
        `[TopicBlock] blocked segment=${verdict.segmentId}`,
        verdict.reasons,
      );
    }
  }
  // WP-9: loop over verdict.blocked → look up segment by id → apply IFilterAction
}
