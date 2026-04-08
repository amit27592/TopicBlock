/**
 * Unit tests for segmentId utilities.
 *
 * Runs under Vitest. SubtleCrypto is available in the Node test environment
 * via the global `crypto` object (Node ≥ 19, or Vitest's environment shim).
 */

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { computeSegmentId, getDomPath } from './segmentId.js';

// ─── computeSegmentId ─────────────────────────────────────────────────────────

describe('computeSegmentId', () => {
  it('returns a 16-character hex string', async () => {
    const id = await computeSegmentId('hackernews', '#42069420', 'Hello world');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable — same inputs produce the same ID', async () => {
    const a = await computeSegmentId('reddit', '[data-fullname="t3_abc"]', 'Some title text');
    const b = await computeSegmentId('reddit', '[data-fullname="t3_abc"]', 'Some title text');
    expect(a).toBe(b);
  });

  it('differs when any input component differs', async () => {
    const base = await computeSegmentId('hn', '#1', 'body');
    const diffSite = await computeSegmentId('yt', '#1', 'body');
    const diffPath = await computeSegmentId('hn', '#2', 'body');
    const diffBody = await computeSegmentId('hn', '#1', 'different body');
    expect(base).not.toBe(diffSite);
    expect(base).not.toBe(diffPath);
    expect(base).not.toBe(diffBody);
  });

  it('only uses the first 128 characters of body', async () => {
    const body = 'x'.repeat(200);
    const truncated = 'x'.repeat(128);
    const a = await computeSegmentId('hn', '#1', body);
    const b = await computeSegmentId('hn', '#1', truncated);
    expect(a).toBe(b);
  });
});

// ─── getDomPath ───────────────────────────────────────────────────────────────

describe('getDomPath', () => {
  function makeEl(html: string): HTMLElement {
    const dom = new JSDOM(html);
    return dom.window.document.body.firstElementChild as HTMLElement;
  }

  it('returns #id when element has an id', () => {
    const el = makeEl('<div id="thing_t3_abc123"></div>');
    expect(getDomPath(el)).toBe('#thing_t3_abc123');
  });

  it('returns data-fullname attribute path for old Reddit elements', () => {
    const dom = new JSDOM('<div><div class="thing" data-fullname="t3_xyz"></div></div>');
    const el = dom.window.document.querySelector<HTMLElement>('.thing')!;
    expect(getDomPath(el)).toBe('[data-fullname="t3_xyz"]');
  });

  it('returns post-title attribute path for shreddit-post elements', () => {
    const dom = new JSDOM('<div><div post-title="My Post Title"></div></div>');
    const el = dom.window.document.querySelector<HTMLElement>('[post-title]')!;
    // post-title uses the first 64 chars as the path
    expect(getDomPath(el)).toBe('[post-title="My Post Title"]');
  });

  it('falls back to a tag path when no stable attribute exists', () => {
    const dom = new JSDOM('<div><span></span></div>');
    const el = dom.window.document.querySelector<HTMLElement>('span')!;
    const path = getDomPath(el);
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
  });

  it('walks up to ancestor with id', () => {
    const dom = new JSDOM('<ul id="list"><li><span class="target"></span></li></ul>');
    const el = dom.window.document.querySelector<HTMLElement>('.target')!;
    const path = getDomPath(el);
    expect(path).toContain('#list');
  });
});
