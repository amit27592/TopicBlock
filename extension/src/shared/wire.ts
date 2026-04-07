/**
 * Wire protocol between the extension and the native component.
 * Carried over Native Messaging (primary) or loopback WebSocket (fallback).
 * Native Messaging frames each message with a little-endian 32-bit length prefix.
 * 1 MB per-message hard cap — batch sizing must respect this.
 *
 * This file is the source of truth for wire types.
 * Run `python scripts/gen_schema.py` to regenerate native/topicblock_native/wire.py.
 */

import type {
  ClassifyRequest,
  ClassifyResponse,
  HealthStatus,
  ModelInfo,
  NativeTelemetryEntry,
  UserPreferences,
} from './protocols.js';

// ---- Client → Native messages ----

export interface WireClassify {
  type: 'classify';
  payload: ClassifyRequest;
}

export interface WireUpdatePrefs {
  type: 'update_prefs';
  payload: UserPreferences;
}

export interface WireListModels {
  type: 'list_models';
}

export interface WireHealth {
  type: 'health';
}

export interface WireTelemetryDump {
  type: 'telemetry_dump';
}

export type ClientMessage =
  | WireClassify
  | WireUpdatePrefs
  | WireListModels
  | WireHealth
  | WireTelemetryDump;

// ---- Native → Client messages ----

export interface WireClassifyResult {
  type: 'classify_result';
  payload: ClassifyResponse;
}

export interface WirePrefsAck {
  type: 'prefs_ack';
  payload: { version: number };
}

export interface WireModelsList {
  type: 'models_list';
  payload: ModelInfo[];
}

export interface WireHealthResult {
  type: 'health_result';
  payload: HealthStatus;
}

export interface WireError {
  type: 'error';
  payload: { requestId?: string; code: string; message: string };
}

export interface WireTelemetryDumpResult {
  type: 'telemetry_dump_result';
  payload: { entries: NativeTelemetryEntry[] };
}

export type NativeMessage =
  | WireClassifyResult
  | WirePrefsAck
  | WireModelsList
  | WireHealthResult
  | WireError
  | WireTelemetryDumpResult;

// Combined union for narrowing in handlers
export type WireMessage = ClientMessage | NativeMessage;
