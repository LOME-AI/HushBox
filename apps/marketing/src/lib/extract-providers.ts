import type { Model } from '@hushbox/shared';

const PRIORITY_PROVIDERS = ['OpenAI', 'Anthropic', 'Google', 'Meta', 'DeepSeek', 'Mistral'];

export function extractProviders(models: Model[]): string[] {
  const unique = [...new Set(models.map((m) => m.provider))];

  const priority = PRIORITY_PROVIDERS.filter((p) => unique.includes(p));
  const rest = unique
    .filter((p) => !PRIORITY_PROVIDERS.includes(p))
    .toSorted((a, b) => a.localeCompare(b));

  return [...priority, ...rest];
}
