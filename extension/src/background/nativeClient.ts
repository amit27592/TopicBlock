/**
 * Native Messaging client — implements INativeClient over chrome.runtime.connectNative.
 * The native host name must match the name field in the Native Messaging host manifest.
 */

import type {
  ClassifyRequest,
  ClassifyResponse,
  HealthStatus,
  INativeClient,
  ModelInfo,
  NativeTelemetryEntry,
  UserPreferences,
} from '../shared/protocols.js';
import type { ClientMessage, NativeMessage } from '../shared/wire.js';

const NATIVE_HOST = 'com.topicblock.native';

type PendingResolve = (msg: NativeMessage) => void;
type PendingReject = (err: Error) => void;

export class NativeMessagingClient implements INativeClient {
  private port: chrome.runtime.Port | null = null;
  // Maps requestId → { resolve, reject } for classify calls, and a special key for one-shot requests
  private pending = new Map<string, { resolve: PendingResolve; reject: PendingReject }>();
  // Monotonic counter for one-shot request IDs
  private idCounter = 0;

  async connect(): Promise<void> {
    if (this.port) return;
    this.port = chrome.runtime.connectNative(NATIVE_HOST);
    this.port.onMessage.addListener((msg: NativeMessage) => this.handleMessage(msg));
    this.port.onDisconnect.addListener(() => this.handleDisconnect());
    // Verify the connection with a health ping
    await this.health();
  }

  isConnected(): boolean {
    return this.port !== null;
  }

  async classify(req: ClassifyRequest): Promise<ClassifyResponse> {
    const msg: ClientMessage = { type: 'classify', payload: req };
    const response = await this.send(req.requestId, msg);
    if (response.type !== 'classify_result') {
      throw new Error(`Unexpected response type: ${response.type}`);
    }
    return response.payload;
  }

  async updatePreferences(prefs: UserPreferences): Promise<void> {
    const id = this.nextId();
    const msg: ClientMessage = { type: 'update_prefs', payload: prefs };
    const response = await this.send(id, msg);
    if (response.type === 'error') {
      throw new Error(response.payload.message);
    }
  }

  async health(): Promise<HealthStatus> {
    const id = this.nextId();
    const msg: ClientMessage = { type: 'health' };
    const response = await this.send(id, msg);
    if (response.type !== 'health_result') {
      throw new Error(`Unexpected response type: ${response.type}`);
    }
    return response.payload;
  }

  async listModels(): Promise<ModelInfo[]> {
    const id = this.nextId();
    const msg: ClientMessage = { type: 'list_models' };
    const response = await this.send(id, msg);
    if (response.type !== 'models_list') {
      throw new Error(`Unexpected response type: ${response.type}`);
    }
    return response.payload;
  }

  async telemetryDump(): Promise<NativeTelemetryEntry[]> {
    const id = this.nextId();
    const msg: ClientMessage = { type: 'telemetry_dump' };
    const response = await this.send(id, msg);
    if (response.type !== 'telemetry_dump_result') {
      throw new Error(`Unexpected response type: ${response.type}`);
    }
    return response.payload.entries;
  }

  dispose(): Promise<void> {
    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }
    for (const { reject } of this.pending.values()) {
      reject(new Error('NativeClient disposed'));
    }
    this.pending.clear();
    return Promise.resolve();
  }

  private send(correlationId: string, msg: ClientMessage): Promise<NativeMessage> {
    return new Promise((resolve, reject) => {
      if (!this.port) {
        reject(new Error('Native component not connected'));
        return;
      }
      this.pending.set(correlationId, { resolve, reject });
      this.port.postMessage(msg);
    });
  }

  private handleMessage(msg: NativeMessage): void {
    // Route classify_result by requestId; route everything else by the one-shot id
    if (msg.type === 'classify_result') {
      const entry = this.pending.get(msg.payload.requestId);
      if (entry) {
        this.pending.delete(msg.payload.requestId);
        entry.resolve(msg);
      }
      return;
    }

    if (msg.type === 'error' && msg.payload.requestId) {
      const entry = this.pending.get(msg.payload.requestId);
      if (entry) {
        this.pending.delete(msg.payload.requestId);
        entry.resolve(msg); // callers inspect msg.type and throw themselves
      }
      return;
    }

    // For health_result, prefs_ack, models_list, error (no requestId):
    // Resolve the oldest pending one-shot entry
    for (const [id, entry] of this.pending) {
      // One-shot IDs are numeric strings; classify requestIds are UUIDs
      if (/^\d+$/.test(id)) {
        this.pending.delete(id);
        entry.resolve(msg);
        return;
      }
    }
    console.warn('[TopicBlock] Unroutable native message:', msg.type);
  }

  private handleDisconnect(): void {
    const err = chrome.runtime.lastError;
    console.warn('[TopicBlock] Native component disconnected:', err?.message ?? 'unknown reason');
    this.port = null;
    for (const { reject } of this.pending.values()) {
      reject(new Error('Native component disconnected'));
    }
    this.pending.clear();
  }

  private nextId(): string {
    return String(++this.idCounter);
  }
}
