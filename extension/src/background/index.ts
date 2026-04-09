/**
 * TopicBlock background service worker.
 * Owns the native messaging connection and routes classify requests from content scripts.
 */

import { NativeMessagingClient } from './nativeClient.js';
import type { ExtMessage, ExtResponse } from '../shared/messaging.js';
import type { ClassifyRequest, UserPreferences } from '../shared/protocols.js';
import { get as getPrefs, PREFS_KEY } from '../storage/preferences.js';
import { push as pushBlocked } from '../storage/blockedItems.js';
import * as telemetry from '../shared/telemetry.js';

const nativeClient = new NativeMessagingClient();

// Connect to native component and sync stored prefs on install/startup
async function initNative(): Promise<void> {
  try {
    await nativeClient.connect();
    const prefs = await getPrefs();
    await nativeClient.updatePreferences(prefs);
  } catch (err) {
    console.warn('[TopicBlock] Native component unavailable:', err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[TopicBlock] Extension installed.');
  void initNative();
});

chrome.runtime.onStartup.addListener(() => {
  void initNative();
});

void initNative();

// When preferences change in storage, push updated prefs to the native component.
chrome.storage.local.onChanged.addListener(
  (changes: Record<string, chrome.storage.StorageChange>) => {
    if (PREFS_KEY in changes && changes[PREFS_KEY].newValue != null) {
      const newPrefs = changes[PREFS_KEY].newValue as UserPreferences;
      if (nativeClient.isConnected()) {
        void nativeClient.updatePreferences(newPrefs).catch((err: unknown) => {
          console.warn('[TopicBlock] Failed to sync prefs to native:', err);
        });
      }
    }
  }
);

// In-browser message bus
chrome.runtime.onMessage.addListener(
  (message: ExtMessage, _sender, sendResponse: (res: ExtResponse) => void) => {
    if (message.type === 'classify_segments') {
      const req: ClassifyRequest = message.payload;
      void (async () => {
        try {
          // Instrument the full native round-trip, recording one entry per segment.
          const res = await telemetry.measureBatch(
            'browser.classify_roundtrip',
            req.segments.map((s) => s.id),
            () => nativeClient.classify(req),
            (result) => new Map(result.verdicts.map((v) => [v.segmentId, v])),
          );

          // Record blocked segments in the ring buffer for popup display.
          const blocked = res.verdicts.filter((v) => v.blocked);
          if (blocked.length > 0) {
            const site = req.segments[0]?.site ?? 'unknown';
            void Promise.all(
              blocked.map((v) => {
                const seg = req.segments.find((s) => s.id === v.segmentId);
                const item = {
                  ts: Date.now(),
                  segmentId: v.segmentId,
                  site,
                  reasons: v.reasons,
                  ...(seg?.headline != null ? { headline: seg.headline } : {}),
                };
                return pushBlocked(item);
              }),
            );
          }

          sendResponse({ type: 'classify_result', payload: res });
        } catch (err: unknown) {
          console.error('[TopicBlock] classify failed:', err);
          sendResponse({ type: 'error', message: String(err) });
        }
      })();
      return true;
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

    if (message.type === 'list_models') {
      nativeClient
        .listModels()
        .then((models) => sendResponse({ type: 'models_list', payload: models }))
        .catch((err: unknown) => sendResponse({ type: 'error', message: String(err) }));
      return true;
    }

    if (message.type === 'get_telemetry') {
      // Synchronous — buffer lives in this module's scope
      sendResponse({ type: 'telemetry_result', payload: telemetry.getAll() });
      return false;
    }

    if (message.type === 'telemetry_dump') {
      nativeClient
        .telemetryDump()
        .then((entries) => sendResponse({ type: 'telemetry_dump_result', payload: entries }))
        .catch((err: unknown) => sendResponse({ type: 'error', message: String(err) }));
      return true;
    }

    if (message.type === 'clear_telemetry') {
      telemetry.clear();
      sendResponse({ type: 'prefs_ack' }); // reuse ack; no dedicated type needed
      return false;
    }

    if (message.type === 'record_override') {
      telemetry.record(message.payload);
      sendResponse({ type: 'prefs_ack' });
      return false;
    }
  }
);
