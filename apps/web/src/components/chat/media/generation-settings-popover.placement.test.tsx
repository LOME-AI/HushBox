import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

const { handed } = vi.hoisted(() => {
  const received: {
    boundary: PopoverProps['boundary'] | undefined;
    anchor: PopoverProps['anchor'] | undefined;
    onOpenChange: PopoverProps['onOpenChange'] | undefined;
  }[] = [];
  return { handed: received };
});

// The popover's placement is Radix's, which jsdom cannot lay out; what this file
// owns is what it hands the popover: the box to stay inside and the box to hang from.
vi.mock('@hushbox/ui/popover', () => ({
  Popover: ({ trigger, boundary, anchor, onOpenChange }: PopoverProps): React.JSX.Element => {
    handed.push({ boundary, anchor, onOpenChange });
    return trigger;
  },
}));

import { GenerationSettingsPopover } from '@/components/chat/media/generation-settings-popover';
import type * as React from 'react';
import type { PopoverProps } from '@hushbox/ui/popover';

function Trigger({
  ref,
}: Readonly<{ expanded?: boolean; ref?: React.Ref<HTMLButtonElement> }>): React.JSX.Element {
  return (
    <button ref={ref} type="button">
      Settings
    </button>
  );
}

function lastBoundary(): HTMLElement | null | undefined {
  return handed.at(-1)?.boundary;
}

/** What the popover was last told to hang from; `null` leaves it on its trigger. */
function lastAnchor(): PopoverProps['anchor'] {
  return handed.at(-1)?.anchor;
}

/** Opens the popover the way its trigger would. */
function open(): void {
  act(() => {
    handed.at(-1)?.onOpenChange?.(true);
  });
}

const NO_COMPOSER = { current: null };

describe('GenerationSettingsPopover placement', () => {
  it('stays inside the page region below the header', () => {
    const { container } = render(
      <main>
        <header>Header</header>
        <div data-page-slot="region">
          <GenerationSettingsPopover modality="image" trigger={<Trigger />} anchor={NO_COMPOSER} />
        </div>
      </main>
    );
    expect(lastBoundary()).toBe(container.querySelector('[data-page-slot="region"]'));
  });

  it('stays inside the main column on a page with no region', () => {
    const { container } = render(
      <main>
        <GenerationSettingsPopover modality="image" trigger={<Trigger />} anchor={NO_COMPOSER} />
      </main>
    );
    expect(lastBoundary()).toBe(container.querySelector('main'));
  });

  it('is held by nothing outside a main column', () => {
    render(
      <GenerationSettingsPopover modality="image" trigger={<Trigger />} anchor={NO_COMPOSER} />
    );
    expect(lastBoundary()).toBeNull();
  });

  it('hangs from the composer it is given, once it opens', () => {
    const composer = document.createElement('div');
    render(
      <GenerationSettingsPopover
        modality="image"
        trigger={<Trigger />}
        anchor={{ current: composer }}
      />
    );
    open();
    expect(lastAnchor()).toBe(composer);
  });

  it('hangs from its own chip while no composer is mounted', () => {
    render(
      <GenerationSettingsPopover modality="image" trigger={<Trigger />} anchor={NO_COMPOSER} />
    );
    open();
    expect(lastAnchor()).toBeNull();
  });

  it('keeps the composer it read when it closes', () => {
    const composer = document.createElement('div');
    render(
      <GenerationSettingsPopover
        modality="image"
        trigger={<Trigger />}
        anchor={{ current: composer }}
      />
    );
    open();
    act(() => {
      handed.at(-1)?.onOpenChange?.(false);
    });
    expect(lastAnchor()).toBe(composer);
  });
});
