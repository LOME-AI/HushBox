import { describe, it, expect, beforeEach } from 'vitest';
import { useAppVersionStore } from './app-version';

describe('useAppVersionStore', () => {
  beforeEach(() => {
    useAppVersionStore.setState({ upgradeRequired: false, updateInProgress: false });
  });

  it('starts with upgradeRequired as false', () => {
    expect(useAppVersionStore.getState().upgradeRequired).toBe(false);
  });

  it('sets upgradeRequired to true', () => {
    useAppVersionStore.getState().setUpgradeRequired(true);

    expect(useAppVersionStore.getState().upgradeRequired).toBe(true);
  });

  it('can be set back to false', () => {
    useAppVersionStore.getState().setUpgradeRequired(true);
    useAppVersionStore.getState().setUpgradeRequired(false);

    expect(useAppVersionStore.getState().upgradeRequired).toBe(false);
  });

  it('starts with updateInProgress as false', () => {
    expect(useAppVersionStore.getState().updateInProgress).toBe(false);
  });

  it('sets updateInProgress to true', () => {
    useAppVersionStore.getState().setUpdateInProgress(true);

    expect(useAppVersionStore.getState().updateInProgress).toBe(true);
  });

  it('sets updateInProgress back to false', () => {
    useAppVersionStore.getState().setUpdateInProgress(true);
    useAppVersionStore.getState().setUpdateInProgress(false);

    expect(useAppVersionStore.getState().updateInProgress).toBe(false);
  });
});
