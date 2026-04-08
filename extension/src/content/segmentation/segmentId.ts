/**
 * Stable segment ID computation.
 *
 * ID = sha1(site + domPath + first 128 chars of body), truncated to 16 hex.
 * SHA-1 is used purely as a stable hash (not for cryptographic purposes).
 * Uses SubtleCrypto, which is available in all Chrome extension contexts.
 */

const _encoder = new TextEncoder();

/**
 * Compute a stable 16-hex segment ID from the three components.
 * Async because SubtleCrypto.digest is async.
 */
export async function computeSegmentId(
  site: string,
  domPath: string,
  body: string,
): Promise<string> {
  const input = site + domPath + body.slice(0, 128);
  const buffer = await crypto.subtle.digest('SHA-1', _encoder.encode(input));
  const hex = Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 16);
}

/**
 * Derive a stable DOM path string for an element, preferring id / data attributes
 * that survive re-renders (e.g. post IDs, video IDs) over positional paths.
 *
 * Priority:
 *  1. element's own `id` attribute  → "#<id>"
 *  2. known content-ID data attributes  → "[attr=val]"
 *  3. walk up to nearest ancestor with `id`, describe remaining path from there
 *  4. fallback: tag chain up to depth 5
 */
export function getDomPath(el: HTMLElement): string {
  // 1. Own id
  if (el.id) return `#${el.id}`;

  // 2. Content-ID attributes
  const stableAttrs = [
    'data-fullname',   // old Reddit: t3_xyz
    'data-post-id',    // shreddit
    'data-video-id',
    'data-entry-id',
    'permalink',       // shreddit-post permalink
  ];
  for (const attr of stableAttrs) {
    const val = el.getAttribute(attr);
    if (val) return `[${attr}="${val}"]`;
  }
  // permalink-like: extract from shreddit-post
  const plink = el.getAttribute('post-title');
  if (plink) return `[post-title="${plink.slice(0, 64)}"]`;

  // 3. Walk up to ancestor with id
  let path = el.tagName.toLowerCase();
  let cur: HTMLElement | null = el.parentElement;
  for (let depth = 0; depth < 5 && cur != null; depth++) {
    if (cur.id) return `#${cur.id} > ${path}`;
    const tag = cur.tagName.toLowerCase();
    const siblings = Array.from(cur.children).filter(
      (c) => c.tagName === cur!.tagName,
    );
    const idx = siblings.indexOf(cur) + 1;
    path = siblings.length > 1 ? `${tag}:nth-of-type(${idx}) > ${path}` : `${tag} > ${path}`;
    cur = cur.parentElement;
  }
  return path;
}
