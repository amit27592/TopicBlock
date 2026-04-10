/**
 * TopicBlock Live Monitor — real-time monitoring dashboard.
 *
 * Renders a dark-mode, glassmorphism-styled dashboard that polls the
 * background service worker for health, telemetry, cache stats, native
 * resource metrics, and active tab information.
 */

import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  HealthStatus,
  ModelInfo,
  NativeStats,
  NativeTelemetryEntry,
} from '../../shared/protocols.js';
import type { TelemetryEntry } from '../../shared/telemetry.js';
import { sendToBackground } from '../../shared/messaging.js';
import {
  drawLineChart,
  drawAreaChart,
  drawGauge,
  drawBar,
  PURPLE_500,
  PURPLE_400,
  PURPLE_300,
  GREEN_400,
  RED_400,
  AMBER_400,
} from './charts.js';

// ─── Design tokens ──────────────────────────────────────────────────────────

const T = {
  bg: 'linear-gradient(145deg, #0a0118 0%, #1a0533 50%, #0f0720 100%)',
  card: 'rgba(255,255,255,0.04)',
  cardBorder: 'rgba(139,92,246,0.12)',
  cardHover: 'rgba(255,255,255,0.06)',
  text: '#f1f0f5',
  textMuted: 'rgba(255,255,255,0.5)',
  textDim: 'rgba(255,255,255,0.3)',
  accent: PURPLE_500,
  accentLight: PURPLE_400,
  success: GREEN_400,
  error: RED_400,
  warning: AMBER_400,
  mono: "'JetBrains Mono', monospace",
  sans: "'Inter', system-ui, -apple-system, sans-serif",
} as const;

const glassCard: React.CSSProperties = {
  background: T.card,
  border: `1px solid ${T.cardBorder}`,
  borderRadius: 14,
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  padding: '20px 22px',
  transition: 'background 0.2s, border-color 0.2s',
};

// ─── Types ──────────────────────────────────────────────────────────────────

interface ActiveTab {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function StatusPill({ ok, label }: { ok: boolean; label: string }): ReactElement {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 12px',
        borderRadius: 999,
        background: ok ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)',
        border: `1px solid ${ok ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.25)'}`,
        fontSize: 12,
        fontWeight: 500,
        color: ok ? T.success : T.error,
        fontFamily: T.sans,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: ok ? T.success : T.error,
          boxShadow: `0 0 8px ${ok ? T.success : T.error}60`,
          animation: ok ? 'pulse 2s ease-in-out infinite' : 'none',
        }}
      />
      {label}
    </span>
  );
}

function MetricCard({
  label,
  value,
  unit,
  sub,
  accent,
}: {
  label: string;
  value: string;
  unit?: string | undefined;
  sub?: string | undefined;
  accent?: string | undefined;
}): ReactElement {
  return (
    <div style={{ ...glassCard, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 140 }}>
      <span style={{ fontSize: 11, color: T.textMuted, fontFamily: T.sans, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 26, fontWeight: 700, color: accent ?? T.text, fontFamily: T.mono }}>{value}</span>
        {unit && <span style={{ fontSize: 12, color: T.textMuted, fontFamily: T.mono }}>{unit}</span>}
      </div>
      {sub && <span style={{ fontSize: 11, color: T.textDim, fontFamily: T.sans }}>{sub}</span>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <h2
      style={{
        margin: 0,
        fontSize: 13,
        fontWeight: 600,
        color: T.textMuted,
        fontFamily: T.sans,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </h2>
  );
}

// Canvas wrapper that auto-sizes to its container
function ChartCanvas({
  draw,
  height,
  style,
}: {
  draw: (canvas: HTMLCanvasElement) => void;
  height: number;
  style?: React.CSSProperties;
}): ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    drawRef.current(canvas);
  });

  return (
    <canvas
      ref={ref}
      style={{ width: '100%', height, display: 'block', ...style }}
    />
  );
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

function Dashboard(): ReactElement {
  // ── State ──
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [stats, setStats] = useState<NativeStats | null>(null);
  const [browserTelemetry, setBrowserTelemetry] = useState<TelemetryEntry[]>([]);
  const [nativeTelemetry, setNativeTelemetry] = useState<NativeTelemetryEntry[]>([]);
  const [cacheSize, setCacheSize] = useState(0);
  const [activeTabs, setActiveTabs] = useState<ActiveTab[]>([]);
  const [rttHistory, setRttHistory] = useState<number[]>([]);
  const [nativeLatencyHistory, setNativeLatencyHistory] = useState<{ total: number[]; segment: number[] }>({ total: [], segment: [] });
  const [expandedSegment, setExpandedSegment] = useState<string | null>(null);
  const [uptime, setUptime] = useState(0);
  const startRef = useRef(Date.now());

  // ── Polling ──
  const poll = useCallback(() => {
    // Health
    sendToBackground({ type: 'get_health' })
      .then((res) => {
        if (res.type === 'health_result') { setHealth(res.payload); setHealthErr(null); }
        else if (res.type === 'error') setHealthErr(res.message);
      })
      .catch((e: unknown) => setHealthErr(String(e)));

    // Stats
    sendToBackground({ type: 'get_stats' })
      .then((res) => { if (res.type === 'stats_result') setStats(res.payload); })
      .catch(() => {});

    // Models
    sendToBackground({ type: 'list_models' })
      .then((res) => { if (res.type === 'models_list') setModels(res.payload); })
      .catch(() => {});

    // Cache
    sendToBackground({ type: 'get_verdict_cache_stats' })
      .then((res) => { if (res.type === 'verdict_cache_stats') setCacheSize(res.payload.size); })
      .catch(() => {});
  }, []);

  const pollTelemetry = useCallback(() => {
    // Browser telemetry
    sendToBackground({ type: 'get_telemetry' })
      .then((res) => {
        if (res.type === 'telemetry_result') {
          setBrowserTelemetry(res.payload);
          // Extract RTT values
          const rtts = res.payload
            .filter((e) => e.stage === 'browser.classify_roundtrip')
            .map((e) => e.latencyMs);
          setRttHistory((prev) => [...prev, ...rtts].slice(-200));
        }
      })
      .catch(() => {});

    // Native telemetry
    sendToBackground({ type: 'telemetry_dump' })
      .then((res) => {
        if (res.type === 'telemetry_dump_result') {
          setNativeTelemetry(res.payload);
          const totals = res.payload
            .filter((e: NativeTelemetryEntry) => e.stage === 'native.classify_total')
            .map((e: NativeTelemetryEntry) => e.latencyMs);
          const segments = res.payload
            .filter((e: NativeTelemetryEntry) => e.stage === 'native.segment_classify')
            .map((e: NativeTelemetryEntry) => e.latencyMs);
          setNativeLatencyHistory({
            total: totals.slice(-200),
            segment: segments.slice(-200),
          });
        }
      })
      .catch(() => {});
  }, []);

  const pollTabs = useCallback(() => {
    if (typeof chrome === 'undefined' || !chrome.tabs) return;
    chrome.tabs.query({}, (tabs) => {
      const supported = ['reddit.com', 'old.reddit.com', 'news.ycombinator.com', 'youtube.com', 'www.reddit.com', 'www.youtube.com'];
      const active = tabs
        .filter((t) => {
          if (!t.url) return false;
          try {
            const host = new URL(t.url).hostname;
            return supported.some((s) => host === s || host.endsWith('.' + s));
          } catch { return false; }
        })
        .map((t) => ({
          id: t.id ?? 0,
          title: t.title ?? '',
          url: t.url ?? '',
          ...(t.favIconUrl != null ? { favIconUrl: t.favIconUrl } : {}),
        }));
      setActiveTabs(active);
    });
  }, []);

  useEffect(() => {
    poll();
    pollTelemetry();
    pollTabs();

    const i1 = setInterval(() => { if (!document.hidden) { poll(); } }, 2000);
    const i2 = setInterval(() => { if (!document.hidden) { pollTelemetry(); } }, 1500);
    const i3 = setInterval(() => { if (!document.hidden) { pollTabs(); } }, 3000);
    const i4 = setInterval(() => setUptime(Math.floor((Date.now() - startRef.current) / 1000)), 1000);

    return () => { clearInterval(i1); clearInterval(i2); clearInterval(i3); clearInterval(i4); };
  }, [poll, pollTelemetry, pollTabs]);

  // ── Derived ──
  const isConnected = health != null && !healthErr;
  const rttP50 = percentile(rttHistory, 0.5);
  const rttP95 = percentile(rttHistory, 0.95);
  const rttMin = rttHistory.length > 0 ? Math.min(...rttHistory) : 0;
  const rttMax = rttHistory.length > 0 ? Math.max(...rttHistory) : 0;

  // Merge browser + native telemetry for segment log
  const segmentLog = browserTelemetry
    .filter((e) => e.stage === 'browser.classify_roundtrip')
    .slice(0, 50);

  const formatBytes = (b: number): string => {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const formatUptime = (s: number): string => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  };

  return (
    <div
      style={{
        fontFamily: T.sans,
        background: T.bg,
        minHeight: '100vh',
        color: T.text,
        padding: '24px 20px 40px',
      }}
    >
      {/* Animated pulse keyframes */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .dash-card { animation: slideIn 0.3s ease-out both; }
        .dash-card:hover { background: ${T.cardHover} !important; border-color: rgba(139,92,246,0.22) !important; }
        .seg-row { transition: background 0.15s; cursor: pointer; }
        .seg-row:hover { background: rgba(139,92,246,0.08) !important; }
        body { margin: 0; background: #0a0118; }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(139,92,246,0.2); border-radius: 3px; }
      `}</style>

      <div style={{ maxWidth: 1280, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: T.accentLight, fontFamily: T.sans }}>
              ◆ TopicBlock
            </h1>
            <span style={{ fontSize: 11, color: T.textDim, fontFamily: T.mono }}>
              LIVE MONITOR
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, color: T.textDim, fontFamily: T.mono }}>
              uptime {formatUptime(uptime)}
            </span>
            <StatusPill ok={isConnected} label={isConnected ? 'Native Connected' : 'Disconnected'} />
          </div>
        </div>

        {/* ── Top Metrics Row ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          <MetricCard
            label="Native Version"
            value={health?.version ?? '—'}
            sub={health ? `${health.device.toUpperCase()} · queue ${health.queueDepth}` : undefined}
            accent={T.accentLight}
          />
          <MetricCard
            label="Active Tabs"
            value={String(activeTabs.length)}
            sub={activeTabs.length > 0 && activeTabs[0] ? activeTabs[0].url.replace(/https?:\/\//, '').split('/')[0] : 'No supported sites'}
          />
          <MetricCard
            label="RTT p50"
            value={rttP50.toFixed(1)}
            unit="ms"
            accent={rttP50 > 200 ? T.error : rttP50 > 100 ? T.warning : T.success}
            sub={`p95: ${rttP95.toFixed(1)}ms`}
          />
          <MetricCard
            label="Segments Processed"
            value={String(browserTelemetry.filter((e) => e.stage === 'browser.classify_roundtrip').length)}
            sub={`${segmentLog.filter((e) => e.verdict?.blocked).length} blocked`}
          />
          <MetricCard
            label="CPU"
            value={stats ? stats.cpuPercent.toFixed(0) : '—'}
            unit="%"
            accent={stats && stats.cpuPercent > 80 ? T.error : stats && stats.cpuPercent > 50 ? T.warning : T.accentLight}
            sub={stats ? `PID ${stats.pid}` : undefined}
          />
          <MetricCard
            label="Memory (RSS)"
            value={stats ? formatBytes(stats.rssBytes) : '—'}
            sub={stats ? `uptime ${formatUptime(Math.floor(stats.uptimeSeconds))}` : undefined}
          />
        </div>

        {/* ── Models ── */}
        <div style={glassCard} className="dash-card">
          <SectionTitle>Active Models</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginTop: 14 }}>
            {/* Topic Model */}
            <div style={{ ...glassCard, padding: '14px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: T.accent, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Topic Model</span>
                <span style={{ fontSize: 12, color: T.success, fontFamily: T.mono, fontWeight: 500 }}>{health?.loadedTopicModel ?? '—'}</span>
              </div>
              {models.filter((m) => m.kind === 'topic').map((m) => (
                <div key={m.name} style={{ fontSize: 11, color: T.textMuted, fontFamily: T.mono, lineHeight: 1.6 }}>
                  {m.backbone} · seq {m.maxSeqLen} · thresh {m.defaultThreshold}
                  {m.hwRequirements.needsGpu && <span style={{ color: T.warning }}> · GPU</span>}
                </div>
              ))}
              {models.filter((m) => m.kind === 'topic').length === 0 && (
                <span style={{ fontSize: 11, color: T.textDim }}>{health?.loadedTopicModel ?? 'Loading…'}</span>
              )}
            </div>
            {/* Sentiment Model */}
            <div style={{ ...glassCard, padding: '14px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: T.accent, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sentiment Model</span>
                <span style={{ fontSize: 12, color: T.success, fontFamily: T.mono, fontWeight: 500 }}>{health?.loadedSentimentModel ?? '—'}</span>
              </div>
              {models.filter((m) => m.kind === 'sentiment').map((m) => (
                <div key={m.name} style={{ fontSize: 11, color: T.textMuted, fontFamily: T.mono, lineHeight: 1.6 }}>
                  {m.backbone} · seq {m.maxSeqLen} · thresh {m.defaultThreshold}
                </div>
              ))}
              {models.filter((m) => m.kind === 'sentiment').length === 0 && (
                <span style={{ fontSize: 11, color: T.textDim }}>{health?.loadedSentimentModel ?? 'Loading…'}</span>
              )}
            </div>
          </div>
        </div>

        {/* ── Charts Row ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 14 }}>
          {/* RTT Chart */}
          <div style={glassCard} className="dash-card">
            <SectionTitle>Round-Trip Latency (RTT)</SectionTitle>
            <div style={{ display: 'flex', gap: 16, margin: '10px 0 6px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: T.textMuted, fontFamily: T.mono }}>
                min <span style={{ color: T.success }}>{rttMin.toFixed(1)}</span>
              </span>
              <span style={{ fontSize: 11, color: T.textMuted, fontFamily: T.mono }}>
                p50 <span style={{ color: T.accentLight }}>{rttP50.toFixed(1)}</span>
              </span>
              <span style={{ fontSize: 11, color: T.textMuted, fontFamily: T.mono }}>
                p95 <span style={{ color: T.warning }}>{rttP95.toFixed(1)}</span>
              </span>
              <span style={{ fontSize: 11, color: T.textMuted, fontFamily: T.mono }}>
                max <span style={{ color: T.error }}>{rttMax.toFixed(1)}</span>
              </span>
            </div>
            <ChartCanvas
              height={180}
              draw={(canvas) =>
                drawLineChart(canvas, rttHistory, {
                  color: PURPLE_400,
                  unit: 'ms',
                  label: 'classify roundtrip',
                  budgetLine: 200,
                })
              }
            />
          </div>

          {/* Native pipeline breakdown */}
          <div style={glassCard} className="dash-card">
            <SectionTitle>Native Pipeline Breakdown</SectionTitle>
            <div style={{ marginTop: 16 }}>
              <ChartCanvas
                height={180}
                draw={(canvas) =>
                  drawAreaChart(
                    canvas,
                    [
                      { label: 'segment', data: nativeLatencyHistory.segment, color: PURPLE_300 },
                      { label: 'total', data: nativeLatencyHistory.total, color: PURPLE_500 },
                    ],
                    { unit: 'ms', label: 'native pipeline' },
                  )
                }
              />
            </div>
          </div>
        </div>

        {/* ── Cache & Buffer Row ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
          {/* Verdict Cache */}
          <div style={glassCard} className="dash-card">
            <SectionTitle>Verdict Cache</SectionTitle>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '12px 0 8px' }}>
              <span style={{ fontSize: 22, fontWeight: 700, fontFamily: T.mono, color: T.accentLight }}>{cacheSize.toLocaleString()}</span>
              <span style={{ fontSize: 12, color: T.textDim, fontFamily: T.mono }}>/ 5,000</span>
            </div>
            <ChartCanvas
              height={10}
              draw={(canvas) => drawBar(canvas, cacheSize, 5000)}
            />
          </div>

          {/* Native Embedding Cache */}
          <div style={glassCard} className="dash-card">
            <SectionTitle>Embedding Cache</SectionTitle>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '12px 0 8px' }}>
              <span style={{ fontSize: 22, fontWeight: 700, fontFamily: T.mono, color: T.accentLight }}>{stats?.embeddingCacheCount?.toLocaleString() ?? '—'}</span>
              <span style={{ fontSize: 12, color: T.textDim, fontFamily: T.mono }}>/ 10,000</span>
            </div>
            <ChartCanvas
              height={10}
              draw={(canvas) => drawBar(canvas, stats?.embeddingCacheCount ?? 0, 10000)}
            />
            {stats && (
              <div style={{ fontSize: 11, color: T.textDim, fontFamily: T.mono, marginTop: 8 }}>
                DB size: {formatBytes(stats.cacheDbSizeBytes)}
                {stats.topicVectorVersions.length > 0 && (
                  <span> · topic versions: [{stats.topicVectorVersions.join(', ')}]</span>
                )}
              </div>
            )}
          </div>

          {/* Browser Buffer Gauge */}
          <div style={{ ...glassCard, display: 'flex', flexDirection: 'column', alignItems: 'center' }} className="dash-card">
            <SectionTitle>Browser Buffer</SectionTitle>
            <div style={{ marginTop: 8 }}>
              <ChartCanvas
                height={120}
                style={{ width: 120 }}
                draw={(canvas) =>
                  drawGauge(canvas, browserTelemetry.length, 500, {
                    label: 'of 500',
                    formatValue: (v) => String(v),
                    size: 120,
                  })
                }
              />
            </div>
          </div>

          {/* Native Buffer Gauge */}
          <div style={{ ...glassCard, display: 'flex', flexDirection: 'column', alignItems: 'center' }} className="dash-card">
            <SectionTitle>Native Buffer</SectionTitle>
            <div style={{ marginTop: 8 }}>
              <ChartCanvas
                height={120}
                style={{ width: 120 }}
                draw={(canvas) =>
                  drawGauge(canvas, nativeTelemetry.length, 500, {
                    label: 'of 500',
                    formatValue: (v) => String(v),
                    size: 120,
                    color: AMBER_400,
                  })
                }
              />
            </div>
          </div>
        </div>

        {/* ── Active Tabs ── */}
        {activeTabs.length > 0 && (
          <div style={glassCard} className="dash-card">
            <SectionTitle>Active Tabs ({activeTabs.length})</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
              {activeTabs.map((tab) => (
                <div
                  key={tab.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: 'rgba(139,92,246,0.06)',
                    border: `1px solid ${T.cardBorder}`,
                  }}
                >
                  {tab.favIconUrl && (
                    <img
                      src={tab.favIconUrl}
                      alt=""
                      style={{ width: 16, height: 16, borderRadius: 3, flexShrink: 0 }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  )}
                  <span
                    style={{
                      fontSize: 12,
                      color: T.text,
                      fontFamily: T.sans,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}
                  >
                    {tab.title}
                  </span>
                  <span style={{ fontSize: 10, color: T.textDim, fontFamily: T.mono, flexShrink: 0 }}>
                    {(() => { try { return new URL(tab.url).hostname; } catch { return ''; } })()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Segment Traffic Log ── */}
        <div style={glassCard} className="dash-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <SectionTitle>Segment Traffic Log</SectionTitle>
            <span style={{ fontSize: 11, color: T.textDim, fontFamily: T.mono }}>
              {segmentLog.length} entries
            </span>
          </div>
          {segmentLog.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px 0', color: T.textDim, fontSize: 13 }}>
              No segments processed yet. Navigate to a supported site to see live data.
            </div>
          ) : (
            <div style={{ maxHeight: 400, overflowY: 'auto', borderRadius: 8, border: `1px solid ${T.cardBorder}` }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: T.mono }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${T.cardBorder}`, position: 'sticky', top: 0, background: '#0f0720', zIndex: 1 }}>
                    {['Segment ID', 'Text', 'Status', 'Topics', 'Latency'].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: 'left',
                          padding: '8px 10px',
                          color: T.textMuted,
                          fontWeight: 500,
                          fontSize: 10,
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {segmentLog.map((entry, i) => {
                    const v = entry.verdict;
                    const isExpanded = expandedSegment === `${entry.segmentId}-${i}`;
                    return (
                      <tr
                        key={`${entry.segmentId}-${i}`}
                        className="seg-row"
                        onClick={() => setExpandedSegment(isExpanded ? null : `${entry.segmentId}-${i}`)}
                        style={{ borderBottom: `1px solid ${T.cardBorder}` }}
                      >
                        <td style={{ padding: '7px 10px', color: T.textDim }}>{entry.segmentId.slice(0, 12)}…</td>
                        <td style={{ padding: '7px 10px', color: T.text, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: isExpanded ? 'normal' : 'nowrap', fontFamily: T.sans, fontSize: 11 }}>
                          {entry.text || '—'}
                        </td>
                        <td style={{ padding: '7px 10px' }}>
                          <span
                            style={{
                              padding: '2px 8px',
                              borderRadius: 999,
                              fontSize: 10,
                              fontWeight: 600,
                              background: v?.blocked ? 'rgba(248,113,113,0.15)' : 'rgba(52,211,153,0.15)',
                              color: v?.blocked ? T.error : T.success,
                              border: `1px solid ${v?.blocked ? 'rgba(248,113,113,0.25)' : 'rgba(52,211,153,0.25)'}`,
                            }}
                          >
                            {v?.blocked ? 'BLOCKED' : 'ALLOWED'}
                          </span>
                        </td>
                        <td style={{ padding: '7px 10px', color: T.textMuted, fontSize: 10 }}>
                          {v?.topics && v.topics.length > 0
                            ? v.topics.map((t) => `${t.label} (${t.score.toFixed(2)})`).join(', ')
                            : '—'}
                        </td>
                        <td style={{ padding: '7px 10px', color: entry.latencyMs > 200 ? T.error : entry.latencyMs > 100 ? T.warning : T.success }}>
                          {entry.latencyMs.toFixed(1)}ms
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div style={{ textAlign: 'center', fontSize: 11, color: T.textDim, fontFamily: T.sans, paddingTop: 8 }}>
          TopicBlock v{health?.version ?? '0.1.0'} · {health?.device?.toUpperCase() ?? 'CPU'} · Dashboard session {formatUptime(uptime)}
        </div>
      </div>
    </div>
  );
}

// ─── Utility ────────────────────────────────────────────────────────────────

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

// ─── Mount ──────────────────────────────────────────────────────────────────

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<Dashboard />);
}
