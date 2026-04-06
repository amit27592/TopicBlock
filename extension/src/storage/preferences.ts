/**
 * User preferences — backed by chrome.storage.local.
 * Single source of truth for all user configuration.
 *
 * Any call to set() bumps prefsVersion. The background service worker listens
 * to chrome.storage.local.onChanged and forwards the new prefs to the native
 * component via updatePreferences(), so the 200 ms broadcast requirement is met
 * without the UI needing to message the background directly.
 */

import type { UserPreferences } from '../shared/protocols.js';
import { DEFAULT_PREFERENCES } from '../shared/protocols.js';

export const PREFS_KEY = 'topicblock_prefs';
export const VERSION_KEY = 'topicblock_prefs_version';

/** Load current preferences, falling back to defaults for any missing fields. */
export async function get(): Promise<UserPreferences> {
  const result = await chrome.storage.local.get(PREFS_KEY);
  const stored = result[PREFS_KEY] as UserPreferences | undefined;
  return stored ? { ...DEFAULT_PREFERENCES, ...stored } : { ...DEFAULT_PREFERENCES };
}

/**
 * Persist a partial update, merging with current prefs.
 * Bumps prefsVersion and returns the merged result.
 */
export async function set(updates: Partial<UserPreferences>): Promise<UserPreferences> {
  const current = await get();
  const next: UserPreferences = { ...current, ...updates };
  const version = (await getVersion()) + 1;
  await chrome.storage.local.set({ [PREFS_KEY]: next, [VERSION_KEY]: version });
  return next;
}

/** Current preferences version — used in ClassifyRequest.prefsVersion. */
export async function getVersion(): Promise<number> {
  const result = await chrome.storage.local.get(VERSION_KEY);
  return (result[VERSION_KEY] as number | undefined) ?? 0;
}

type Listener = (prefs: UserPreferences) => void;

/**
 * Subscribe to preference changes across all extension contexts.
 * Returns an unsubscribe function.
 */
export function subscribe(listener: Listener): () => void {
  function handler(changes: Record<string, chrome.storage.StorageChange>): void {
    if (PREFS_KEY in changes && changes[PREFS_KEY].newValue != null) {
      listener(changes[PREFS_KEY].newValue as UserPreferences);
    }
  }
  chrome.storage.local.onChanged.addListener(handler);
  return () => chrome.storage.local.onChanged.removeListener(handler);
}

/** Reset all preferences to defaults and reset the version counter. */
export async function reset(): Promise<UserPreferences> {
  await chrome.storage.local.set({
    [PREFS_KEY]: { ...DEFAULT_PREFERENCES },
    [VERSION_KEY]: 0,
  });
  return { ...DEFAULT_PREFERENCES };
}

/** Parse exported JSON and merge into current prefs. */
export async function importJSON(json: string): Promise<UserPreferences> {
  const parsed = JSON.parse(json) as Partial<UserPreferences>;
  return set(parsed);
}

/** Serialize prefs to pretty-printed JSON for export. */
export function exportJSON(prefs: UserPreferences): string {
  return JSON.stringify(prefs, null, 2);
}
