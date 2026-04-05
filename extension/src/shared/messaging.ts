/**
 * Typed in-browser message bus between content scripts and the background service worker.
 * Uses chrome.runtime.sendMessage with explicit request/response types.
 * This is distinct from the wire protocol (wire.ts), which is between the extension and native component.
 */

import type {
  ClassifyRequest,
  ClassifyResponse,
  HealthStatus,
  UserPreferences,
} from './protocols.js';

// ---- Messages from content scripts → background ----

export type ExtMessage =
  | { type: 'classify_segments'; payload: ClassifyRequest }
  | { type: 'get_health' }
  | { type: 'update_prefs'; payload: UserPreferences };

// ---- Responses from background → content scripts ----

export type ExtResponse =
  | { type: 'classify_result'; payload: ClassifyResponse }
  | { type: 'health_result'; payload: HealthStatus }
  | { type: 'prefs_ack' }
  | { type: 'error'; message: string };

/**
 * Send a typed message to the background service worker and await a typed response.
 * Wraps chrome.runtime.sendMessage with a Promise.
 */
export function sendToBackground(msg: ExtMessage): Promise<ExtResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response: ExtResponse) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Send a typed message to a specific tab's content script.
 */
export function sendToTab(tabId: number, msg: ExtMessage): Promise<ExtResponse> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (response: ExtResponse) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}
