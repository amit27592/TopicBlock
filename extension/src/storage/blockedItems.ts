/**
 * Ring buffer for recently blocked content segments.
 * Stored in chrome.storage.local; written by the background service worker
 * when classify results contain blocked: true verdicts.
 * Read by the popup to display recent activity.
 */

const KEY = 'topicblock_blocked_items';
export const RING_SIZE = 50;

export interface BlockedItem {
  ts: number;       // Unix ms
  segmentId: string;
  site: string;
  headline?: string;
  reasons: string[];
}

/** Prepend an item to the ring buffer, capping at RING_SIZE. */
export async function push(item: BlockedItem): Promise<void> {
  const result = await chrome.storage.local.get(KEY);
  const items = (result[KEY] as BlockedItem[] | undefined) ?? [];
  items.unshift(item);
  if (items.length > RING_SIZE) items.length = RING_SIZE;
  await chrome.storage.local.set({ [KEY]: items });
}

/** Read the full ring buffer, newest first. */
export async function getAll(): Promise<BlockedItem[]> {
  const result = await chrome.storage.local.get(KEY);
  return (result[KEY] as BlockedItem[] | undefined) ?? [];
}

/** Clear the ring buffer. */
export async function clear(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}
