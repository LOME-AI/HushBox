import * as React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useShallow } from 'zustand/react/shallow';
import { useUIModalsStore } from './ui-modals';

// Guards the DF9 fix: consumers that read only a slice of the UIModals store via
// a scoped selector must not re-render when an unrelated field changes. A
// whole-store subscription (the prior bug) re-renders on every field change.

beforeEach(() => {
  useUIModalsStore.setState({ signupModalOpen: false, memberSidebarOpen: false });
});

// A no-dep effect commits once per render. Counting its calls (rather than
// mutating during render) measures committed renders without tripping the
// react-hooks immutability rule.
function makeProbe(useSubscription: () => unknown): {
  commits: number[];
  Probe: () => React.JSX.Element;
} {
  const commits: number[] = [];
  function Probe(): React.JSX.Element {
    useSubscription();
    React.useEffect(() => {
      commits.push(1);
    });
    return <div />;
  }
  return { commits, Probe };
}

describe('UIModals scoped subscriptions', () => {
  it('does not re-render a scoped-selector consumer when an unrelated field changes', () => {
    const { commits, Probe } = makeProbe(() => useUIModalsStore((s) => s.signupModalOpen));
    render(<Probe />);
    const initial = commits.length;

    act(() => {
      useUIModalsStore.setState({ memberSidebarOpen: true });
    });

    expect(commits.length).toBe(initial);
  });

  it('does not re-render a useShallow action-bundle consumer when an unrelated field changes', () => {
    const { commits, Probe } = makeProbe(() =>
      useUIModalsStore(
        useShallow((s) => ({
          setSignupModalOpen: s.setSignupModalOpen,
          setPaymentModalOpen: s.setPaymentModalOpen,
        }))
      )
    );
    render(<Probe />);
    const initial = commits.length;

    act(() => {
      useUIModalsStore.setState({ memberSidebarOpen: true });
    });

    expect(commits.length).toBe(initial);
  });

  it('re-renders a whole-store consumer when an unrelated field changes', () => {
    const { commits, Probe } = makeProbe(() => useUIModalsStore());
    render(<Probe />);
    const initial = commits.length;

    act(() => {
      useUIModalsStore.setState({ memberSidebarOpen: true });
    });

    expect(commits.length).toBeGreaterThan(initial);
  });
});
