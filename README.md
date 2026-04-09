# TopicBlock

**TopicBlock** is a privacy-first, client-side ML browser extension designed for dynamic content filtering. It allows users to block or hide content based on arbitrary topics and sentiment without their data ever leaving their machine.

##  Overview

TopicBlock uses a **thin-client / fat-native** architecture. The browser extension handles lightweight tasks like DOM segmentation and user interaction, while a native Python component performs heavy lifting such as text extraction and machine learning inference (Topic & Sentiment analysis).

- **Privacy-First**: All inference happens locally. No data is sent to external servers.
- **Dynamic Filtering**: Use zero-shot classification to block topics on the fly without retraining models.
- **Fail-Open**: If the native component is unavailable, web content renders normally—filtering is strictly additive.

## Architecture

### 1. Browser Extension (TypeScript, Manifest V3)
Located in `extension/`.
- **DOM Segmentation**: Identifies content units on supported sites (Reddit, Hacker News, YouTube).
- **Site Adapters**: Site-specific logic for content extraction.
- **Filter Engine**: Applies "Hide", "Remove", or "Blur" actions to blocked content.
- **Native Client**: Communicates with the Python component via Chrome Native Messaging.

### 2. Native Component (Python)
Located in `native/`.
- **Text Preprocessing**: Cleans HTML/plain text and detects language (FastText).
- **ML Inference**:
  - **Topic Model**: Zero-shot embedding-based classification using `MiniLM-L6-v2` or `BGE-small`.
  - **Sentiment Model**: Hybrid analysis using VADER (fast) or DistilBERT (accurate).
- **Embedding Cache**: SQLite-backed LRU cache for high performance on repeated content.

## Repository Structure

```text
topicblock/
├── extension/             # WebExtension (TypeScript)
│   ├── src/
│   │   ├── background/    # Service worker & native messaging client
│   │   ├── content/       # DOM segmentation & site adapters
│   │   ├── filter/        # Filter actions (Blur, Hide, Remove)
│   │   ├── shared/        # Protocols & wire schema
│   │   └── storage/       # Preferences & telemetry
├── native/                # Native Inference Service (Python)
│   ├── topicblock_native/
│   │   ├── extraction/    # Text cleaning & normalization
│   │   ├── models/        # Topic & Sentiment implementations
│   │   ├── pipeline.py    # Orchestration
│   │   └── cache.py       # SQLite LRU cache
└── scripts/               # Schema codegen and build scripts
```

## Getting Started

### Prerequisites
- Node.js & npm (for the extension)
- Python 3.10+ (for the native component)
- `pnpm` (recommended for extension development)

### Extension Setup
```bash
cd extension
npm install
npm run build
```
Load the `extension/dist` directory into your browser as an unpacked extension.

### Native Component Setup
```bash
cd native
pip install -e .
```

### Protocol Synchronisation
The project uses a single source of truth for communication types. If you modify TypeScript protocols in `extension/src/shared/protocols.ts`, regenerate the Python dataclasses:
```bash
python scripts/gen_schema.py
```


## Design Principles

1. **Protocol over implementation**: Swapping a model or transport layer requires zero changes to the rest of the system.
2. **Fat Native**: Anything that *can* run natively, *does* run natively to save browser resources.
3. **Measure everything**: Every stage of the pipeline is tracked via a local telemetry ring buffer.
