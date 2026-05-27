import { describe, it, expect, beforeEach } from 'vitest';
import { useAppVersionStore } from './app-version';

describe('useAppVersionStore', () => {
  beforeEach(() => {
    useAppVersionStore.setState({ upgradeRequired: false, otaInProgress: false });
  });

  it('starts with upgradeRequired as false', () => {
    expect(useAppVersionStore.getState().upgradeRequired).toBe(false);
  });

  it('starts with otaInProgress as false', () => {
    expect(useAppVersionStore.getState().otaInProgress).toBe(false);
  });

  it('sets otaInProgress to true', () => {
    useAppVersionStore.getState().setOtaInProgress(true);

    expect(useAppVersionStore.getState().otaInProgress).toBe(true);
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
});
