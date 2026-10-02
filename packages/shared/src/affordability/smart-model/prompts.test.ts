import { describe, expect, it } from 'vitest';

import { effortDomainOptions } from '../dimensions/effort.ts';
import {
  buildClassifierSystemPrompt,
  CLASSIFIER_EFFORT_DIMENSION_MARKER,
  CLASSIFIER_MAX_DESCRIPTION_CHARS,
  CLASSIFIER_MODEL_DIMENSION_MARKER,
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  computeClassifierPromptOverhead,
} from './prompts.ts';

const MODELS = [
  {
    id: 'anthropic/claude-opus-4.6',
    description: 'Most capable model for complex reasoning and coding.',
  },
  { id: 'openai/gpt-5-nano', description: 'Cheap and fast.' },
];

describe('buildClassifierSystemPrompt', () => {
  it('contains the classifier marker', () => {
    expect(buildClassifierSystemPrompt({ eligibleModels: MODELS })).toContain(
      CLASSIFIER_SYSTEM_PROMPT_MARKER
    );
  });

  it('lists every eligible model', () => {
    const prompt = buildClassifierSystemPrompt({ eligibleModels: MODELS });
    expect(prompt).toContain('anthropic/claude-opus-4.6');
    expect(prompt).toContain('Most capable model for complex reasoning and coding.');
    expect(prompt).toContain('openai/gpt-5-nano');
    expect(prompt).toContain('Cheap and fast.');
  });

  it('annotates each candidate with its own effort ceiling', () => {
    const prompt = buildClassifierSystemPrompt({
      eligibleModels: [
        { id: 'model-a', description: 'Balanced generalist.', effortCeiling: 'High' },
        { id: 'model-b', description: 'Deep reasoning.', effortCeiling: 'Max' },
        { id: 'model-c', description: 'Cheap and fast.', effortCeiling: 'Mid' },
      ],
      classifyEffort: true,
    });
    expect(prompt).toContain('- model-a — up to High — Balanced generalist.');
    expect(prompt).toContain('- model-b — up to Max — Deep reasoning.');
    expect(prompt).toContain('- model-c — up to Mid — Cheap and fast.');
  });

  it('says what a ceiling means once a candidate carries one', () => {
    const annotated = buildClassifierSystemPrompt({
      eligibleModels: [{ id: 'model-a', description: 'Balanced.', effortCeiling: 'High' }],
      classifyEffort: true,
    });
    expect(annotated).toContain('highest effort level it can afford');
  });

  it('leaves a candidate carrying no ceiling unannotated', () => {
    const prompt = buildClassifierSystemPrompt({ eligibleModels: MODELS, classifyEffort: true });
    expect(prompt).toContain('- openai/gpt-5-nano — Cheap and fast.');
    expect(prompt).not.toContain('up to');
  });

  it('truncates very long descriptions', () => {
    const longDesc = 'A'.repeat(CLASSIFIER_MAX_DESCRIPTION_CHARS * 2);
    const prompt = buildClassifierSystemPrompt({
      eligibleModels: [{ id: 'foo/bar', description: longDesc }],
    });
    // Description rendered no longer than the cap.
    const renderedSegment = prompt.split('foo/bar')[1] ?? '';
    expect(renderedSegment.length).toBeLessThanOrEqual(CLASSIFIER_MAX_DESCRIPTION_CHARS + 16);
  });

  it('instructs the model dimension`s labelled answer line, naming a model id', () => {
    const prompt = buildClassifierSystemPrompt({ eligibleModels: MODELS });
    expect(prompt).toContain('Answer on its own line as `model: <choice>`');
    expect(prompt.toLowerCase()).toContain('model id from the list');
  });

  it('handles an empty eligible list without crashing', () => {
    expect(buildClassifierSystemPrompt({ eligibleModels: [] }).length).toBeGreaterThan(0);
  });
});

describe('buildClassifierSystemPrompt — dimension composition', () => {
  it('tags the model dimension with its marker on the marker line', () => {
    const firstLine = buildClassifierSystemPrompt({ eligibleModels: MODELS }).split('\n')[0] ?? '';
    expect(firstLine).toContain(CLASSIFIER_SYSTEM_PROMPT_MARKER);
    expect(firstLine).toContain(CLASSIFIER_MODEL_DIMENSION_MARKER);
    expect(firstLine).not.toContain(CLASSIFIER_EFFORT_DIMENSION_MARKER);
  });

  it('renders an effort-only prompt: marker + effort section, no model list', () => {
    const prompt = buildClassifierSystemPrompt({ classifyEffort: true });
    const firstLine = prompt.split('\n')[0] ?? '';
    expect(firstLine).toContain(CLASSIFIER_SYSTEM_PROMPT_MARKER);
    expect(firstLine).toContain(CLASSIFIER_EFFORT_DIMENSION_MARKER);
    expect(firstLine).not.toContain(CLASSIFIER_MODEL_DIMENSION_MARKER);
    expect(prompt).not.toContain('Available models:');
  });

  it('presents the effort options the registry declares, in the user`s own labels', () => {
    const prompt = buildClassifierSystemPrompt({ classifyEffort: true });
    expect(prompt).toContain('Choose exactly one of: Min | Lite | Low | Mid | High | Max');
  });

  it('names the effort dimension`s own answer line, so a new dimension cannot break it', () => {
    const prompt = buildClassifierSystemPrompt({ classifyEffort: true });
    expect(prompt).toContain('Answer on its own line as `effort: <choice>`');
  });

  it('labels the model answer line too, so both dimensions read by label not position', () => {
    const prompt = buildClassifierSystemPrompt({ eligibleModels: MODELS, classifyEffort: true });
    expect(prompt).toContain('model: <choice>');
    expect(prompt).toContain('effort: <choice>');
  });

  it('renders both dimensions in one prompt', () => {
    const prompt = buildClassifierSystemPrompt({ eligibleModels: MODELS, classifyEffort: true });
    const firstLine = prompt.split('\n')[0] ?? '';
    expect(firstLine).toContain(CLASSIFIER_MODEL_DIMENSION_MARKER);
    expect(firstLine).toContain(CLASSIFIER_EFFORT_DIMENSION_MARKER);
    expect(prompt).toContain('Available models:');
    expect(prompt).toContain('Choose exactly one of: Min | Lite | Low | Mid | High | Max');
  });

  it('keeps the base marker as the prompt prefix in every composition (mock detection contract)', () => {
    const compositions = [
      { eligibleModels: MODELS },
      { classifyEffort: true as const },
      { eligibleModels: MODELS, classifyEffort: true as const },
    ];
    for (const input of compositions) {
      expect(buildClassifierSystemPrompt(input).startsWith(CLASSIFIER_SYSTEM_PROMPT_MARKER)).toBe(
        true
      );
    }
  });
});

describe('computeClassifierPromptOverhead', () => {
  const IDS = MODELS.map((model) => ({ id: model.id }));
  /** The longest ceiling a render can emit — read off the axis, as the reserve does. */
  const LONGEST_CEILING =
    effortDomainOptions()
      .map((option) => option.label)
      .toSorted((left, right) => right.length - left.length)[0] ?? '';

  it('returns a positive integer for a non-empty model list', () => {
    const overhead = computeClassifierPromptOverhead(IDS);
    expect(overhead).toBeGreaterThan(0);
    expect(Number.isInteger(overhead)).toBe(true);
  });

  it('is an upper bound on every single-dimension prompt render', () => {
    const overhead = computeClassifierPromptOverhead(IDS);
    const modelOnly = buildClassifierSystemPrompt({ eligibleModels: MODELS });
    const effortOnly = buildClassifierSystemPrompt({ classifyEffort: true });
    for (const prompt of [modelOnly, effortOnly]) {
      expect(overhead).toBeGreaterThanOrEqual(prompt.length);
    }
  });

  it('grows with the number of eligible models', () => {
    const small = computeClassifierPromptOverhead(IDS.slice(0, 1));
    const large = computeClassifierPromptOverhead([...IDS, { id: 'extra/m' }, { id: 'extra/n' }]);
    expect(large).toBeGreaterThan(small);
  });

  /**
   * The reserve's whole job is to be an upper bound BY CONSTRUCTION, not by
   * measurement: the money layer never sees a catalog description, so it prices
   * the description leg at the declared maximum a render can emit. Any real
   * description — empty, short, or far over the cap — therefore renders no
   * longer than what was priced.
   */
  it('bounds a render carrying ANY real description, at the declared maximum', () => {
    const descriptions = [
      '',
      'Cheap and fast.',
      'X'.repeat(CLASSIFIER_MAX_DESCRIPTION_CHARS - 1),
      'X'.repeat(CLASSIFIER_MAX_DESCRIPTION_CHARS),
      'X'.repeat(CLASSIFIER_MAX_DESCRIPTION_CHARS * 50),
    ];
    for (const description of descriptions) {
      const eligibleModels = IDS.map((model) => ({ ...model, description }));
      const rendered = buildClassifierSystemPrompt({ eligibleModels, classifyEffort: true });
      expect(computeClassifierPromptOverhead(IDS)).toBeGreaterThanOrEqual(rendered.length);
    }
  });

  /**
   * The same by-construction bound for the ceiling annotation: the money layer
   * is handed ids, never rungs, so it prices the annotation leg at the longest
   * label the axis declares. Every real ceiling is one of those labels.
   */
  it('bounds a render carrying ANY effort ceiling the axis declares', () => {
    for (const option of effortDomainOptions()) {
      const eligibleModels = IDS.map((model) => ({
        ...model,
        description: 'X'.repeat(CLASSIFIER_MAX_DESCRIPTION_CHARS),
        effortCeiling: option.label,
      }));
      const rendered = buildClassifierSystemPrompt({ eligibleModels, classifyEffort: true });
      expect(computeClassifierPromptOverhead(IDS)).toBeGreaterThanOrEqual(rendered.length);
    }
  });

  it('is independent of the descriptions, because it does not take them', () => {
    const overhead = computeClassifierPromptOverhead([{ id: 'long/desc' }]);
    const atCap = buildClassifierSystemPrompt({
      eligibleModels: [
        {
          id: 'long/desc',
          description: 'X'.repeat(CLASSIFIER_MAX_DESCRIPTION_CHARS),
          effortCeiling: LONGEST_CEILING,
        },
      ],
      classifyEffort: true,
    });
    expect(overhead).toBe(atCap.length);
  });
});
