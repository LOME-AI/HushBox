import { PROVIDER_MAP } from '@hushbox/shared';
import { catalogModels } from './catalog-models';
import type { Model } from '@hushbox/shared';

const PRIORITY_PROVIDERS = ['OpenAI', 'Anthropic', 'Google', 'Meta', 'DeepSeek', 'Mistral'];

export function extractProviders(models: Model[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const m of catalogModels(models)) {
    // A catalog served before a slug joined the map still carries the raw slug as the provider.
    const provider = PROVIDER_MAP[m.provider] ?? m.provider;
    const key = provider.toLowerCase();
    if (key === 'unknown' || seen.has(key)) continue;
    seen.add(key);
    unique.push(provider);
  }

  const priority = PRIORITY_PROVIDERS.filter((p) => unique.includes(p));
  const rest = unique
    .filter((p) => !PRIORITY_PROVIDERS.includes(p))
    .toSorted((a, b) => a.localeCompare(b));

  return [...priority, ...rest];
}
