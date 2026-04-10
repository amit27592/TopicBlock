/**
 * In-browser TypeScript interfaces — the source of truth for TopicBlock's type system.
 * Do not modify without a version bump; Python wire types are generated from wire.ts.
 */

// A discrete content unit on the page.
export interface ContentSegment {
  id: string; // stable hash of DOM path + content
  element: WeakRef<HTMLElement>; // for filter actions
  headline?: string;
  subtitle?: string;
  body?: string;
  meta: { url: string; site: string; domPath: string };
  extractionHint?: 'raw_html' | 'plain_text'; // tells native how to clean
}

// Per-site DOM adapter. One implementation per supported site.
export interface ISiteAdapter {
  readonly siteId: string; // e.g. "reddit", "oldreddit", "hackernews"
  matches(url: string): boolean;
  findSegments(root: ParentNode): HTMLElement[];
  extract(el: HTMLElement): Omit<ContentSegment, 'id' | 'element' | 'meta'>;
  observeTargets(): Node[];
}

// Classification result for a single segment.
export interface Verdict {
  segmentId: string;
  topics: { label: string; score: number }[];
  sentiment: { polarity: number; magnitude: number } | null;
  blocked: boolean;
  reasons: string[]; // human-readable, for UI + telemetry
  latencyMs: number;
}

// User preferences — persisted in chrome.storage.local.
export interface UserPreferences {
  bannedTopics: string[]; // free-text, embedded by native component
  topicThreshold: number; // cosine similarity threshold, default 0.5
  sentimentThreshold: number; // -1..1, block if polarity below
  sentimentEnabled: boolean;
  topicModel: string; // e.g. "minilm-l6-v2"
  sentimentModel: 'vader' | 'distilbert-sst2';
  action: 'hide' | 'blur' | 'remove';
  hoverToReveal: boolean;
  perSiteOverrides: Record<string, Partial<UserPreferences>>;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  bannedTopics: [],
  topicThreshold: 0.5,
  sentimentThreshold: -0.6,
  sentimentEnabled: false,
  topicModel: 'minilm-l6-v2',
  sentimentModel: 'vader',
  action: 'blur',
  hoverToReveal: true,
  perSiteOverrides: {},
};

// Filter action — swappable presentation strategy.
export interface IFilterAction {
  apply(el: HTMLElement, verdict: Verdict, prefs: UserPreferences): void;
  revert(el: HTMLElement): void;
}

// --- Wire-level request/response types (shared with native component via wire.ts) ---

// Single segment as sent over the wire to the native component.
export interface SegmentInput {
  id: string;
  body: string;
  site: string;
  headline?: string;
  subtitle?: string;
  lang?: string;
  extractionHint?: 'raw_html' | 'plain_text';
}

export interface ClassifyRequest {
  requestId: string;
  segments: SegmentInput[];
  prefsVersion: number;
}

export interface ClassifyResponse {
  requestId: string;
  verdicts: Verdict[];
  engineLatencyMs: number;
}

export interface HealthStatus {
  ok: boolean;
  version: string;
  loadedTopicModel: string;
  loadedSentimentModel: string;
  device: 'cpu' | 'cuda' | 'mps';
  queueDepth: number;
}

export interface ModelInfo {
  kind: 'topic' | 'sentiment';
  name: string;
  version: string;
  backbone: string;
  maxSeqLen: number;
  defaultThreshold: number;
  hwRequirements: { minRamMb: number; needsGpu: boolean };
}

// Resource metrics from the native Python process.
export interface NativeStats {
  pid: number;
  cpuPercent: number;        // 0–100
  rssBytes: number;          // resident set size in bytes
  uptimeSeconds: number;     // process uptime
  cacheDbSizeBytes: number;
  embeddingCacheCount: number;
  topicVectorVersions: number[];
}

// One timing record from the native pipeline. Stage names use a 'native.' prefix.
export interface NativeTelemetryEntry {
  ts: number;        // Unix ms at entry recording
  stage: string;     // e.g. 'native.segment_classify', 'native.classify_total'
  segmentId: string;
  latencyMs: number;
  source: string;    // always 'native'
}

// Transport-agnostic interface to the native component.
export interface INativeClient {
  connect(): Promise<void>;
  isConnected(): boolean;
  classify(req: ClassifyRequest): Promise<ClassifyResponse>;
  updatePreferences(prefs: UserPreferences): Promise<void>;
  health(): Promise<HealthStatus>;
  listModels(): Promise<ModelInfo[]>;
  telemetryDump(): Promise<NativeTelemetryEntry[]>;
  getStats(): Promise<NativeStats>;
  dispose(): Promise<void>;
}
