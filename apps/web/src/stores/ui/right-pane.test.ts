import { beforeEach, describe, expect, it } from 'vitest';
import { useRightPane } from './right-pane';

describe('useRightPane', () => {
  beforeEach(() => {
    useRightPane.setState({ active: null });
  });

  it('starts with no pane open', () => {
    expect(useRightPane.getState().active).toBeNull();
  });

  it('opens the pane named', () => {
    useRightPane.getState().open('members');

    expect(useRightPane.getState().active).toBe('members');
  });

  it('replaces the open pane when another opens', () => {
    useRightPane.getState().open('members');
    useRightPane.getState().open('accessibility');

    expect(useRightPane.getState().active).toBe('accessibility');
  });

  it('closes the open pane', () => {
    useRightPane.getState().open('members');
    useRightPane.getState().close();

    expect(useRightPane.getState().active).toBeNull();
  });
});
