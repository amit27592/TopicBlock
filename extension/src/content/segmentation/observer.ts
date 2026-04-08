/**
 * MutationObserver wrapper for content segmentation.
 *
 * Watches the adapter's target nodes for DOM mutations, debounces via
 * requestIdleCallback (150 ms hard deadline), and forwards newly-added
 * candidate elements to the caller.
 *
 * Deduplication (by segment ID) is the caller's responsibility — this module
 * only de-duplicates at the HTMLElement level within a single flush.
 */

import type { ISiteAdapter } from '../../shared/protocols.js';

const IDLE_TIMEOUT_MS = 150;

export class SegmentObserver {
  private readonly mutationObserver: MutationObserver;
  private readonly pendingRoots = new Set<ParentNode>();
  private idleCallbackId: number | null = null;

  constructor(
    private readonly adapter: ISiteAdapter,
    private readonly onNewElements: (els: HTMLElement[]) => void,
  ) {
    this.mutationObserver = new MutationObserver((mutations) => {
      let dirty = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Add the parent so findSegments can match the added node itself
            // (querySelectorAll does not match the root element).
            const parent = (node as Element).parentElement ?? document.body;
            this.pendingRoots.add(parent);
            dirty = true;
          }
        }
      }
      if (dirty) this.scheduleFlush();
    });
  }

  start(): void {
    const targets = this.adapter.observeTargets();
    const roots = targets.length > 0 ? targets : [document.body];
    for (const root of roots) {
      this.mutationObserver.observe(root, { childList: true, subtree: true });
    }
  }

  stop(): void {
    this.mutationObserver.disconnect();
    if (this.idleCallbackId !== null) {
      cancelIdleCallback(this.idleCallbackId);
      this.idleCallbackId = null;
    }
    this.pendingRoots.clear();
  }

  private scheduleFlush(): void {
    if (this.idleCallbackId !== null) return;
    this.idleCallbackId = requestIdleCallback(() => this.flush(), {
      timeout: IDLE_TIMEOUT_MS,
    });
  }

  private flush(): void {
    this.idleCallbackId = null;
    if (this.pendingRoots.size === 0) return;

    const roots = [...this.pendingRoots];
    this.pendingRoots.clear();

    // Deduplicate at the element level within this flush
    const seen = new Set<HTMLElement>();
    const results: HTMLElement[] = [];
    for (const root of roots) {
      for (const el of this.adapter.findSegments(root)) {
        if (!seen.has(el)) {
          seen.add(el);
          results.push(el);
        }
      }
    }
    if (results.length > 0) this.onNewElements(results);
  }
}
