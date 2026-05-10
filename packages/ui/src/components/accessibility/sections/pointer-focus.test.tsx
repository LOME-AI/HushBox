import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import { PointerFocusSection } from './pointer-focus';
import { useA11yStore } from '../store';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '../store/schema';
import { TouchDeviceOverrideContext } from '../../../hooks/touch-device-override-context';

interface WrapperProps {
  readonly children: React.ReactNode;
  readonly touch: boolean;
}

function TouchProvider({ children, touch }: WrapperProps): React.JSX.Element {
  return <TouchDeviceOverrideContext value={touch}>{children}</TouchDeviceOverrideContext>;
}

describe('PointerFocusSection', () => {
  beforeEach(() => {
    globalThis.window.localStorage.clear();
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
  });

  describe('rendering (non-touch)', () => {
    it('renders the Pointer & focus section heading', () => {
      render(
        <TouchProvider touch={false}>
          <PointerFocusSection />
        </TouchProvider>
      );
      expect(screen.getByRole('heading', { name: /pointer.*focus/i })).toBeInTheDocument();
    });

    it('renders the section element with aria-labelledby pointing to the heading', () => {
      const { container } = render(
        <TouchProvider touch={false}>
          <PointerFocusSection />
        </TouchProvider>
      );
      const section = container.querySelector('section');
      const headingId = section?.getAttribute('aria-labelledby');
      expect(headingId).toBeTruthy();
      const heading = screen.getByRole('heading', { name: /pointer.*focus/i });
      expect(heading.id).toBe(headingId);
    });

    it('renders the Cursor size cycle button on non-touch', () => {
      render(
        <TouchProvider touch={false}>
          <PointerFocusSection />
        </TouchProvider>
      );
      expect(screen.getByRole('button', { name: /cursor size.*normal/i })).toBeInTheDocument();
    });

    it('renders the Cursor color cycle button on non-touch', () => {
      render(
        <TouchProvider touch={false}>
          <PointerFocusSection />
        </TouchProvider>
      );
      expect(screen.getByRole('button', { name: /cursor color.*system/i })).toBeInTheDocument();
    });

    it('renders the Focus width cycle button', () => {
      render(
        <TouchProvider touch={false}>
          <PointerFocusSection />
        </TouchProvider>
      );
      expect(screen.getByRole('button', { name: /focus width.*2px/i })).toBeInTheDocument();
    });

    it('renders the Focus color radiogroup with 5 options', () => {
      render(
        <TouchProvider touch={false}>
          <PointerFocusSection />
        </TouchProvider>
      );
      const group = screen.getByRole('radiogroup', { name: /focus color/i });
      const radios = group.querySelectorAll('[role="radio"]');
      expect(radios).toHaveLength(5);
    });

    it('renders the Focus halo switch', () => {
      render(
        <TouchProvider touch={false}>
          <PointerFocusSection />
        </TouchProvider>
      );
      expect(screen.getByRole('switch', { name: /focus halo/i })).toBeInTheDocument();
    });
  });

  describe('rendering (touch device)', () => {
    it('hides the Cursor size control on touch devices', () => {
      render(
        <TouchProvider touch={true}>
          <PointerFocusSection />
        </TouchProvider>
      );
      expect(screen.queryByRole('button', { name: /cursor size/i })).not.toBeInTheDocument();
    });

    it('hides the Cursor color control on touch devices', () => {
      render(
        <TouchProvider touch={true}>
          <PointerFocusSection />
        </TouchProvider>
      );
      expect(screen.queryByRole('button', { name: /cursor color/i })).not.toBeInTheDocument();
    });

    it('still renders Focus controls on touch devices', () => {
      render(
        <TouchProvider touch={true}>
          <PointerFocusSection />
        </TouchProvider>
      );
      expect(screen.getByRole('button', { name: /focus width/i })).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: /focus halo/i })).toBeInTheDocument();
      expect(screen.getByRole('radiogroup', { name: /focus color/i })).toBeInTheDocument();
    });
  });

  describe('store integration', () => {
    it('clicking Cursor size cycles to next value', async () => {
      const user = userEvent.setup();
      render(
        <TouchProvider touch={false}>
          <PointerFocusSection />
        </TouchProvider>
      );
      await user.click(screen.getByRole('button', { name: /cursor size.*normal/i }));
      expect(useA11yStore.getState().cursorSize).toBe('large');
    });

    it('clicking Cursor color cycles to next value', async () => {
      const user = userEvent.setup();
      render(
        <TouchProvider touch={false}>
          <PointerFocusSection />
        </TouchProvider>
      );
      await user.click(screen.getByRole('button', { name: /cursor color.*system/i }));
      expect(useA11yStore.getState().cursorColor).toBe('black');
    });

    it('clicking Focus width cycles to next value', async () => {
      const user = userEvent.setup();
      render(
        <TouchProvider touch={false}>
          <PointerFocusSection />
        </TouchProvider>
      );
      await user.click(screen.getByRole('button', { name: /focus width.*2px/i }));
      expect(useA11yStore.getState().focusWidth).toBe('4');
    });

    it('selecting a focus color updates the store', async () => {
      const user = userEvent.setup();
      render(
        <TouchProvider touch={false}>
          <PointerFocusSection />
        </TouchProvider>
      );
      const group = screen.getByRole('radiogroup', { name: /focus color/i });
      const magenta = group.querySelector('[role="radio"][aria-checked="false"]');
      expect(magenta).not.toBeNull();
      await user.click(magenta!);
      expect(useA11yStore.getState().focusColor).toBe('magenta');
    });

    it('toggling Focus halo updates the store', async () => {
      const user = userEvent.setup();
      render(
        <TouchProvider touch={false}>
          <PointerFocusSection />
        </TouchProvider>
      );
      await user.click(screen.getByRole('switch', { name: /focus halo/i }));
      expect(useA11yStore.getState().focusHalo).toBe(true);
    });
  });

  describe('reactivity', () => {
    it('reflects current store state for Cursor size', () => {
      useA11yStore.setState({ cursorSize: 'xlarge' });
      render(
        <TouchProvider touch={false}>
          <PointerFocusSection />
        </TouchProvider>
      );
      expect(screen.getByRole('button', { name: /cursor size.*x.?large/i })).toBeInTheDocument();
    });

    it('reflects the selected focus color', () => {
      useA11yStore.setState({ focusColor: 'cyan' });
      render(
        <TouchProvider touch={false}>
          <PointerFocusSection />
        </TouchProvider>
      );
      const group = screen.getByRole('radiogroup', { name: /focus color/i });
      const selected = group.querySelector('[role="radio"][aria-checked="true"]');
      expect(selected?.textContent).toMatch(/cyan/i);
    });
  });
});
