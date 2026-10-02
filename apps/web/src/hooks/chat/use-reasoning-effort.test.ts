// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { SMART_MODEL_ID } from '@hushbox/shared';
import {
  effectiveReasoningSelection,
  useReasoningEffort,
  type EffortModel,
} from '@/hooks/chat/use-reasoning-effort';
import { useReasoningEffortStore } from '@/stores/reasoning-effort';

const { mockUseModels } = vi.hoisted(() => ({
  mockUseModels: vi.fn(() => ({ data: undefined as { models: EffortModel[] } | undefined })),
}));

vi.mock('@/hooks/models/models', () => ({
  useModels: mockUseModels,
}));

const { modelStoreState } = vi.hoisted(() => ({
  modelStoreState: {
    current: {
      activeModality: 'text' as string,
      selections: { text: [{ id: 'reasoner' }], image: [], audio: [], video: [] } as Record<
        string,
        { id: string }[]
      >,
    },
  },
}));

vi.mock('@/stores/model', () => ({
  useModelStore: (selector: (s: unknown) => unknown) => selector(modelStoreState.current),
}));

/** Effort-native model enumerating (descending) high/medium/low. */
const effortModel: EffortModel = {
  id: 'reasoner',
  contextLength: 200_000,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

const mandatoryModel: EffortModel = {
  id: 'mandatory-reasoner',
  contextLength: 200_000,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
};

const plainModel: EffortModel = { id: 'plain', contextLength: 8192 };

/** Two-rung vocabulary (descending) -> ladder [low, high]: nothing on it reaches Max. */
const twoRungModel: EffortModel = {
  id: 'two-rung',
  contextLength: 200_000,
  reasoning: { supportedEfforts: ['xhigh', 'xlow'] },
};

/** The slot sentinel as the catalog carries it. */
const smartSlotRow: EffortModel = { id: SMART_MODEL_ID, contextLength: 0 };

/** Every value the hook produced, in render order. */
function rendersOf(): readonly (string | undefined)[] {
  const seen: (string | undefined)[] = [];
  renderHook(() => {
    seen.push(useReasoningEffort().effective);
  });
  return seen;
}

describe('effectiveReasoningSelection', () => {
  it('returns the preferred level when every model offers it', () => {
    expect(
      effectiveReasoningSelection({ preferred: 'high', models: [effortModel], modality: 'text' })
    ).toBe('high');
  });

  it('lowers an unoffered level to the nearest rung the selection does offer', () => {
    expect(
      effectiveReasoningSelection({ preferred: 'max', models: [effortModel], modality: 'text' })
    ).toBe('high');
  });

  it('passes auto through on a reasoning-capable selection', () => {
    expect(
      effectiveReasoningSelection({ preferred: 'auto', models: [effortModel], modality: 'text' })
    ).toBe('auto');
  });

  it('keeps none when no selected model is mandatory', () => {
    expect(
      effectiveReasoningSelection({ preferred: 'off', models: [effortModel], modality: 'text' })
    ).toBe('off');
  });

  it('clamps none to auto when a selected model has mandatory reasoning', () => {
    expect(
      effectiveReasoningSelection({
        preferred: 'off',
        models: [mandatoryModel],
        modality: 'text',
      })
    ).toBe('auto');
  });

  it('is undefined on a non-text modality', () => {
    expect(
      effectiveReasoningSelection({ preferred: 'high', models: [effortModel], modality: 'image' })
    ).toBeUndefined();
  });

  it('sends auto when the Smart Model sentinel is selected', () => {
    expect(
      effectiveReasoningSelection({
        preferred: 'auto',
        models: [{ id: SMART_MODEL_ID, contextLength: 0 }],
        modality: 'text',
      })
    ).toBe('auto');
  });

  it('keeps an explicit level when the Smart Model sentinel is the only selection', () => {
    expect(
      effectiveReasoningSelection({
        preferred: 'high',
        models: [{ id: SMART_MODEL_ID, contextLength: 0 }],
        modality: 'text',
      })
    ).toBe('high');
  });

  it('keeps off when the Smart Model sentinel is the only selection', () => {
    expect(
      effectiveReasoningSelection({
        preferred: 'off',
        models: [{ id: SMART_MODEL_ID, contextLength: 0 }],
        modality: 'text',
      })
    ).toBe('off');
  });

  it('sends the pin when the Smart Model sentinel joins a pinned model offering it', () => {
    expect(
      effectiveReasoningSelection({
        preferred: 'high',
        models: [effortModel, { id: SMART_MODEL_ID, contextLength: 0 }],
        modality: 'text',
      })
    ).toBe('high');
  });

  it('sends the pin when the Smart Model sentinel joins a pinned model that cannot reason', () => {
    // The sentinel is an answer source with a ladder in potential: the server
    // derives its candidates at the pin, and the ladderless sibling runs
    // wire-silent beside it. Substituting auto here snapped the chip back to
    // Auto on a rung the menu had enabled.
    expect(
      effectiveReasoningSelection({
        preferred: 'high',
        models: [plainModel, { id: SMART_MODEL_ID, contextLength: 0 }],
        modality: 'text',
      })
    ).toBe('high');
  });

  it('is undefined when any selected model lacks offered levels', () => {
    expect(
      effectiveReasoningSelection({ preferred: 'auto', models: [plainModel], modality: 'text' })
    ).toBeUndefined();
  });

  it('is undefined while the selection is unresolved', () => {
    expect(
      effectiveReasoningSelection({ preferred: 'auto', models: undefined, modality: 'text' })
    ).toBeUndefined();
  });
});

describe('useReasoningEffort', () => {
  beforeEach(() => {
    useReasoningEffortStore.setState({
      preferredReasoningEffort: 'auto',
      enabledEffortChoices: undefined,
    });
    modelStoreState.current = {
      activeModality: 'text',
      selections: { text: [{ id: 'reasoner' }], image: [], audio: [], video: [] },
    };
    mockUseModels.mockReturnValue({ data: { models: [effortModel] } });
  });

  it('resolves the effective selection from the catalog rows of the selected models', () => {
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'medium' });
    const { result } = renderHook(() => useReasoningEffort());
    expect(result.current.effective).toBe('medium');
  });

  it('resolves the Smart Model selection to the pinned level the send will carry', () => {
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'medium' });
    modelStoreState.current = {
      activeModality: 'text',
      selections: { text: [{ id: SMART_MODEL_ID }], image: [], audio: [], video: [] },
    };
    // The catalog carries a candidate beside the sentinel, because a slot the
    // classifier has nothing to resolve to is not a slot the picker can draw.
    mockUseModels.mockReturnValue({ data: { models: [smartSlotRow, effortModel] } });
    const { result } = renderHook(() => useReasoningEffort());
    expect(result.current.effective).toBe('medium');
  });

  it('is undefined while the catalog has not loaded', () => {
    mockUseModels.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useReasoningEffort());
    expect(result.current.effective).toBeUndefined();
  });

  it('is undefined while a selected model is absent from the loaded catalog', () => {
    // A partially resolved selection is still unresolved: grading a turn from
    // the rows that happen to have arrived would answer for a narrower turn
    // than the one selected.
    mockUseModels.mockReturnValue({ data: { models: [] } });
    const { result } = renderHook(() => useReasoningEffort());
    expect(result.current.models).toBeUndefined();
    expect(result.current.effective).toBeUndefined();
  });

  it('is undefined when the active modality selection is empty', () => {
    modelStoreState.current = {
      activeModality: 'audio',
      selections: { text: [], image: [], audio: [], video: [] },
    };
    const { result } = renderHook(() => useReasoningEffort());
    expect(result.current.effective).toBeUndefined();
  });

  it('lowers a preference the graded set disables to the nearest enabled rung below', () => {
    useReasoningEffortStore.setState({
      preferredReasoningEffort: 'high',
      enabledEffortChoices: ['low', 'medium'],
    });
    const { result } = renderHook(() => useReasoningEffort());
    expect(result.current.effective).toBe('medium');
  });

  it('leaves the persisted preference untouched while it is lowered', () => {
    useReasoningEffortStore.setState({
      preferredReasoningEffort: 'high',
      enabledEffortChoices: ['low', 'medium'],
    });
    renderHook(() => useReasoningEffort());
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('high');
  });

  it('returns to the stored level once the graded set enables it again', () => {
    useReasoningEffortStore.setState({
      preferredReasoningEffort: 'high',
      enabledEffortChoices: ['low', 'medium'],
    });
    const { result, rerender } = renderHook(() => useReasoningEffort());
    expect(result.current.effective).toBe('medium');

    act(() => {
      useReasoningEffortStore.setState({ enabledEffortChoices: ['low', 'medium', 'high'] });
    });
    rerender();
    expect(result.current.effective).toBe('high');
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('high');
  });

  it('does not lower while no graded set has been published', () => {
    useReasoningEffortStore.setState({
      preferredReasoningEffort: 'high',
      enabledEffortChoices: undefined,
    });
    const { result } = renderHook(() => useReasoningEffort());
    expect(result.current.effective).toBe('high');
  });

  it('clamps a slot-only turn to the rungs its candidates offer before any graded set is published', () => {
    useReasoningEffortStore.setState({
      preferredReasoningEffort: 'max',
      enabledEffortChoices: undefined,
    });
    modelStoreState.current = {
      activeModality: 'text',
      selections: { text: [{ id: SMART_MODEL_ID }], image: [], audio: [], video: [] },
    };
    mockUseModels.mockReturnValue({
      data: { models: [smartSlotRow, effortModel, twoRungModel] },
    });
    const { result } = renderHook(() => useReasoningEffort());
    expect(result.current.effective).toBe('high');
  });

  it('holds no unservable rung on the first render of a slot-drawn turn', () => {
    useReasoningEffortStore.setState({
      preferredReasoningEffort: 'max',
      enabledEffortChoices: undefined,
    });
    modelStoreState.current = {
      activeModality: 'text',
      selections: { text: [{ id: SMART_MODEL_ID }], image: [], audio: [], video: [] },
    };
    mockUseModels.mockReturnValue({
      data: { models: [smartSlotRow, effortModel, twoRungModel] },
    });
    expect(rendersOf()[0]).toBe('high');
  });

  it('holds no unservable rung on the first render of an all-pinned turn', () => {
    useReasoningEffortStore.setState({
      preferredReasoningEffort: 'max',
      enabledEffortChoices: undefined,
    });
    mockUseModels.mockReturnValue({ data: { models: [effortModel] } });
    expect(rendersOf()[0]).toBe('high');
  });

  it('setSelection writes the persisted preference', () => {
    const { result } = renderHook(() => useReasoningEffort());
    act(() => {
      result.current.setSelection('low');
    });
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('low');
  });
});
