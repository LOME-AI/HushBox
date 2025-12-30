import { describe, it, expect, beforeEach } from 'vitest';
import { useModelStore } from './model';

describe('useModelStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useModelStore.setState({
      selectedModelId: 'openai/gpt-4-turbo',
      selectedModelName: 'GPT-4 Turbo',
    });
  });

  it('has default selected model id', () => {
    const { selectedModelId } = useModelStore.getState();
    expect(selectedModelId).toBe('openai/gpt-4-turbo');
  });

  it('has default selected model name', () => {
    const { selectedModelName } = useModelStore.getState();
    expect(selectedModelName).toBe('GPT-4 Turbo');
  });

  it('sets selected model id and name', () => {
    useModelStore.getState().setSelectedModel('anthropic/claude-3.5-sonnet', 'Claude 3.5 Sonnet');
    const { selectedModelId, selectedModelName } = useModelStore.getState();
    expect(selectedModelId).toBe('anthropic/claude-3.5-sonnet');
    expect(selectedModelName).toBe('Claude 3.5 Sonnet');
  });

  it('persists model selection across store calls', () => {
    useModelStore.getState().setSelectedModel('google/gemini-pro-1.5', 'Gemini Pro 1.5');
    // Get fresh state
    const { selectedModelId, selectedModelName } = useModelStore.getState();
    expect(selectedModelId).toBe('google/gemini-pro-1.5');
    expect(selectedModelName).toBe('Gemini Pro 1.5');
  });
});
