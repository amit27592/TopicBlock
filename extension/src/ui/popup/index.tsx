import { type ReactElement, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HealthStatus } from '../../shared/protocols.js';
import type { ExtMessage, ExtResponse } from '../../shared/messaging.js';

function Popup(): ReactElement {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const msg: ExtMessage = { type: 'get_health' };
    chrome.runtime.sendMessage(msg, (res: ExtResponse) => {
      if (res.type === 'health_result') {
        setHealth(res.payload);
      } else if (res.type === 'error') {
        setError(res.message);
      }
    });
  }, []);

  return (
    <div style={{ padding: '12px' }}>
      <h2 style={{ margin: '0 0 8px' }}>TopicBlock</h2>
      {error && <p style={{ color: 'red' }}>Native component offline: {error}</p>}
      {health && (
        <p style={{ color: 'green' }}>
          Native v{health.version} · {health.device}
        </p>
      )}
      {!health && !error && <p>Connecting…</p>}
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<Popup />);
}
