#!/usr/bin/env python3
"""
gen_schema.py — generate native/topicblock_native/wire.py from extension/src/shared/wire.ts.

This script is the CI gate that prevents type drift between the TypeScript wire protocol
and the Python native component. Run it with:

    python scripts/gen_schema.py [--check]

Without --check: regenerates wire.py in place.
With --check:    exits non-zero if the generated output differs from what is on disk.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
TS_PROTOCOLS = REPO_ROOT / "extension" / "src" / "shared" / "protocols.ts"
TS_WIRE = REPO_ROOT / "extension" / "src" / "shared" / "wire.ts"
PY_WIRE = REPO_ROOT / "native" / "topicblock_native" / "wire.py"

# ---------------------------------------------------------------------------
# TypeScript → Python type mapping
# ---------------------------------------------------------------------------

SCALAR_MAP: dict[str, str] = {
    "string": "str",
    "number": "float",
    "boolean": "bool",
    "null": "None",
    "any": "Any",
    "void": "None",
}

# Fields that should be int, not float (TypeScript number covers both)
INT_FIELDS = {"queueDepth", "maxSeqLen", "prefsVersion"}

# Named literal unions from protocols/wire — maps normalised TS type → Python Literal
LITERAL_TYPES: dict[str, str] = {
    '"raw_html" | "plain_text"': 'Literal["raw_html", "plain_text"]',
    '"cpu" | "cuda" | "mps"': 'Literal["cpu", "cuda", "mps"]',
    '"topic" | "sentiment"': 'Literal["topic", "sentiment"]',
    '"vader" | "distilbert-sst2"': 'Literal["vader", "distilbert-sst2"]',
    '"hide" | "blur" | "remove"': 'Literal["hide", "blur", "remove"]',
    '"classify"': 'Literal["classify"]',
    '"update_prefs"': 'Literal["update_prefs"]',
    '"list_models"': 'Literal["list_models"]',
    '"health"': 'Literal["health"]',
    '"classify_result"': 'Literal["classify_result"]',
    '"prefs_ack"': 'Literal["prefs_ack"]',
    '"models_list"': 'Literal["models_list"]',
    '"health_result"': 'Literal["health_result"]',
    '"error"': 'Literal["error"]',
}

# Classes to emit, in order (must be named interfaces in the TS source)
GENERATE_FROM_PROTOCOLS = [
    "SegmentInput",
    "Verdict",
    "ClassifyRequest",
    "ClassifyResponse",
    "HealthStatus",
    "ModelInfo",
    "UserPreferences",
]

GENERATE_FROM_WIRE = [
    "WireClassify",
    "WireUpdatePrefs",
    "WireListModels",
    "WireHealth",
    "WireClassifyResult",
    "WirePrefsAck",
    "WireModelsList",
    "WireHealthResult",
    "WireError",
]

# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

def _strip_inline_comment(line: str) -> str:
    """Remove trailing TypeScript // comment."""
    # Avoid stripping '//' inside string literals — handle the simple case only
    idx = line.find("//")
    if idx >= 0:
        return line[:idx].strip()
    return line.strip()


def _normalise_quotes(ts_type: str) -> str:
    """Convert single-quoted string literals to double-quoted for LITERAL_TYPES lookup."""
    return re.sub(r"'([^']*)'", r'"\1"', ts_type)


def extract_interfaces(ts_source: str) -> dict[str, list[tuple[str, str, bool]]]:
    """
    Returns a dict mapping interface name → list of (field_name, ts_type, optional).
    Uses brace-counting to handle the interface body, so nested braces in inline object
    types don't truncate the match.
    """
    result: dict[str, list[tuple[str, str, bool]]] = {}

    # Find each `export interface Name {` position
    header_re = re.compile(r"export\s+interface\s+(\w+)\s*\{")
    for hm in header_re.finditer(ts_source):
        name = hm.group(1)
        body_start = hm.end()  # position after the opening {

        # Walk forward counting braces to find the matching }
        depth = 1
        pos = body_start
        while pos < len(ts_source) and depth > 0:
            ch = ts_source[pos]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
            pos += 1
        body = ts_source[body_start : pos - 1]

        fields: list[tuple[str, str, bool]] = []
        # Process line by line, skipping lines with nested object types
        nested_depth = 0
        for raw_line in body.splitlines():
            line = _strip_inline_comment(raw_line).rstrip(";").strip()
            if not line:
                continue

            # Track depth for inline object types — skip inner lines
            nested_depth += line.count("{") - line.count("}")
            if nested_depth > 0:
                continue  # inside an inline object type block
            if nested_depth < 0:
                nested_depth = 0
                continue

            # Skip method signatures (contain parentheses) and index signatures
            if "(" in line or line.startswith("["):
                continue

            # Match: fieldName?: TypeExpr  or  fieldName: TypeExpr
            field_m = re.match(r"^(\w+)(\?)?:\s*(.+)$", line)
            if not field_m:
                continue

            fname = field_m.group(1)
            optional = field_m.group(2) == "?"
            ftype = field_m.group(3).strip().rstrip(";")
            fields.append((fname, ftype, optional))

        if fields:
            result[name] = fields

    return result


def ts_type_to_py(ts_type: str, field_name: str = "") -> str:
    """Convert a TypeScript type expression to a Python annotation string."""
    ts_type = ts_type.strip()
    # Normalise to double quotes for lookup
    normalised = _normalise_quotes(ts_type)

    # Check literal union
    if normalised in LITERAL_TYPES:
        return LITERAL_TYPES[normalised]

    # Scalar
    if normalised in SCALAR_MAP:
        py = SCALAR_MAP[normalised]
        # Upgrade float → int for known integer fields
        if py == "float" and field_name in INT_FIELDS:
            return "int"
        return py

    # Array: T[] or Array<T>
    arr_m = re.match(r"^(.+)\[\]$", normalised)
    if arr_m:
        inner = ts_type_to_py(arr_m.group(1).strip())
        return f"list[{inner}]"
    arr_m2 = re.match(r"^Array<(.+)>$", normalised)
    if arr_m2:
        inner = ts_type_to_py(arr_m2.group(1).strip())
        return f"list[{inner}]"

    # Record<K, V>
    rec_m = re.match(r"^Record<(.+),\s*(.+)>$", normalised)
    if rec_m:
        k = ts_type_to_py(rec_m.group(1).strip())
        v = ts_type_to_py(rec_m.group(2).strip())
        return f"dict[{k}, {v}]"

    # Partial<T> → dict[str, Any]
    if re.match(r"^Partial<.+>$", normalised):
        return "dict[str, Any]"

    # Union with null: T | null
    union_null_m = re.match(r"^(.+)\s*\|\s*null$", normalised)
    if union_null_m:
        inner = ts_type_to_py(union_null_m.group(1).strip())
        return f"{inner} | None"

    # Inline object type { ... } or { ... }[] → dict or list[dict]
    if normalised.startswith("{"):
        return "dict[str, Any]"

    # Named interface reference — keep as-is (it's a class name)
    return normalised


# ---------------------------------------------------------------------------
# Emitter
# ---------------------------------------------------------------------------

FILE_HEADER = '''\
"""
Wire protocol types for TopicBlock native component.

AUTO-GENERATED by scripts/gen_schema.py from extension/src/shared/wire.ts.
Do not edit by hand — run `python scripts/gen_schema.py` to regenerate.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

'''

# Fields that need default_factory=dict (mutable default, dict type)
DICT_FACTORY_FIELDS = {"perSiteOverrides"}


def emit_dataclass(name: str, fields: list[tuple[str, str, bool]]) -> str:
    lines = ["@dataclass", f"class {name}:"]
    required: list[str] = []
    optional: list[str] = []
    for fname, ts_type, opt in fields:
        py_type = ts_type_to_py(ts_type, fname)
        if fname in DICT_FACTORY_FIELDS:
            # Always give these a default_factory regardless of TS optionality
            optional.append(f"    {fname}: {py_type} = field(default_factory=dict)")
        elif opt or py_type.endswith("| None") or py_type == "None":
            if py_type.endswith("| None"):
                optional.append(f"    {fname}: {py_type} = None")
            else:
                optional.append(f"    {fname}: {py_type} | None = None")
        else:
            required.append(f"    {fname}: {py_type}")
    all_fields = required + optional
    if not all_fields:
        lines.append("    pass")
    else:
        lines.extend(all_fields)
    return "\n".join(lines) + "\n"


def generate(protocols_source: str, wire_source: str) -> str:
    protocols_ifaces = extract_interfaces(protocols_source)
    wire_ifaces = extract_interfaces(wire_source)

    out = FILE_HEADER
    out += "\n# ---- Shared sub-types ----\n\n"
    for name in GENERATE_FROM_PROTOCOLS:
        ifaces = protocols_ifaces if name in protocols_ifaces else wire_ifaces
        if name in ifaces:
            out += emit_dataclass(name, ifaces[name]) + "\n"

    out += "\n# ---- Wire message envelopes ----\n\n"
    for name in GENERATE_FROM_WIRE:
        ifaces = wire_ifaces if name in wire_ifaces else protocols_ifaces
        if name in ifaces:
            out += emit_dataclass(name, ifaces[name]) + "\n"

    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Regenerate wire.py from wire.ts")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check only — exit non-zero if wire.py is out of date",
    )
    args = parser.parse_args()

    protocols_ts = TS_PROTOCOLS.read_text()
    wire_ts = TS_WIRE.read_text()
    generated = generate(protocols_ts, wire_ts)

    if args.check:
        current = PY_WIRE.read_text() if PY_WIRE.exists() else ""
        if current != generated:
            print("wire.py is out of date. Run `python scripts/gen_schema.py` to regenerate.")
            sys.exit(1)
        print("wire.py is up to date.")
    else:
        PY_WIRE.write_text(generated)
        print(f"Generated {PY_WIRE}")


if __name__ == "__main__":
    main()
