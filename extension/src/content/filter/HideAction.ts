import type { IFilterAction, UserPreferences, Verdict } from '../../shared/protocols.js';

const stateMap = new WeakMap<HTMLElement, { visibility: string; opacity: string; pointerEvents: string }>();

export const HideAction: IFilterAction = {
  apply(el: HTMLElement, verdict: Verdict, prefs: UserPreferences): void {
    if (stateMap.has(el)) return;
    stateMap.set(el, {
      visibility: el.style.visibility,
      opacity: el.style.opacity,
      pointerEvents: el.style.pointerEvents,
    });
    
    requestAnimationFrame(() => {
      el.style.visibility = 'hidden';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      el.setAttribute('data-topicblock-action', 'hide');
    });
  },

  revert(el: HTMLElement): void {
    const state = stateMap.get(el);
    if (!state) return;
    
    requestAnimationFrame(() => {
      el.style.visibility = state.visibility;
      el.style.opacity = state.opacity;
      el.style.pointerEvents = state.pointerEvents;
      el.removeAttribute('data-topicblock-action');
    });
    stateMap.delete(el);
  }
};
