import { describe, it, expect, beforeEach } from 'vitest';
import { SMART_MODEL_ID, MAX_SELECTED_MODELS } from '@hushbox/shared';
import { useModelStore, DEFAULT_MODEL_ID, DEFAULT_MODEL_NAME } from './model';
import type { SelectedModelEntry } from './model';

const defaultEntry: SelectedModelEntry = { id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_NAME };

function resetStore(): void {
  useModelStore.setState({
    selectedModels: [defaultEntry],
  });
}

describe('useModelStore', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('defaults', () => {
    it('exports default model id as the Smart Model', () => {
      expect(DEFAULT_MODEL_ID).toBe(SMART_MODEL_ID);
    });

    it('exports default model name as Smart Model', () => {
      expect(DEFAULT_MODEL_NAME).toBe('Smart Model');
    });

    it('has default selectedModels with one entry', () => {
      const { selectedModels } = useModelStore.getState();
      expect(selectedModels).toEqual([defaultEntry]);
    });
  });

  describe('setSelectedModel', () => {
    it('replaces array with a single model', () => {
      useModelStore.getState().setSelectedModel('anthropic/claude-3.5-sonnet', 'Claude 3.5 Sonnet');
      const { selectedModels } = useModelStore.getState();
      expect(selectedModels).toEqual([
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      ]);
    });

    it('replaces multiple models with a single model', () => {
      useModelStore.setState({
        selectedModels: [
          { id: 'model-a', name: 'Model A' },
          { id: 'model-b', name: 'Model B' },
        ],
      });
      useModelStore.getState().setSelectedModel('model-c', 'Model C');
      expect(useModelStore.getState().selectedModels).toEqual([{ id: 'model-c', name: 'Model C' }]);
    });
  });

  describe('toggleModel', () => {
    it('adds a model when not present', () => {
      useModelStore.getState().toggleModel('model-b', 'Model B');
      const { selectedModels } = useModelStore.getState();
      expect(selectedModels).toHaveLength(2);
      expect(selectedModels[1]).toEqual({ id: 'model-b', name: 'Model B' });
    });

    it('removes a model when already present and more than 1 selected', () => {
      useModelStore.setState({
        selectedModels: [
          { id: 'model-a', name: 'Model A' },
          { id: 'model-b', name: 'Model B' },
        ],
      });
      useModelStore.getState().toggleModel('model-b', 'Model B');
      expect(useModelStore.getState().selectedModels).toEqual([{ id: 'model-a', name: 'Model A' }]);
    });

    it('does not remove the last model', () => {
      useModelStore.getState().toggleModel(DEFAULT_MODEL_ID, DEFAULT_MODEL_NAME);
      const { selectedModels } = useModelStore.getState();
      expect(selectedModels).toHaveLength(1);
      expect(selectedModels[0]).toEqual(defaultEntry);
    });

    it('does not add beyond MAX_SELECTED_MODELS', () => {
      const models: SelectedModelEntry[] = Array.from(
        { length: MAX_SELECTED_MODELS },
        (_, index) => ({
          id: `model-${String(index)}`,
          name: `Model ${String(index)}`,
        })
      );
      useModelStore.setState({ selectedModels: models });

      useModelStore.getState().toggleModel('model-extra', 'Extra Model');
      expect(useModelStore.getState().selectedModels).toHaveLength(MAX_SELECTED_MODELS);
    });

    it('allows toggling off when at MAX_SELECTED_MODELS', () => {
      const models: SelectedModelEntry[] = Array.from(
        { length: MAX_SELECTED_MODELS },
        (_, index) => ({
          id: `model-${String(index)}`,
          name: `Model ${String(index)}`,
        })
      );
      useModelStore.setState({ selectedModels: models });

      useModelStore.getState().toggleModel('model-2', 'Model 2');
      expect(useModelStore.getState().selectedModels).toHaveLength(MAX_SELECTED_MODELS - 1);
    });
  });

  describe('removeModel', () => {
    it('removes a model from the list', () => {
      useModelStore.setState({
        selectedModels: [
          { id: 'model-a', name: 'Model A' },
          { id: 'model-b', name: 'Model B' },
        ],
      });
      useModelStore.getState().removeModel('model-a');
      expect(useModelStore.getState().selectedModels).toEqual([{ id: 'model-b', name: 'Model B' }]);
    });

    it('does not remove the last model', () => {
      useModelStore.getState().removeModel(DEFAULT_MODEL_ID);
      expect(useModelStore.getState().selectedModels).toEqual([defaultEntry]);
    });

    it('does nothing when model id is not in the list', () => {
      useModelStore.getState().removeModel('nonexistent');
      expect(useModelStore.getState().selectedModels).toEqual([defaultEntry]);
    });
  });

  describe('clearSelection', () => {
    it('resets to only the first selected model', () => {
      useModelStore.setState({
        selectedModels: [
          { id: 'model-a', name: 'Model A' },
          { id: 'model-b', name: 'Model B' },
          { id: 'model-c', name: 'Model C' },
        ],
      });
      useModelStore.getState().clearSelection();
      expect(useModelStore.getState().selectedModels).toEqual([{ id: 'model-a', name: 'Model A' }]);
    });

    it('is a no-op when only one model is selected', () => {
      useModelStore.getState().clearSelection();
      expect(useModelStore.getState().selectedModels).toEqual([defaultEntry]);
    });
  });

  describe('empty state guard', () => {
    it('resets to default entry when selectedModels is empty', () => {
      useModelStore.setState({ selectedModels: [] });
      expect(useModelStore.getState().selectedModels).toEqual([defaultEntry]);
    });
  });

  describe('persistence migration', () => {
    it('migrates from version 0 (old format) to version 1', () => {
      // Simulate old persisted state shape
      const oldState = {
        selectedModelId: 'anthropic/claude-3.5-sonnet',
        selectedModelName: 'Claude 3.5 Sonnet',
      };

      // Get the persist options to access the migrate function
      const persistOptions = (
        useModelStore as unknown as {
          persist: { getOptions: () => { migrate: (state: unknown, version: number) => unknown } };
        }
      ).persist.getOptions();
      const migrated = persistOptions.migrate(oldState, 0) as {
        selectedModels: SelectedModelEntry[];
      };

      expect(migrated.selectedModels).toEqual([
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      ]);
    });
  });
});
