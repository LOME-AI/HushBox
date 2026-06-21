import * as React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, act, screen } from '@testing-library/react';
import { useMeasuredSize } from '@/hooks/ui/use-measured-size';

class ResizeObserverMock {
  static readonly instances: ResizeObserverMock[] = [];
  callback: ResizeObserverCallback;
  observed: Element[] = [];
  disconnected = false;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverMock.instances.push(this);
  }
  observe(target: Element): void {
    this.observed.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
    this.observed = [];
  }
  trigger(target: Element, width: number, height: number): void {
    this.callback(
      [{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver
    );
  }
}

beforeEach(() => {
  ResizeObserverMock.instances.length = 0;
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver =
    ResizeObserverMock;
});

interface ProbeProps {
  axis: 'width' | 'height';
  enabled: boolean;
  onResult: (size: number | 'auto') => void;
}

function HeightProbe({ axis, enabled, onResult }: Readonly<ProbeProps>): React.JSX.Element {
  const { ref, size } = useMeasuredSize<HTMLDivElement>(axis, enabled);
  onResult(size);
  return <div ref={ref} data-testid="probe" />;
}

function SpanProbe({ axis, enabled, onResult }: Readonly<ProbeProps>): React.JSX.Element {
  const { ref, size } = useMeasuredSize<HTMLSpanElement>(axis, enabled);
  onResult(size);
  return <span ref={ref} data-testid="probe" />;
}

describe('useMeasuredSize', () => {
  it('updates size when the ResizeObserver fires (height axis)', () => {
    let latest: number | 'auto' = 'auto';
    render(
      <HeightProbe
        axis="height"
        enabled
        onResult={(s) => {
          latest = s;
        }}
      />
    );
    const observer = ResizeObserverMock.instances[0];
    const observed = observer?.observed[0];
    expect(observer).toBeDefined();
    expect(observed).toBeDefined();
    if (!observer || !observed) return;
    act(() => {
      observer.trigger(observed, 300, 175);
    });
    expect(latest).toBe(175);
  });

  it('updates size when the ResizeObserver fires (width axis)', () => {
    let latest: number | 'auto' = 'auto';
    render(
      <SpanProbe
        axis="width"
        enabled
        onResult={(s) => {
          latest = s;
        }}
      />
    );
    const observer = ResizeObserverMock.instances[0];
    const observed = observer?.observed[0];
    expect(observer).toBeDefined();
    expect(observed).toBeDefined();
    if (!observer || !observed) return;
    act(() => {
      observer.trigger(observed, 80, 24);
    });
    expect(latest).toBe(80);
  });

  it('observes the attached element when enabled is true', () => {
    render(
      <HeightProbe
        axis="height"
        enabled
        onResult={() => {
          /* noop */
        }}
      />
    );
    expect(ResizeObserverMock.instances).toHaveLength(1);
    expect(ResizeObserverMock.instances[0]?.observed[0]).toBe(screen.getByTestId('probe'));
  });

  it('does not observe when enabled is false', () => {
    render(
      <HeightProbe
        axis="height"
        enabled={false}
        onResult={() => {
          /* noop */
        }}
      />
    );
    expect(ResizeObserverMock.instances).toHaveLength(0);
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = render(
      <HeightProbe
        axis="height"
        enabled
        onResult={() => {
          /* noop */
        }}
      />
    );
    const observer = ResizeObserverMock.instances[0];
    expect(observer).toBeDefined();
    unmount();
    expect(observer?.disconnected).toBe(true);
  });
});
