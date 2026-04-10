import { type ReactElement, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ModelInfo, NativeTelemetryEntry, UserPreferences } from '../../shared/protocols.js';
import { sendToBackground } from '../../shared/messaging.js';
import type { TelemetryEntry } from '../../shared/telemetry.js';
import {
  exportJSON,
  get as getPrefs,
  importJSON,
  reset as resetPrefs,
  set as setPrefs,
} from '../../storage/preferences.js';
import { PRESETS } from '../../storage/presets.js';

// ─── Design tokens ────────────────────────────────────────────────────────────

const C = {
  primary: '#6d28d9',
  primaryHover: '#5b21b6',
  bg: '#f5f3ff',
  card: '#ffffff',
  border: '#e5e7eb',
  text: '#111827',
  muted: '#6b7280',
  danger: '#ef4444',
  success: '#10b981',
  disabled: '#d1d5db',
} as const;

const baseInput: React.CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 14,
  color: C.text,
  outline: 'none',
  background: 'white',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function TagInput({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}): ReactElement {
  const [value, setValue] = useState('');

  function addTag(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed && !tags.includes(trimmed)) onChange([...tags, trimmed]);
    setValue('');
  }

  function removeTag(i: number): void {
    onChange(tags.filter((_, idx) => idx !== i));
  }

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        padding: '6px 8px',
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        background: 'white',
        minHeight: 40,
        alignItems: 'center',
      }}
    >
      {tags.map((tag, i) => (
        <span
          key={tag}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 8px',
            background: C.primary,
            color: 'white',
            borderRadius: 999,
            fontSize: 13,
          }}
        >
          {tag}
          <button
            onClick={() => removeTag(i)}
            style={{
              background: 'none',
              border: 'none',
              color: 'white',
              cursor: 'pointer',
              padding: 0,
              lineHeight: 1,
              fontSize: 15,
            }}
            aria-label={`Remove ${tag}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addTag(value);
          }
          if (e.key === 'Backspace' && !value && tags.length > 0) {
            removeTag(tags.length - 1);
          }
        }}
        onBlur={() => {
          if (value) addTag(value);
        }}
        placeholder={tags.length === 0 ? 'Type a topic and press Enter…' : ''}
        style={{
          border: 'none',
          outline: 'none',
          fontSize: 14,
          flexGrow: 1,
          minWidth: 160,
          color: C.text,
        }}
      />
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  disabled?: boolean;
  onChange: (v: number) => void;
}): ReactElement {
  const fmt = format ?? ((v) => v.toFixed(2));
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ minWidth: 160, fontSize: 14, color: disabled ? C.muted : C.text }}>
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ flex: 1, accentColor: C.primary, cursor: disabled ? 'not-allowed' : 'pointer' }}
      />
      <span style={{ minWidth: 44, fontSize: 13, color: disabled ? C.muted : C.text, textAlign: 'right' }}>
        {fmt(value)}
      </span>
    </label>
  );
}

function ModelSelect({
  label,
  kind,
  value,
  models,
  onChange,
}: {
  label: string;
  kind: 'topic' | 'sentiment';
  value: string;
  models: ModelInfo[];
  onChange: (v: string) => void;
}): ReactElement {
  const filtered = models.filter((m) => m.kind === kind);
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ minWidth: 160, fontSize: 14, color: C.text }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...baseInput, flex: 1 }}
      >
        {filtered.length === 0 ? (
          <option value={value}>{value}</option>
        ) : (
          filtered.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name} — {m.backbone}
            </option>
          ))
        )}
      </select>
    </label>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <section
      style={{
        background: C.card,
        borderRadius: 10,
        border: `1px solid ${C.border}`,
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.text }}>{title}</h2>
      {children}
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): ReactElement {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
      <div
        onClick={() => onChange(!checked)}
        style={{
          width: 40,
          height: 22,
          borderRadius: 999,
          background: checked ? C.primary : C.disabled,
          position: 'relative',
          transition: 'background 0.2s',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 20 : 2,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: 'white',
            transition: 'left 0.2s',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          }}
        />
      </div>
      <span style={{ fontSize: 14, color: C.text }}>{label}</span>
    </label>
  );
}

// ─── Per-site overrides table ─────────────────────────────────────────────────

function PerSiteTable({
  overrides,
  onChange,
}: {
  overrides: Record<string, Partial<UserPreferences>>;
  onChange: (overrides: Record<string, Partial<UserPreferences>>) => void;
}): ReactElement {
  const [newSite, setNewSite] = useState('');
  const [newAction, setNewAction] = useState<UserPreferences['action'] | ''>('');
  const [newThreshold, setNewThreshold] = useState('');

  function addOverride(): void {
    const site = newSite.trim();
    if (!site) return;
    const partial: Partial<UserPreferences> = {};
    if (newAction) partial.action = newAction;
    if (newThreshold !== '') {
      const v = parseFloat(newThreshold);
      if (!isNaN(v)) partial.topicThreshold = v;
    }
    onChange({ ...overrides, [site]: partial });
    setNewSite('');
    setNewAction('');
    setNewThreshold('');
  }

  function removeOverride(site: string): void {
    const next = { ...overrides };
    delete next[site];
    onChange(next);
  }

  const entries = Object.entries(overrides);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {entries.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: C.muted }}>
          No per-site overrides. Add one below.
        </p>
      ) : (
        <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {['Site', 'Action', 'Topic threshold', ''].map((h) => (
                <th
                  key={h}
                  style={{ padding: '4px 8px', textAlign: 'left', color: C.muted, fontWeight: 500 }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map(([site, partial]) => (
              <tr key={site} style={{ borderBottom: `1px solid ${C.border}` }}>
                <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{site}</td>
                <td style={{ padding: '6px 8px' }}>{partial.action ?? '—'}</td>
                <td style={{ padding: '6px 8px' }}>
                  {partial.topicThreshold != null ? partial.topicThreshold.toFixed(2) : '—'}
                </td>
                <td style={{ padding: '6px 8px' }}>
                  <button
                    onClick={() => removeOverride(site)}
                    style={{
                      background: 'none',
                      border: `1px solid ${C.border}`,
                      borderRadius: 4,
                      padding: '2px 8px',
                      cursor: 'pointer',
                      color: C.danger,
                      fontSize: 12,
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={newSite}
          onChange={(e) => setNewSite(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addOverride(); }}
          placeholder="site (e.g. reddit.com)"
          style={{ ...baseInput, flex: 2, minWidth: 160 }}
        />
        <select
          value={newAction}
          onChange={(e) => setNewAction(e.target.value as UserPreferences['action'] | '')}
          style={{ ...baseInput, flex: 1, minWidth: 80 }}
        >
          <option value="">action…</option>
          <option value="hide">hide</option>
          <option value="blur">blur</option>
          <option value="remove">remove</option>
        </select>
        <input
          value={newThreshold}
          onChange={(e) => setNewThreshold(e.target.value)}
          placeholder="threshold"
          type="number"
          min={0}
          max={1}
          step={0.05}
          style={{ ...baseInput, width: 90 }}
        />
        <button
          onClick={addOverride}
          disabled={!newSite.trim()}
          style={{
            padding: '6px 14px',
            background: newSite.trim() ? C.primary : C.disabled,
            color: 'white',
            border: 'none',
            borderRadius: 6,
            cursor: newSite.trim() ? 'pointer' : 'not-allowed',
            fontSize: 13,
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ─── Main options page ────────────────────────────────────────────────────────

function OptionsPage(): ReactElement {
  const [prefs, setPrefsState] = useState<UserPreferences | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [savedMs, setSavedMs] = useState<number>(0);
  const [telemetryCount, setTelemetryCount] = useState<number>(0);
  const [cacheSize, setCacheSize] = useState<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void getPrefs().then(setPrefsState);
    void sendToBackground({ type: 'list_models' })
      .then((res) => {
        if (res.type === 'models_list') setModels(res.payload);
      })
      .catch(() => {});
    // Poll browser telemetry count and cache size
    const interval = setInterval(() => {
      void sendToBackground({ type: 'get_telemetry' }).then((res) => {
        if (res.type === 'telemetry_result') setTelemetryCount(res.payload.length);
      });
      void sendToBackground({ type: 'get_verdict_cache_stats' }).then((res) => {
        if (res.type === 'verdict_cache_stats') setCacheSize(res.payload.size);
      });
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  async function update(partial: Partial<UserPreferences>): Promise<void> {
    const next = await setPrefs(partial);
    setPrefsState(next);
    setSavedMs(Date.now());
  }

  async function applyPreset(id: string): Promise<void> {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    // Preserve the user's banned topics and per-site overrides
    await update({ ...preset.prefs, bannedTopics: prefs?.bannedTopics ?? [], perSiteOverrides: prefs?.perSiteOverrides ?? {} });
  }

  function handleImport(): void {
    fileInputRef.current?.click();
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const next = await importJSON(text);
      setPrefsState(next);
      setSavedMs(Date.now());
    } catch {
      alert('Invalid JSON file.');
    }
    e.target.value = '';
  }

  function handleExport(): void {
    if (!prefs) return;
    const blob = new Blob([exportJSON(prefs)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'topicblock-prefs.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleReset(): Promise<void> {
    if (!confirm('Reset all settings to defaults?')) return;
    const next = await resetPrefs();
    setPrefsState(next);
    setSavedMs(Date.now());
  }

  async function handleExportTelemetry(): Promise<void> {
    // Fetch browser entries from background ring buffer
    const browserRes = await sendToBackground({ type: 'get_telemetry' }).catch(() => null);
    const browserEntries: TelemetryEntry[] =
      browserRes?.type === 'telemetry_result' ? browserRes.payload : [];

    // Fetch native entries via telemetry_dump wire message
    const nativeRes = await sendToBackground({ type: 'telemetry_dump' }).catch(() => null);
    const nativeEntries: NativeTelemetryEntry[] =
      nativeRes?.type === 'telemetry_dump_result' ? nativeRes.payload : [];

    const combined = {
      exportedAt: new Date().toISOString(),
      bufferSizes: { browser: browserEntries.length, native: nativeEntries.length },
      browser: browserEntries,
      native: nativeEntries,
    };

    const blob = new Blob([JSON.stringify(combined, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `topicblock-telemetry-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleClearTelemetry(): Promise<void> {
    await sendToBackground({ type: 'clear_telemetry' }).catch(() => {});
    setTelemetryCount(0);
  }

  async function handleClearVerdictCache(): Promise<void> {
    await sendToBackground({ type: 'clear_verdict_cache' }).catch(() => {});
    setCacheSize(0);
  }

  if (!prefs) {
    return (
      <div style={{ padding: 40, color: C.muted, fontFamily: 'system-ui, sans-serif' }}>
        Loading…
      </div>
    );
  }

  const showSaved = Date.now() - savedMs < 1500;

  return (
    <div
      style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        background: C.bg,
        minHeight: '100vh',
        padding: '32px 16px',
      }}
    >
      <div style={{ maxWidth: 680, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: C.primary }}>
            TopicBlock
          </h1>
          <span style={{ fontSize: 13, color: C.muted }}>Settings</span>
          {showSaved && (
            <span style={{ fontSize: 13, color: C.success, marginLeft: 'auto' }}>Saved ✓</span>
          )}
        </div>

        {/* Banned Topics */}
        <Section title="Banned Topics">
          <p style={{ margin: 0, fontSize: 13, color: C.muted }}>
            Free-text topics to filter. The native component embeds them and blocks content with high cosine similarity.
          </p>
          <TagInput
            tags={prefs.bannedTopics}
            onChange={(bannedTopics) => void update({ bannedTopics })}
          />
        </Section>

        {/* Topic Filtering */}
        <Section title="Topic Filtering">
          <Slider
            label="Match threshold"
            value={prefs.topicThreshold}
            min={0.1}
            max={0.9}
            step={0.05}
            onChange={(topicThreshold) => void update({ topicThreshold })}
          />
          <ModelSelect
            label="Topic model"
            kind="topic"
            value={prefs.topicModel}
            models={models}
            onChange={(topicModel) => void update({ topicModel })}
          />
        </Section>

        {/* Sentiment Filtering */}
        <Section title="Sentiment Filtering">
          <Toggle
            label="Enable sentiment filter"
            checked={prefs.sentimentEnabled}
            onChange={(sentimentEnabled) => void update({ sentimentEnabled })}
          />
          <Slider
            label="Polarity threshold"
            value={prefs.sentimentThreshold}
            min={-1}
            max={0}
            step={0.05}
            disabled={!prefs.sentimentEnabled}
            format={(v) => v.toFixed(2)}
            onChange={(sentimentThreshold) => void update({ sentimentThreshold })}
          />
          <ModelSelect
            label="Sentiment model"
            kind="sentiment"
            value={prefs.sentimentModel}
            models={models}
            onChange={(sentimentModel) =>
              void update({ sentimentModel: sentimentModel as UserPreferences['sentimentModel'] })
            }
          />
        </Section>

        {/* Filter Action */}
        <Section title="Filter Action">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(['hide', 'blur', 'remove'] as const).map((action) => (
              <label
                key={action}
                style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}
              >
                <input
                  type="radio"
                  name="action"
                  value={action}
                  checked={prefs.action === action}
                  onChange={() => void update({ action })}
                  style={{ accentColor: C.primary }}
                />
                <span style={{ textTransform: 'capitalize' }}>{action}</span>
                <span style={{ fontSize: 12, color: C.muted }}>
                  {action === 'hide'
                    ? '— collapse the element'
                    : action === 'blur'
                      ? '— blur content, click to reveal'
                      : '— remove from DOM'}
                </span>
              </label>
            ))}
          </div>
          <Toggle
            label="Hover to reveal blurred content"
            checked={prefs.hoverToReveal}
            onChange={(hoverToReveal) => void update({ hoverToReveal })}
          />
        </Section>

        {/* Per-site overrides */}
        <Section title="Per-Site Overrides">
          <p style={{ margin: 0, fontSize: 13, color: C.muted }}>
            Override action or threshold for specific sites. Site key must match the hostname (e.g.{' '}
            <code style={{ fontFamily: 'monospace' }}>reddit.com</code>).
          </p>
          <PerSiteTable
            overrides={prefs.perSiteOverrides}
            onChange={(perSiteOverrides) => void update({ perSiteOverrides })}
          />
        </Section>

        {/* Presets & data */}
        <Section title="Presets & Data">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                onClick={() => void applyPreset(preset.id)}
                title={preset.description}
                style={{
                  padding: '6px 14px',
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  background: 'white',
                  cursor: 'pointer',
                  fontSize: 13,
                  color: C.text,
                }}
              >
                {preset.name}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 4 }}>
            <button
              onClick={handleExport}
              style={{
                padding: '6px 14px',
                background: C.primary,
                color: 'white',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              Export JSON
            </button>
            <button
              onClick={() => void handleImport()}
              style={{
                padding: '6px 14px',
                background: 'white',
                color: C.text,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              Import JSON
            </button>
            <button
              onClick={() => void handleReset()}
              style={{
                padding: '6px 14px',
                background: 'white',
                color: C.danger,
                border: `1px solid ${C.danger}`,
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                marginLeft: 'auto',
              }}
            >
              Reset to Defaults
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={(e) => void onFileChange(e)}
            style={{ display: 'none' }}
          />
        </Section>

        {/* Telemetry */}
        <Section title="Telemetry">
          <p style={{ margin: 0, fontSize: 13, color: C.muted }}>
            Per-segment stage timings collected from both browser and native pipelines. Never
            auto-uploaded — export for offline evaluation only.
          </p>
          <div style={{ fontSize: 13, color: C.text }}>
            Browser buffer:{' '}
            <strong>
              {telemetryCount} / 500
            </strong>{' '}
            entries
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 13, color: C.text }}>
            <span>
              Verdict cache: <strong>{cacheSize.toLocaleString()} / 5,000</strong> entries
            </span>
            <button
              onClick={() => void handleClearVerdictCache()}
              style={{
                padding: '4px 12px',
                background: 'white',
                color: C.muted,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              Clear Cache
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => void handleExportTelemetry()}
              style={{
                padding: '6px 14px',
                background: C.primary,
                color: 'white',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              Export Telemetry JSON
            </button>
            <button
              onClick={() => void handleClearTelemetry()}
              style={{
                padding: '6px 14px',
                background: 'white',
                color: C.muted,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              Clear Browser Buffer
            </button>
          </div>
        </Section>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<OptionsPage />);
}
