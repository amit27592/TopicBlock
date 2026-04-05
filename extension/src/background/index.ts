/**
 * TopicBlock background service worker.
 * Owns the native messaging connection and routes classify requests from content scripts.
 */

import { NativeMessagingClient } from './nativeClient.js';
import type { ExtMessage, ExtResponse } from '../shared/messaging.js';
import type { ClassifyRequest, UserPreferences } from '../shared/protocols.js';

const nativeClient = new NativeMessagingClient();

chrome.runtime.onInstalled.addListener(() => {
  console.log('[TopicBlock] Extension installed.');
});

// Connect to native component on startup
chrome.runtime.onStartup.addListener(() => {
  void nativeClient.connect().catch((err) => {
    console.warn('[TopicBlock] Native component unavailable on startup:', err);
  });
});

// Also try to connect immediately (for extension reload / dev)
void nativeClient.connect().catch((err) => {
  console.warn('[TopicBlock] Native component unavailable:', err);
});

// In-browser message bus: content scripts → background → native
chrome.runtime.onMessage.addListener(
  (message: ExtMessage, _sender, sendResponse: (res: ExtResponse) => void) => {
    if (message.type === 'classify_segments') {
      const req: ClassifyRequest = message.payload;
      nativeClient
        .classify(req)
        .then((res) => sendResponse({ type: 'classify_result', payload: res }))
        .catch((err: unknown) => {
          console.error('[TopicBlock] classify failed:', err);
          sendResponse({ type: 'error', message: String(err) });
        });
      return true; // keep message channel open for async response
    }

    if (message.type === 'get_health') {
      nativeClient
        .health()
        .then((res) => sendResponse({ type: 'health_result', payload: res }))
        .catch((err: unknown) => sendResponse({ type: 'error', message: String(err) }));
      return true;
    }

    if (message.type === 'update_prefs') {
      const prefs: UserPreferences = message.payload;
      nativeClient
        .updatePreferences(prefs)
        .then(() => sendResponse({ type: 'prefs_ack' }))
        .catch((err: unknown) => sendResponse({ type: 'error', message: String(err) }));
      return true;
    }
  }
);
