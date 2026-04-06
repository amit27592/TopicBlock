import { type ReactElement, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HealthStatus } from '../../shared/protocols.js';
import { sendToBackground } from '../../shared/messaging.js';
import { type BlockedItem, getAll as getBlockedItems } from '../../storage/blockedItems.js';

const PAUSED_KEY = 'topicblock_paused';
const RECENT_COUNT = 5;

const C = {
  primary: '#6d28d9',
  bg: '#faf5ff',
  border: '#e5e7eb',
  text: '#111827',
  muted: '#6b7280',
  success: '#10b981',
  warning: '#f59e0b',
  error: '#ef4444',
} as const;

function StatusDot({ ok }: { ok: boolean }): ReactElement {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: ok ? C.success : C.error,
        marginRight: 5,
        flexShrink: 0,
      }}
    />
  );
}

function relativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function Popup(): ReactElement {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [blockedItems, setBlockedItems] = useState<BlockedItem[]>([]);
  const [currentSite, setCurrentSite] = useState<string | null>(null);

  useEffect(() => {
    // Health check
    sendToBackground({ type: 'get_health' })
      .then((res) => {
        if (res.type === 'health_result') setHealth(res.payload);
        else if (res.type === 'error') setHealthError(res.message);
      })
      .catch((err: unknown) => setHealthError(String(err)));

    // Paused state
    void chrome.storage.local
      .get(PAUSED_KEY)
      .then((r) => setPaused((r[PAUSED_KEY] as boolean | undefined) ?? false));

    // Recent blocked items
    void getBlockedItems().then((items) => setBlockedItems(items.slice(0, RECENT_COUNT)));

    // Current tab URL
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        const url = tabs[0]?.url;
        if (url) {
          try {
            setCurrentSite(new URL(url).hostname);
          } catch {
            setCurrentSite(null);
          }
        }
      });
  }, []);

  async function togglePause(): Promise<void> {
    const next = !paused;
    setPaused(next);
    await chrome.storage.local.set({ [PAUSED_KEY]: next });
  }

  return (
    <div
      style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        background: C.bg,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: C.primary }}>TopicBlock</span>
        <button
          onClick={() => void togglePause()}
          style={{
            padding: '4px 12px',
            borderRadius: 999,
            border: `1px solid ${paused ? C.warning : C.border}`,
            background: paused ? '#fef3c7' : 'white',
            color: paused ? '#92400e' : C.text,
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          {paused ? 'Paused — Resume' : 'Pause'}
        </button>
      </div>

      {/* Native connection */}
      <div
        style={{
          padding: '8px 12px',
          borderRadius: 8,
          border: `1px solid ${C.border}`,
          background: 'white',
          fontSize: 13,
        }}
      >
        {healthError ? (
          <span style={{ display: 'flex', alignItems: 'center' }}>
            <StatusDot ok={false} />
            <span style={{ color: C.error }}>Native component offline</span>
          </span>
        ) : health ? (
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center' }}>
              <StatusDot ok={health.ok} />
              <span style={{ color: C.text }}>
                Native v{health.version}
              </span>
            </span>
            <span style={{ color: C.muted }}>
              {health.device} · queue {health.queueDepth}
            </span>
          </span>
        ) : (
          <span style={{ display: 'flex', alignItems: 'center' }}>
            <StatusDot ok={false} />
            <span style={{ color: C.muted }}>Connecting…</span>
          </span>
        )}
      </div>

      {/* Current site */}
      {currentSite && (
        <div style={{ fontSize: 12, color: C.muted, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: paused ? C.warning : C.success,
              display: 'inline-block',
              flexShrink: 0,
            }}
          />
          <span>
            <strong style={{ color: C.text }}>{currentSite}</strong>{' '}
            {paused ? '— filtering paused' : '— filtering active'}
          </span>
        </div>
      )}

      {/* Recent blocked items */}
      <div>
        <p style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 600, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Recently blocked
        </p>
        {blockedItems.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: C.muted }}>Nothing blocked yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {blockedItems.map((item) => (
              <div
                key={`${item.segmentId}-${item.ts}`}
                style={{
                  padding: '6px 10px',
                  background: 'white',
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      color: C.text,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}
                  >
                    {item.headline ?? item.segmentId.slice(0, 20) + '…'}
                  </span>
                  <span style={{ color: C.muted, flexShrink: 0 }}>{relativeTime(item.ts)}</span>
                </div>
                <div style={{ color: C.muted, marginTop: 2 }}>
                  {item.site} · {item.reasons.join(', ')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
        <button
          onClick={() => { void chrome.runtime.openOptionsPage(); }}
          style={{
            width: '100%',
            padding: '7px 0',
            background: C.primary,
            color: 'white',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          Open Settings
        </button>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<Popup />);
}
