import type { IFilterAction, UserPreferences, Verdict } from '../../shared/protocols.js';
import { sendToBackground } from '../../shared/messaging.js';

const overlays = new WeakMap<HTMLElement, HTMLElement>();
const originalPositions = new WeakMap<HTMLElement, string>();

const CSS = `
  :host {
    position: absolute;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(16px);
    background: linear-gradient(135deg, rgba(15, 23, 42, 0.7), rgba(30, 41, 59, 0.8));
    color: #f8fafc;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    border-radius: inherit;
    transition: opacity 0.3s ease, backdrop-filter 0.3s ease;
    overflow: hidden;
  }

  .topicblock-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    padding: 24px;
    text-align: center;
    animation: fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .topicblock-icon {
    width: 32px;
    height: 32px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  }

  .topicblock-title {
    font-size: 18px;
    font-weight: 600;
    margin: 0;
    letter-spacing: -0.01em;
  }

  .topicblock-reasons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
  }

  .topicblock-reason {
    font-size: 13px;
    font-weight: 500;
    padding: 4px 12px;
    background: rgba(255, 255, 255, 0.15);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 100px;
    backdrop-filter: blur(4px);
  }

  .topicblock-button {
    margin-top: 8px;
    background: #3b82f6;
    color: white;
    border: none;
    padding: 8px 20px;
    font-size: 14px;
    font-weight: 500;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s ease;
    box-shadow: 0 4px 6px -1px rgba(59, 130, 246, 0.3);
  }

  .topicblock-button:hover {
    background: #2563eb;
    transform: translateY(-1px);
    box-shadow: 0 6px 8px -1px rgba(59, 130, 246, 0.4);
  }
  
  .topicblock-button:active {
    transform: translateY(1px);
    box-shadow: 0 2px 4px -1px rgba(59, 130, 246, 0.3);
  }
`;

export const BlurAction: IFilterAction = {
  apply(el: HTMLElement, verdict: Verdict, prefs: UserPreferences): void {
    if (overlays.has(el)) return;

    // We create the host element for the shadow DOM
    const host = document.createElement('div');
    host.setAttribute('data-topicblock-action', 'blur');
    
    // Save previous position, set position to relative so absolute inset 0 covers the element
    originalPositions.set(el, el.style.position);

    const shadow = host.attachShadow({ mode: 'open' });
    
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const container = document.createElement('div');
    container.className = 'topicblock-container';
    
    const icon = document.createElement('div');
    icon.className = 'topicblock-icon';
    icon.textContent = '🛡️';

    const title = document.createElement('h3');
    title.className = 'topicblock-title';
    title.textContent = 'Content Blocked';

    const reasonsContainer = document.createElement('div');
    reasonsContainer.className = 'topicblock-reasons';
    
    const displayReasons = verdict.reasons.slice(0, 2);
    for (const text of displayReasons) {
      const reasonEl = document.createElement('span');
      reasonEl.className = 'topicblock-reason';
      reasonEl.textContent = text;
      reasonsContainer.appendChild(reasonEl);
    }
    if (verdict.reasons.length > 2) {
      const elip = document.createElement('span');
      elip.className = 'topicblock-reason';
      elip.textContent = '+' + (verdict.reasons.length - 2);
      reasonsContainer.appendChild(elip);
    }

    const showButton = document.createElement('button');
    showButton.className = 'topicblock-button';
    showButton.textContent = 'Show anyway';
    
    showButton.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      
      // Record telemetry for override
      void sendToBackground({
        type: 'record_override',
        payload: {
          ts: Date.now(),
          stage: 'browser.user_override',
          segmentId: verdict.segmentId,
          latencyMs: 0,
          source: 'browser',
          verdict
        }
      });
      
      BlurAction.revert(el);
    });

    container.append(icon, title, reasonsContainer, showButton);
    shadow.appendChild(container);

    if (prefs.hoverToReveal) {
      let hoverTimer: number | null = null;
      
      host.addEventListener('mouseenter', () => {
        hoverTimer = window.setTimeout(() => {
          host.style.opacity = '0';
          host.style.backdropFilter = 'none';
          host.style.pointerEvents = 'none';
        }, 300);
      });
      
      el.addEventListener('mouseleave', () => {
        if (hoverTimer) window.clearTimeout(hoverTimer);
        host.style.opacity = '1';
        host.style.backdropFilter = 'blur(16px)';
        host.style.pointerEvents = 'auto';
      });
    }

    overlays.set(el, host);

    requestAnimationFrame(() => {
      const currentPos = window.getComputedStyle(el).position;
      if (currentPos === 'static') {
        el.style.position = 'relative';
      }
      el.appendChild(host);
    });
  },

  revert(el: HTMLElement): void {
    const overlay = overlays.get(el);
    if (!overlay) return;

    requestAnimationFrame(() => {
      overlay.remove();
      const pos = originalPositions.get(el);
      if (pos !== undefined) {
        el.style.position = pos;
      }
    });

    overlays.delete(el);
    originalPositions.delete(el);
  }
};
