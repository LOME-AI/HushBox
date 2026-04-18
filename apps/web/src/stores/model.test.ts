import { describe, it, expect, beforeEach } from 'vitest';
import { SMART_MODEL_ID, MAX_SELECTED_MODELS } from '@hushbox/shared';
import type { Modality } from '@hushbox/shared';
import { useModelStore, DEFAULT_MODEL_ID, DEFAULT_MODEL_NAME, getPrimaryModel } from './model';
import type { SelectedModelEntry } from './model';

const defaultTextEntry: SelectedModelEntry = { id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_NAME };

function emptySelections(): Record<Modality, SelectedModelEntry[]> {
  return { text: [defaultTextEntry], image: [], audio: [], video: [] };
}

function resetStore(): void {
  useModelStore.setState({
    activeModality: 'text',
    selections: emptySelections(),
    imageConfig: { aspectRatio: '1:1' },
    videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
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

    it('has default text selection with Smart Model', () => {
      const { selections } = useModelStore.getState();
      expect(selections.text).toEqual([defaultTextEntry]);
    });

    it('has empty selections for image, audio, and video by default', () => {
      const { selections } = useModelStore.getState();
      expect(selections.image).toEqual([]);
      expect(selections.audio).toEqual([]);
      expect(selections.video).toEqual([]);
    });

    it('defaults activeModality to text', () => {
      expect(useModelStore.getState().activeModality).toBe('text');
    });

    it('has default imageConfig', () => {
      expect(useModelStore.getState().imageConfig).toEqual({ aspectRatio: '1:1' });
    });

    it('has default videoConfig', () => {
      expect(useModelStore.getState().videoConfig).toEqual({
        aspectRatio: '16:9',
        durationSeconds: 4,
        resolution: '720p',
      });
    });
  });

  describe('setActiveModality', () => {
    it('switches modality without resetting selections', () => {
      useModelStore.setState({
        selections: {
          text: [{ id: 'model-a', name: 'Model A' }],
          image: [{ id: 'image-1', name: 'Image 1' }],
          audio: [],
          video: [],
        },
      });
      useModelStore.getState().setActiveModality('image');
      const state = useModelStore.getState();
      expect(state.activeModality).toBe('image');
      expect(state.selections.text).toEqual([{ id: 'model-a', name: 'Model A' }]);
      expect(state.selections.image).toEqual([{ id: 'image-1', name: 'Image 1' }]);
    });

    it('is a no-op when modality is unchanged', () => {
      const before = useModelStore.getState();
      useModelStore.getState().setActiveModality('text');
      expect(useModelStore.getState().selections).toBe(before.selections);
    });

    it('supports switching to audio and video', () => {
      useModelStore.getState().setActiveModality('audio');
      expect(useModelStore.getState().activeModality).toBe('audio');
      useModelStore.getState().setActiveModality('video');
      expect(useModelStore.getState().activeModality).toBe('video');
    });
  });

  describe('setSelectedModels', () => {
    it('replaces the array for the given modality only', () => {
      useModelStore.getState().setSelectedModels('text', [{ id: 'claude', name: 'Claude' }]);
      expect(useModelStore.getState().selections.text).toEqual([{ id: 'claude', name: 'Claude' }]);
      expect(useModelStore.getState().selections.image).toEqual([]);
    });

    it('does not cross-pollinate between modalities', () => {
      useModelStore.getState().setSelectedModels('image', [{ id: 'imagen', name: 'Imagen' }]);
      const state = useModelStore.getState();
      expect(state.selections.text).toEqual([defaultTextEntry]);
      expect(state.selections.image).toEqual([{ id: 'imagen', name: 'Imagen' }]);
    });
  });

  describe('toggleModel', () => {
    it('adds a model to the given modality when absent', () => {
      useModelStore.getState().toggleModel('text', { id: 'claude', name: 'Claude' });
      expect(useModelStore.getState().selections.text).toHaveLength(2);
    });

    it('removes a model from the given modality when present and > 1 selected', () => {
      useModelStore.setState({
        selections: {
          text: [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' },
          ],
          image: [],
          audio: [],
          video: [],
        },
      });
      useModelStore.getState().toggleModel('text', { id: 'b', name: 'B' });
      expect(useModelStore.getState().selections.text).toEqual([{ id: 'a', name: 'A' }]);
    });

    it('never removes the last text model', () => {
      useModelStore.getState().toggleModel('text', defaultTextEntry);
      expect(useModelStore.getState().selections.text).toEqual([defaultTextEntry]);
    });

    it('allows removing the last image model (image can be empty)', () => {
      useModelStore.setState({
        selections: {
          text: [defaultTextEntry],
          image: [{ id: 'imagen', name: 'Imagen' }],
          audio: [],
          video: [],
        },
      });
      useModelStore.getState().toggleModel('image', { id: 'imagen', name: 'Imagen' });
      expect(useModelStore.getState().selections.image).toEqual([]);
    });

    it('respects MAX_SELECTED_MODELS per modality', () => {
      const models: SelectedModelEntry[] = Array.from(
        { length: MAX_SELECTED_MODELS },
        (_, index) => ({ id: `m${String(index)}`, name: `M${String(index)}` })
      );
      useModelStore.setState({
        selections: { text: models, image: [], audio: [], video: [] },
      });
      useModelStore.getState().toggleModel('text', { id: 'extra', name: 'Extra' });
      expect(useModelStore.getState().selections.text).toHaveLength(MAX_SELECTED_MODELS);
    });

    it('applies the cap per-modality (text full does not block image)', () => {
      const textModels: SelectedModelEntry[] = Array.from(
        { length: MAX_SELECTED_MODELS },
        (_, index) => ({ id: `t${String(index)}`, name: `T${String(index)}` })
      );
      useModelStore.setState({
        selections: { text: textModels, image: [], audio: [], video: [] },
      });
      useModelStore.getState().toggleModel('image', { id: 'imagen', name: 'Imagen' });
      expect(useModelStore.getState().selections.image).toEqual([{ id: 'imagen', name: 'Imagen' }]);
    });
  });

  describe('removeModel', () => {
    it('removes a model from the given modality', () => {
      useModelStore.setState({
        selections: {
          text: [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' },
          ],
          image: [],
          audio: [],
          video: [],
        },
      });
      useModelStore.getState().removeModel('text', 'a');
      expect(useModelStore.getState().selections.text).toEqual([{ id: 'b', name: 'B' }]);
    });

    it('never empties text', () => {
      useModelStore.getState().removeModel('text', DEFAULT_MODEL_ID);
      expect(useModelStore.getState().selections.text).toEqual([defaultTextEntry]);
    });

    it('allows emptying image', () => {
      useModelStore.setState({
        selections: {
          text: [defaultTextEntry],
          image: [{ id: 'imagen', name: 'Imagen' }],
          audio: [],
          video: [],
        },
      });
      useModelStore.getState().removeModel('image', 'imagen');
      expect(useModelStore.getState().selections.image).toEqual([]);
    });

    it('does nothing when the id is not present', () => {
      useModelStore.getState().removeModel('text', 'nonexistent');
      expect(useModelStore.getState().selections.text).toEqual([defaultTextEntry]);
    });
  });

  describe('clearSelection', () => {
    it('reduces text selection to only the primary entry', () => {
      useModelStore.setState({
        selections: {
          text: [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' },
          ],
          image: [],
          audio: [],
          video: [],
        },
      });
      useModelStore.getState().clearSelection('text');
      expect(useModelStore.getState().selections.text).toEqual([{ id: 'a', name: 'A' }]);
    });

    it('empties image selection', () => {
      useModelStore.setState({
        selections: {
          text: [defaultTextEntry],
          image: [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' },
          ],
          audio: [],
          video: [],
        },
      });
      useModelStore.getState().clearSelection('image');
      expect(useModelStore.getState().selections.image).toEqual([]);
    });
  });

  describe('setImageConfig', () => {
    it('merges partial config', () => {
      useModelStore.getState().setImageConfig({ aspectRatio: '16:9' });
      expect(useModelStore.getState().imageConfig).toEqual({ aspectRatio: '16:9' });
    });
  });

  describe('setVideoConfig', () => {
    it('merges partial config', () => {
      useModelStore.getState().setVideoConfig({ durationSeconds: 6 });
      expect(useModelStore.getState().videoConfig).toEqual({
        aspectRatio: '16:9',
        durationSeconds: 6,
        resolution: '720p',
      });
    });

    it('overrides all config fields when all provided', () => {
      useModelStore
        .getState()
        .setVideoConfig({ aspectRatio: '9:16', durationSeconds: 8, resolution: '1080p' });
      expect(useModelStore.getState().videoConfig).toEqual({
        aspectRatio: '9:16',
        durationSeconds: 8,
        resolution: '1080p',
      });
    });
  });

  describe('empty state guard', () => {
    it('restores default text entry when text is set to empty', () => {
      useModelStore.setState({
        selections: { text: [], image: [], audio: [], video: [] },
      });
      expect(useModelStore.getState().selections.text).toEqual([defaultTextEntry]);
    });

    it('does not restore image when set to empty', () => {
      useModelStore.setState({
        selections: { text: [defaultTextEntry], image: [], audio: [], video: [] },
      });
      expect(useModelStore.getState().selections.image).toEqual([]);
    });

    it('restores default text when setSelectedModels empties the text slot', () => {
      useModelStore.getState().setSelectedModels('text', []);
      expect(useModelStore.getState().selections.text).toEqual([defaultTextEntry]);
    });

    it('merge restores default text entry when rehydrating with empty text', () => {
      interface MergePersistHandle {
        persist: {
          getOptions: () => {
            merge: (
              persisted: unknown,
              current: unknown
            ) => {
              selections: Record<Modality, SelectedModelEntry[]>;
            };
          };
        };
      }
      const merge = (useModelStore as unknown as MergePersistHandle).persist.getOptions().merge;
      const current = useModelStore.getState();
      const merged = merge(
        {
          activeModality: 'text',
          selections: { text: [], image: [], audio: [], video: [] },
        },
        current
      );
      expect(merged.selections.text).toEqual([defaultTextEntry]);
    });
  });

  describe('persistence migration', () => {
    interface PersistHandle {
      persist: {
        getOptions: () => {
          migrate: (state: unknown, version: number) => unknown;
        };
      };
    }

    function getMigrate(): (state: unknown, version: number) => unknown {
      return (useModelStore as unknown as PersistHandle).persist.getOptions().migrate;
    }

    it('migrates from v0 (pre-array single model) to v2 shape', () => {
      const migrate = getMigrate();
      const migrated = migrate(
        { selectedModelId: 'anthropic/claude', selectedModelName: 'Claude' },
        0
      ) as { selections: Record<Modality, SelectedModelEntry[]> };
      expect(migrated.selections.text).toEqual([{ id: 'anthropic/claude', name: 'Claude' }]);
      expect(migrated.selections.image).toEqual([]);
      expect(migrated.selections.audio).toEqual([]);
      expect(migrated.selections.video).toEqual([]);
    });

    it('migrates from v1 text state to v2', () => {
      const migrate = getMigrate();
      const migrated = migrate(
        {
          selectedModels: [{ id: 'anthropic/claude', name: 'Claude' }],
          activeModality: 'text',
        },
        1
      ) as { activeModality: Modality; selections: Record<Modality, SelectedModelEntry[]> };
      expect(migrated.activeModality).toBe('text');
      expect(migrated.selections.text).toEqual([{ id: 'anthropic/claude', name: 'Claude' }]);
      expect(migrated.selections.image).toEqual([]);
    });

    it('migrates from v1 image state to v2 (image selection preserved)', () => {
      const migrate = getMigrate();
      const migrated = migrate(
        {
          selectedModels: [{ id: 'imagen', name: 'Imagen' }],
          activeModality: 'image',
        },
        1
      ) as { activeModality: Modality; selections: Record<Modality, SelectedModelEntry[]> };
      expect(migrated.activeModality).toBe('image');
      expect(migrated.selections.text).toEqual([defaultTextEntry]);
      expect(migrated.selections.image).toEqual([{ id: 'imagen', name: 'Imagen' }]);
    });
  });

  describe('getPrimaryModel helper', () => {
    it('returns the first entry of the given list', () => {
      const entries: SelectedModelEntry[] = [
        { id: 'claude', name: 'Claude' },
        { id: 'gpt-4', name: 'GPT-4' },
      ];
      expect(getPrimaryModel(entries)).toEqual({ id: 'claude', name: 'Claude' });
    });

    it('falls back to the default text entry when list is empty and modality is text', () => {
      expect(getPrimaryModel([], 'text')).toEqual(defaultTextEntry);
    });

    it('falls back to the default text entry when list is empty and modality is omitted', () => {
      expect(getPrimaryModel([])).toEqual(defaultTextEntry);
    });

    it('falls back to a blank entry when list is empty and modality is image', () => {
      expect(getPrimaryModel([], 'image')).toEqual({ id: '', name: '' });
    });

    it('falls back to a blank entry when list is empty and modality is video', () => {
      expect(getPrimaryModel([], 'video')).toEqual({ id: '', name: '' });
    });
  });
});
