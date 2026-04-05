# TopicBlock — Implementation Plan

**Project:** TopicBlock — Client-Side ML Browser Extension for Dynamic Content Filtering
**Stack:** WebExtension (Manifest V3) + TypeScript (thin client) ⇄ Native Python Component (PyTorch + HuggingFace Transformers)
**Target browsers:** Chromium (Chrome/Edge/Brave) first, Firefox as stretch.
**Target OSes:** macOS, Linux, Windows.

This plan decomposes the project into independently executable work packages. Each package is scoped so it can be handed to a coding assistant with minimal additional context, has clear inputs, outputs, acceptance criteria, and a defined interface so components can be swapped without rewriting the rest of the system.

The extension is a **thin client**: DOM segmentation, site adapters, and filter actions run in-browser because they need live DOM access. All text extraction, preprocessing, and ML inference run in a **native component** installed on the user's machine and invoked over Chrome Native Messaging (primary transport) or a loopback WebSocket (fallback).

---

## 0. Guiding Principles

1. **Protocol over implementation.** Every replaceable component (site adapter, topic model, sentiment model, filter action, transport) implements a defined interface. Swapping a model must not require changes outside its own module, and must not require an extension rebuild.
2. **Client-side only.** No data ever leaves the user's machine. The native component is local; the extension never touches a remote server for inference.
3. **Fail-open.** If the native component is missing, crashed, or slow, content renders normally. Filtering is additive, never breaks the page.
4. **Progressive enhancement.** Pipeline stages (segment → extract → classify → score → act) are independent and observable; any stage can be bypassed via config.
5. **Measure everything.** Every stage emits timing and decision telemetry to a local ring buffer for evaluation (never leaves the device).
6. **Thin client, fat native.** The extension does as little as possible. Anything that can run natively, runs natively — it has more memory, no sandboxing, and unconstrained model choice.

---

## 1. Repository Layout

```
topicblock/
├── extension/                    # WebExtension (thin client)
│   ├── manifest.json
│   └── src/
│       ├── background/           # Service worker, native messaging client
│       ├── content/
│       │   ├── index.ts          # Entry, orchestrates pipeline
│       │   ├── segmentation/     # MutationObserver + candidate discovery
│       │   ├── adapters/         # Per-site DOM adapters (in-browser)
│       │   └── filter/           # Hide/blur/remove + hover-to-reveal
│       ├── shared/               # Protocols, messaging, telemetry, wire schema
│       ├── ui/                   # Options + popup (React)
│       └── storage/              # Preference layer
├── native/                       # Native Inference Service (Python)
│   ├── pyproject.toml
│   ├── topicblock_native/
│   │   ├── __main__.py           # Native Messaging entry (stdio framing)
│   │   ├── server.py             # Loopback HTTP/WebSocket server (alt transport)
│   │   ├── pipeline.py           # Orchestrates extract → topic → sentiment
│   │   ├── extraction/           # Text preprocessing, language detection
│   │   ├── models/
│   │   │   ├── base.py           # ITopicModel, ISentimentModel (Python)
│   │   │   ├── registry.py
│   │   │   ├── topic_minilm.py
│   │   │   ├── topic_bge.py
│   │   │   ├── sentiment_vader.py
│   │   │   └── sentiment_distilbert.py
│   │   ├── cache.py              # Embedding + verdict cache (SQLite)
│   │   └── telemetry.py
│   ├── installers/               # Native Messaging host manifests per-OS
├── eval/                         # Benchmark harness + labelled datasets
└── scripts/                      # Schema codegen, packaging, installer generation
```

---

## 2. Core Protocols (define first, freeze early)

Two protocol layers: **in-browser TypeScript interfaces** used by the extension, and a **wire protocol** between the extension and the native component. Define both in WP-1 and do not modify without a version bump.

### 2.1 In-browser interfaces

```typescript
// A discrete content unit on the page.
interface ContentSegment {
  id: string;                    // stable hash of DOM path + content
  element: WeakRef<HTMLElement>; // for filter actions
  headline?: string;
  subtitle?: string;
  body?: string;
  meta: { url: string; site: string; domPath: string };
  extractionHint?: "raw_html" | "plain_text";  // tells native how to clean
}

// Per-site DOM adapter. One implementation per supported site.
interface ISiteAdapter {
  readonly siteId: string;                        // e.g. "reddit", "oldreddit", "hackernews"
  matches(url: string): boolean;
  findSegments(root: ParentNode): HTMLElement[];  // candidate containers
  extract(el: HTMLElement): Omit<ContentSegment, "id" | "element" | "meta">;
  observeTargets(): Node[];                       // roots for MutationObserver
}

// Classification result for a single segment.
interface Verdict {
  segmentId: string;
  topics: { label: string; score: number }[];
  sentiment: { polarity: number; magnitude: number } | null;
  blocked: boolean;
  reasons: string[];   // human-readable, for UI + telemetry
  latencyMs: number;
}

// User preferences — persisted in chrome.storage.local.
interface UserPreferences {
  bannedTopics: string[];          // free-text, embedded by native component
  topicThreshold: number;          // cosine similarity threshold, default 0.5
  sentimentThreshold: number;      // -1..1, block if polarity below
  sentimentEnabled: boolean;
  topicModel: string;              // e.g. "minilm-l6-v2"
  sentimentModel: "vader" | "distilbert-sst2";
  action: "hide" | "blur" | "remove";
  hoverToReveal: boolean;
  perSiteOverrides: Record<string, Partial<UserPreferences>>;
}

// Filter action — swappable presentation strategy.
interface IFilterAction {
  apply(el: HTMLElement, verdict: Verdict, prefs: UserPreferences): void;
  revert(el: HTMLElement): void;
}

// Client to the native component. Transport-agnostic.
interface INativeClient {
  connect(): Promise<void>;
  isConnected(): boolean;
  classify(req: ClassifyRequest): Promise<ClassifyResponse>;
  updatePreferences(prefs: UserPreferences): Promise<void>;
  health(): Promise<HealthStatus>;
  listModels(): Promise<ModelInfo[]>;
  dispose(): Promise<void>;
}

interface ClassifyRequest {
  requestId: string;
  segments: {
    id: string;
    headline?: string;
    subtitle?: string;
    body: string;
    site: string;
    lang?: string;             // optional hint; native detects if absent
    extractionHint?: "raw_html" | "plain_text";
  }[];
  prefsVersion: number;        // native caches prefs by version
}

interface ClassifyResponse {
  requestId: string;
  verdicts: Verdict[];
  engineLatencyMs: number;
}

interface HealthStatus {
  ok: boolean;
  version: string;
  loadedTopicModel: string;
  loadedSentimentModel: string;
  device: "cpu" | "cuda" | "mps";
  queueDepth: number;
}

interface ModelInfo {
  kind: "topic" | "sentiment";
  name: string;
  version: string;
  backbone: string;
  maxSeqLen: number;
  defaultThreshold: number;
  hwRequirements: { minRamMb: number; needsGpu: boolean };
}
```

### 2.2 Wire protocol

JSON messages over **Native Messaging** (primary) or **loopback WebSocket** (fallback, user-enabled). Both carry the same message schema. Native Messaging frames each message with a little-endian 32-bit length prefix and enforces a 1 MB per-message cap — batch sizing in WP-6 must respect this.

```
C → N: { "type": "classify",        "payload": ClassifyRequest }
N → C: { "type": "classify_result", "payload": ClassifyResponse }
C → N: { "type": "update_prefs",    "payload": UserPreferences }
N → C: { "type": "prefs_ack",       "payload": { version: number } }
C → N: { "type": "list_models" }
N → C: { "type": "models_list",     "payload": ModelInfo[] }
C → N: { "type": "health" }
N → C: { "type": "health_result",   "payload": HealthStatus }
N → C: { "type": "error",           "payload": { requestId?: string, code: string, message: string } }
```

### 2.3 Native-side interfaces (Python)

```python
class ITopicModel(Protocol):
    name: str
    version: str
    def embed(self, texts: list[str]) -> np.ndarray: ...   # (N, D) float32
    def warmup(self) -> None: ...

class ISentimentModel(Protocol):
    name: str
    version: str
    def score(self, texts: list[str]) -> list[tuple[float, float]]: ...  # (polarity, magnitude)
    def warmup(self) -> None: ...
```

Models are hot-swappable on the native side, driven by an `update_prefs` message from the extension.

---

## 3. Work Packages

Each WP is sized to roughly 1–3 days of focused work. Dependencies are explicit. WPs with no shared dependencies can proceed in parallel.

### WP-1 — Project Scaffold & Protocols
**Deps:** none. **Blocks:** everything.
- Init pnpm workspace for `extension/`, TypeScript strict, ESLint, Prettier.
- Init `native/` Python package with `pyproject.toml`, `uv` for dependency management.
- Webpack/Vite config producing MV3 bundle with separate entry points: `background`, `content`, `options`, `popup`.
- Write `manifest.json` with minimal permissions: `storage`, `scripting`, `activeTab`, `nativeMessaging`, host permissions only for supported sites (WP-4).
- Define all TypeScript protocols in `extension/src/shared/protocols.ts` and wire schema in `extension/src/shared/wire.ts` exactly as §2.
- Write `scripts/gen_schema.py` that generates matching Python dataclasses in `native/topicblock_native/wire.py` from the same source of truth. Run it in CI to prevent drift.
- Define a typed message bus in `extension/src/shared/messaging.ts` wrapping `chrome.runtime.sendMessage` with request/response semantics and correlation IDs.
- **Acceptance:** empty extension loads in Chrome, native Python stub echoes a `health` request round-trip, content script logs on a test page.

### WP-2 — Preference Storage & Options UI
**Deps:** WP-1.
- Implement `extension/src/storage/preferences.ts` exposing `get()`, `set()`, `subscribe()` backed by `chrome.storage.local`.
- React options page with: banned topics (tag input), topic threshold slider, sentiment toggle + slider, topic/sentiment model dropdown (populated from `listModels`), action radio, per-site override table, import/export JSON.
- Popup showing current-site status, last N blocked items (from telemetry ring buffer), quick pause, native component connection status.
- Ship a "sane defaults" preset file.
- Any preference change bumps `prefsVersion` and triggers `updatePreferences()` on the native client.
- **Acceptance:** settings persist across reloads, changes broadcast to content scripts and native component within 200 ms.

### WP-3 — Telemetry & Evaluation Hooks
**Deps:** WP-1.
- `extension/src/shared/telemetry.ts`: in-memory ring buffer (size configurable, default 500) of `{ts, stage, segmentId, latencyMs, verdict?}`.
- Corresponding `native/topicblock_native/telemetry.py` for native-side stage timings, exported via a `telemetry_dump` wire message.
- Exportable as JSON from the options page (for evaluation, never auto-uploaded).
- Wrap every pipeline stage on both sides with a `measure(stage, fn)` helper.
- **Acceptance:** exported log contains one entry per segment per stage with monotonic timing and a clear browser/native boundary.

### WP-4 — DOM Segmentation & Site Adapters
**Deps:** WP-1.
- Segmentation and site adapters remain **in-browser** — they need live DOM access and MutationObserver. Moving them native would require a headless browser per page and is architecturally pointless.
- Implement `extension/src/content/segmentation/observer.ts`: `MutationObserver` wrapper that debounces (requestIdleCallback, 150 ms) and yields newly-visible candidate elements.
- Implement `ISiteAdapter` for **three** initial sites chosen for DOM stability: Reddit (old + new), Hacker News, YouTube homepage + search. Each adapter lives in `extension/src/content/adapters/<site>.ts` and is registered in `adapters/index.ts`.
- Adapters may tag segments as `extractionHint: "raw_html" | "plain_text"`. Segments marked `raw_html` forward their outerHTML (size-capped to stay under the 1 MB Native Messaging frame limit) to the native component, which performs richer extraction (boilerplate stripping, Readability-style cleaning).
- Segment ID = `sha1(site + domPath + first 128 chars of body)` truncated to 16 hex. Stable across re-renders.
- **Acceptance:** on each supported site, segmentation yields ≥95% of visible cards without duplicates across 10 manual test pages. Infinite scroll on Reddit picks up new segments within 500 ms. Segments with `extractionHint: "raw_html"` successfully round-trip through the native extractor and come back with cleaned `body`.

### WP-5 — Text Extraction & Preprocessing (native)
**Deps:** WP-1. Runs in `native/topicblock_native/extraction/`.
- Python module using `lxml` + `readability-lxml` for HTML cleaning when `extractionHint == "raw_html"`, and a fast-path for already-clean `plain_text`.
- Normalization: unicode NFKC, whitespace collapse, emoji stripping (keep a shadow copy), truncation to the loaded model's `max_seq_len`.
- Language detection with `fasttext-langdetect` (lid.176.ftz, ~900 KB); non-target languages short-circuit to a pass-through verdict with `reasons: ["unsupported_language"]`.
- Exposes `preprocess(segments) -> list[CleanedSegment]` consumed by the pipeline in WP-6.
- **Acceptance:** deterministic, ≤ 2 ms per segment on commodity CPU, round-trips correctly for all three initial sites.

### WP-6 — Native Inference Service
**Deps:** WP-1, WP-5.

**Architecture.** A single long-lived Python process, started by the browser via Native Messaging when the extension activates, or run as a user-level background service (systemd/launchd/Windows Service) when installed that way. The process:

1. Reads framed JSON from stdin (Native Messaging) **or** listens on `127.0.0.1:<port>` with an auth token (fallback transport, user-enabled in options).
2. Loads topic and sentiment models at startup using PyTorch + HuggingFace Transformers. Device auto-selects: CUDA > MPS > CPU. No quantization required — full-precision models are fine now that memory is not browser-bound.
3. Maintains an **LRU embedding cache** (SQLite, keyed on `sha256(text)`) so repeat segments on a scrolling page are free.
4. Maintains **per-preferences-version topic embedding tables** — when the user edits banned topics, the extension sends `update_prefs`, the service embeds them once, and subsequent `classify` calls reference them by `prefsVersion`.
5. **Batching:** a coalescing queue with 50 ms window and max batch 32 segments. GPU path uses larger batches (up to 128).
6. Emits structured logs to a rotating file under the user data dir; never over the wire.

**Installation.** A cross-platform installer (WP-13) drops the executable and writes the Native Messaging host manifest to the correct OS location:
- macOS: `~/Library/Application Support/{Chrome,Firefox}/NativeMessagingHosts/`
- Windows: registry key under `HKCU\Software\Google\Chrome\NativeMessagingHosts\`

The manifest pins the extension ID and the allowed origins, so no other extension can invoke the native host.

**Extension-side client.** `extension/src/background/nativeClient.ts` implements `INativeClient` over Native Messaging, with a `LoopbackWebSocketClient` alternate implementation behind the same interface for the fallback transport.

**Acceptance:**
- `health` round-trip ≤ 20 ms.
- `classify(batch=32)` on default models ≤ 150 ms CPU p95, ≤ 40 ms GPU p95.
- Killing the native process causes the extension to surface a non-blocking banner and fall back to pass-through (fail-open). Restart-engine button works.
- Schema codegen drift is caught in CI.

### WP-7 — Topic Model v1 (Zero-Shot Embedding Classifier)
**Deps:** WP-6. Implemented in `native/topicblock_native/models/topic_minilm.py`.
- **Approach:** zero-shot via sentence embeddings, not a fixed-label classifier. This lets the user type arbitrary banned topics without retraining.
- Default backbone: `sentence-transformers/all-MiniLM-L6-v2` loaded directly via `sentence-transformers`. No ONNX, no quantization, full fp32 (or fp16 on GPU).
- At `update_prefs` time, embed each banned-topic string and store the vectors keyed by `prefsVersion`. At inference time, embed the segment and compute cosine similarity against every cached topic vector. Block if max similarity > `prefs.topicThreshold` (default 0.5, tuned in eval).
- Alternate backbone `topic_bge.py` wrapping `BAAI/bge-small-en-v1.5` — dropped in via the registry, selectable from the options UI.
- Because memory is no longer a hard constraint, larger models (`bge-base`, `e5-base`) are viable; the only tradeoff is latency, measured in WP-11.
- Wrap behind `ITopicModel` so backbones swap with zero pipeline changes.
- **Acceptance:** topic match F1 ≥ 0.80 on the eval set (WP-10), inference ≤ 40 ms per segment CPU, ≤ 10 ms GPU.

### WP-8 — Sentiment Model v1
**Deps:** WP-6.
- **Two backends selectable via preference, both implementing `ISentimentModel`:**
  1. `sentiment_vader.py` wraps the original `vaderSentiment` Python library. Zero model weight, microsecond-scale. Default.
  2. `sentiment_distilbert.py` loads `distilbert-base-uncased-finetuned-sst-2-english` via `transformers.pipeline("sentiment-analysis")`.
- Polarity normalized to `[-1, 1]`, magnitude to `[0, 1]`. Block if `polarity < prefs.sentimentThreshold` **and** `magnitude > 0.3`.
- Selection pushed to the native component via `update_prefs`; hot-swap without process restart.
- **Acceptance:** both backends interchangeable from the options UI, results deterministic for identical input.

### WP-9 — Filter Engine
**Deps:** WP-4, WP-6.
- Implement three `IFilterAction`s in `extension/src/content/filter/`: `HideAction`, `BlurAction` (CSS filter + overlay with reason), `RemoveAction`.
- `BlurAction` overlay shows up to two human-readable reasons from `verdict.reasons` and offers a "show anyway" button that calls `revert(el)` and records a user override to the telemetry buffer for eval.
- All DOM writes batched in `requestAnimationFrame`.
- Injected CSS lives in a shadow root to avoid site style collisions.
- **Acceptance:** blocked elements visibly change state within one frame of verdict arrival, "show anyway" restores original layout pixel-for-pixel.

### WP-10 — Evaluation Harness & Labelled Dataset
**Deps:** WP-3, WP-7, WP-8. **Runs in parallel with UI polishing.**
- Assemble a labelled test set of ≥500 real segments scraped from the three supported sites across varied topics. Label schema: `{text, topicsPresent[], sentimentBucket}`. Store as `eval/dataset.jsonl`.
- Primary harness (`eval/run.py`) runs **directly against the native component's Python API**, bypassing the extension — easier to iterate, same models, same results. Reports precision/recall/F1 per banned-topic query and per sentiment threshold, plus p50/p95 latency.
- Secondary harness loads the built extension in Playwright, navigates the three target sites against archived HTML fixtures, and compares actual DOM actions to a gold-standard block list. This exercises the full transport.
- Baselines to reproduce for comparison (per proposal §V): keyword blacklist, Detox Browser-style lexical+keyword, Kuppusamy & Aghila segmentation model (reimplemented from paper pseudocode as the upper bound).
- **Acceptance:** `python -m eval.run` produces a markdown report with all metrics; results reproducible given a fixed seed.

### WP-11 — Performance Benchmarking
**Deps:** WP-6, WP-9.
- Measure the **native process** RSS, CPU%, and GPU utilization separately from the browser process, plus the native-messaging round-trip overhead (stdin/stdout framing adds measurable latency).
- Device matrix: (a) CPU-only laptop, (b) CPU-only low-end desktop, (c) GPU desktop (CUDA), (d) Apple Silicon (MPS).
- Explicitly measure **transport overhead** (Native Messaging vs loopback WebSocket) so WP-13 can default to the faster one on each OS.
- Produce a table: device × model × transport × (p50, p95 latency, peak memory delta, idle CPU %).
- **Acceptance:** report attached to the dissertation; end-to-end p95 ≤ 200 ms on the CPU-only laptop with default models.

### WP-12 — Usability Study Package
**Deps:** WP-9, WP-2.
- Build an instrumented build that logs (locally) false-positive and false-negative self-reports via a one-click thumbs on the blur overlay.
- Prepare the validated wellbeing questionnaire referenced in the proposal plus a short UX survey (SUS).
- Write the study protocol document, consent form, and recruitment blurb.
- **Acceptance:** pilot with 3 users works end-to-end, data exports cleanly.

### WP-13 — Packaging, Installer, Docs, Stretch Items
**Deps:** all prior.
- **Native component packaging:** use `PyInstaller` to produce standalone binaries per OS. No user-side Python install required. Signed on macOS and Windows; `.deb`/`.rpm` on Linux.
- **Installer:** cross-platform installer that (a) drops the native binary, (b) writes Native Messaging host manifests to the correct per-OS location, (c) pins the extension ID. Uninstaller removes everything cleanly.
- Store listing assets, privacy policy ("no data leaves your device"), README, architecture diagram matching proposal Fig. 1.
- **Stretch:** Firefox port (Native Messaging is supported on Firefox with minor manifest differences), multilingual embeddings (`paraphrase-multilingual-MiniLM`), MobileNetV3 image classification hook (proposal §VI) behind `IImageModel` in the native component, preemptive inference via `webRequest` interception.

---

## 4. Execution Order & Parallelism

```
WP-1  ──┬── WP-2 ─────────────────────────────── WP-12
        ├── WP-3 ─────────────── WP-10
        ├── WP-4 ──┐
        ├── WP-5 ──┴── WP-6 ──┬── WP-7 ──┐
        │                     └── WP-8 ──┴── WP-9 ── WP-11 ── WP-13
        └── (protocols + wire schema frozen)
```

Critical path: WP-1 → WP-5 → WP-6 → WP-7 → WP-9 → WP-11 → WP-13. WP-4 and WP-5 can proceed in parallel since they live on opposite sides of the wire.

---

## 5. Performance Budgets (non-negotiable targets)

| Stage                            | Budget per segment (CPU-only laptop)         |
|----------------------------------|----------------------------------------------|
| Segmentation (browser)           | ≤ 2 ms                                       |
| Native Messaging round-trip      | ≤ 10 ms (batched)                            |
| Extraction + preprocess (native) | ≤ 2 ms                                       |
| Topic inference (native, MiniLM) | ≤ 40 ms batched, ≤ 10 ms on GPU              |
| Sentiment (VADER)                | ≤ 0.5 ms                                     |
| Sentiment (DistilBERT, native)   | ≤ 25 ms batched, ≤ 5 ms on GPU               |
| Filter action (browser)          | ≤ 1 frame (16 ms)                            |
| **End-to-end p95**               | **≤ 200 ms DOM insert → visible filter**     |

No automatic fallback-on-latency degradation — the native process has enough headroom that model choice is a pure preference, not a thermal/memory coping mechanism. The only fallback is the fail-open path when the native component is unreachable.

---

## 6. Model Substitution Protocol

To swap a topic or sentiment model without touching extension code:

1. Install the new model into the native component's Python environment — either bundled via `pip install` during build, or (for larger models) fetched from HuggingFace Hub on first selection and cached under the user data dir.
2. Implement `ITopicModel` or `ISentimentModel` in a new file under `native/topicblock_native/models/`.
3. Register it in `native/topicblock_native/models/registry.py` with `{name, version, backbone, max_seq_len, default_threshold, hw_requirements}`.
4. Run `python -m eval.run --model <n>@<version>` against the eval set to produce a comparison report against the current default.
5. The options UI reads the registry over the wire (`list_models` message) and presents available models with their hardware requirements. User selects one; extension sends `update_prefs`; the native component hot-swaps the model without process restart.

No extension rebuild is ever required to ship a new model — the extension never sees model weights and doesn't care what backbone is running. Shipping a new model is a native-component-only release.

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Users unwilling to install a native component | Clear installer, notarized/signed binaries, plain-English privacy statement, loopback-server fallback if Native Messaging install fails |
| Native process crash or absence | Extension detects disconnect, fails open, shows a one-click "restart engine" banner |
| Native Messaging 1 MB message cap | Batch sizing respects the cap; oversized `raw_html` segments are chunked or pre-stripped in the browser before send |
| Cross-platform packaging complexity | WP-13: `PyInstaller` standalone binaries per OS; signed on macOS/Windows; `.deb`/`.rpm` on Linux |
| Version skew between extension and native component | Both expose `version` in `health`; extension refuses to operate if major versions disagree and prompts for update |
| Schema drift between TS and Python | Single source of truth + codegen in CI (WP-1) |
| Installer trust / permissions | Native component runs as the invoking user only, no elevation, no system services by default |
| Site DOMs change and break adapters | Adapter contract is small (3 methods); detect via synthetic test fixtures in CI |
| False positives erode trust | Hover-to-reveal + "show anyway" + per-site override + reasons surfaced in UI |
| LDA / transformer on short text underperforms | Use sentence embeddings, not LDA (per Altarturi et al. finding cited in proposal) |

---

## 8. Deliverables (concrete starting slice)

A coding assistant should be able to produce the following in order:

1. WP-1 scaffold for both `extension/` and `native/`, with the schema codegen script wired into CI.
2. `extension/src/shared/protocols.ts` and `extension/src/shared/wire.ts` containing exactly the interfaces in §2, plus generated `native/topicblock_native/wire.py`.
3. `extension/src/shared/messaging.ts` typed bus.
4. `extension/src/background/nativeClient.ts` implementing `INativeClient` over Native Messaging.
5. Native stub (`native/topicblock_native/__main__.py`) that handles `health` and returns a fake `classify_result` where `blocked = bannedTopic in body`.
6. `extension/src/storage/preferences.ts` + a minimal options page with just the banned-topics tag input.
7. `extension/src/content/adapters/hackernews.ts` as the reference adapter (simplest DOM), plus `extension/src/content/segmentation/observer.ts`, feeding the native stub end-to-end.
8. **Milestone:** a real block happens on Hacker News driven by a Python process on the host, proving the entire transport.
9. Replace the stub: wire in `sentence-transformers/all-MiniLM-L6-v2` + VADER inside the native component (WP-5, WP-7, WP-8). Extension code does not change.

Once this slice is green, WPs 9–13 proceed per §4.
