import type { IFilterAction, UserPreferences, Verdict } from '../../shared/protocols.js';

const displayStateMap = new WeakMap<HTMLElement, string>();

export const RemoveAction: IFilterAction = {
  apply(el: HTMLElement, _verdict: Verdict, _prefs: UserPreferences): void {
    if (displayStateMap.has(el)) return;
    displayStateMap.set(el, el.style.display);
    
    requestAnimationFrame(() => {
      el.style.display = 'none';
      el.setAttribute('data-topicblock-action', 'remove');
    });
  },

  revert(el: HTMLElement): void {
    const originalDisplay = displayStateMap.get(el);
    if (originalDisplay === undefined) return;
    
    requestAnimationFrame(() => {
      el.style.display = originalDisplay;
      el.removeAttribute('data-topicblock-action');
    });
    displayStateMap.delete(el);
  }
};
