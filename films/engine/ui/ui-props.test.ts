import { describe, expect, it } from 'vitest';

import { UI_PASS_PROPS, UI_PLAN_PROPS, readUiProps, uiFramesProps } from './ui-props.js';

describe('readUiProps', () => {
  it('asks for nothing when no UI prop is set', () => {
    expect(readUiProps({})).toEqual({ plan: false, pass: false, frames: null });
  });

  it('reads the plan probe', () => {
    expect(readUiProps(UI_PLAN_PROPS).plan).toBe(true);
  });

  it('reads the UI pass', () => {
    expect(readUiProps(UI_PASS_PROPS).pass).toBe(true);
  });

  it('reads where the UI pass wrote its frames', () => {
    expect(readUiProps(uiFramesProps('engine-ui/ui-video')).frames).toBe('engine-ui/ui-video');
  });

  it('keeps the other input props out of its reading', () => {
    expect(readUiProps({ qa: true, qaHideText: true })).toEqual({
      plan: false,
      pass: false,
      frames: null,
    });
  });

  it('refuses a plan flag that is not a boolean, naming it', () => {
    expect(() => readUiProps({ filmsUiPlan: 1 })).toThrow(/→ at filmsUiPlan/);
  });

  it('refuses a pass flag that is not a boolean, naming it', () => {
    expect(() => readUiProps({ filmsUiPass: 'yes' })).toThrow(/→ at filmsUiPass/);
  });

  it('refuses a frames directory that is not a string, naming it', () => {
    expect(() => readUiProps({ filmsUiFrames: 3 })).toThrow(/→ at filmsUiFrames/);
  });

  it('refuses an empty frames directory, naming it', () => {
    expect(() => readUiProps({ filmsUiFrames: '' })).toThrow(/→ at filmsUiFrames/);
  });
});
