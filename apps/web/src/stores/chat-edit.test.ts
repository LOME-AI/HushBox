import { describe, it, expect, beforeEach } from 'vitest';
import { useChatEditStore } from './chat-edit.js';

describe('useChatEditStore', () => {
  beforeEach(() => {
    useChatEditStore.setState({
      editingMessageId: null,
      editingContent: '',
    });
  });

  it('starts with no editing state', () => {
    const state = useChatEditStore.getState();
    expect(state.editingMessageId).toBeNull();
    expect(state.editingContent).toBe('');
  });

  it('sets editing state with startEditing', () => {
    useChatEditStore.getState().startEditing('msg-1', 'Hello world');

    const state = useChatEditStore.getState();
    expect(state.editingMessageId).toBe('msg-1');
    expect(state.editingContent).toBe('Hello world');
  });

  it('clears editing state with clearEditing', () => {
    useChatEditStore.getState().startEditing('msg-1', 'Hello world');
    useChatEditStore.getState().clearEditing();

    const state = useChatEditStore.getState();
    expect(state.editingMessageId).toBeNull();
    expect(state.editingContent).toBe('');
  });

  it('replaces previous editing state when startEditing called again', () => {
    useChatEditStore.getState().startEditing('msg-1', 'First message');
    useChatEditStore.getState().startEditing('msg-2', 'Second message');

    const state = useChatEditStore.getState();
    expect(state.editingMessageId).toBe('msg-2');
    expect(state.editingContent).toBe('Second message');
  });

  it('handles empty content', () => {
    useChatEditStore.getState().startEditing('msg-1', '');

    const state = useChatEditStore.getState();
    expect(state.editingMessageId).toBe('msg-1');
    expect(state.editingContent).toBe('');
  });
});
