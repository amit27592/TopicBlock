/**
 * Named preference presets.
 * "Sane Defaults" is the baseline shipped with the extension.
 */

import type { UserPreferences } from '../shared/protocols.js';

export interface Preset {
  id: string;
  name: string;
  description: string;
  prefs: UserPreferences;
}

export const PRESETS: Preset[] = [
  {
    id: 'sane_defaults',
    name: 'Sane Defaults',
    description: 'Balanced — blur matched content, hover to reveal. Sentiment off.',
    prefs: {
      bannedTopics: [],
      topicThreshold: 0.5,
      sentimentThreshold: -0.6,
      sentimentEnabled: false,
      topicModel: 'minilm-l6-v2',
      sentimentModel: 'vader',
      action: 'blur',
      hoverToReveal: true,
      perSiteOverrides: {},
    },
  },
  {
    id: 'strict',
    name: 'Strict',
    description: 'Lower threshold — catches more matches. Hides content. Sentiment on.',
    prefs: {
      bannedTopics: [],
      topicThreshold: 0.35,
      sentimentThreshold: -0.4,
      sentimentEnabled: true,
      topicModel: 'minilm-l6-v2',
      sentimentModel: 'vader',
      action: 'hide',
      hoverToReveal: false,
      perSiteOverrides: {},
    },
  },
  {
    id: 'lenient',
    name: 'Lenient',
    description: 'Higher threshold — only very strong matches filtered.',
    prefs: {
      bannedTopics: [],
      topicThreshold: 0.7,
      sentimentThreshold: -0.8,
      sentimentEnabled: false,
      topicModel: 'minilm-l6-v2',
      sentimentModel: 'vader',
      action: 'blur',
      hoverToReveal: true,
      perSiteOverrides: {},
    },
  },
];
