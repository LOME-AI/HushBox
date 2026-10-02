import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Overlay, OverlayContent, ScrollArea } from '@hushbox/ui';
import { useOverlayPresentation } from '@hushbox/ui/overlay';
import { ModelSelectorFrame } from '@/components/chat/model-selector/model-selector-layout';
import '../../../app.css';
import { ROW_COUNT, rowLabel } from './overlay-focus-reveal-rows';

/**
 * Real-browser fixture for `overlay-focus-reveal.browser.test.tsx`: the real `Overlay` holding a
 * list taller than it, so a focus-trap wrap has somewhere off-screen to land. Everything comes
 * from the query string but the presentation, which the viewport's width picks, as it does in the
 * app: a bottom sheet below 768px, a dialog from 768px. `shape=list` puts the rows straight inside
 * `OverlayContent` with no close button, so both wrap edges land in the list; `shape=picker` is
 * the model picker's layout (apps/web/src/components/chat/model-selector/model-selector-layout.tsx),
 * a close button and then the rows in a `ScrollArea`. `initialFocus` names a row index for the
 * overlay to focus on open.
 *
 * Test infrastructure, not shipped runtime: it runs only in the browser the test spawns, so
 * `apps/web/vitest.config.ts` excludes `src/**\/*-fixture/**` from the coverage gate.
 */

const query = new URLSearchParams(location.search);
const picker = query.get('shape') === 'picker';
const initialFocusParameter = query.get('initialFocus');
const initialFocusIndex = initialFocusParameter === null ? -1 : Number(initialFocusParameter);

function Rows({
  initialFocus,
}: Readonly<{ initialFocus: React.RefObject<HTMLButtonElement | null> }>): React.JSX.Element {
  return (
    <>
      {Array.from({ length: ROW_COUNT }, (_, index) => (
        <button
          key={index}
          type="button"
          ref={index === initialFocusIndex ? initialFocus : undefined}
          className="block min-h-11 w-full text-left"
        >
          {rowLabel(index)}
        </button>
      ))}
    </>
  );
}

/** The model picker's own frame, as the picker draws it in the presentation it is in. */
function PickerFrame({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const sheet = useOverlayPresentation() === 'sheet';
  return <ModelSelectorFrame isMobile={sheet}>{children}</ModelSelectorFrame>;
}

function Fixture(): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const initialFocus = useRef<HTMLButtonElement>(null);
  const rows = <Rows initialFocus={initialFocus} />;
  return (
    <Overlay
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Options"
      showCloseButton={picker}
      {...(initialFocusIndex >= 0 && { initialFocus })}
    >
      {picker ? (
        <PickerFrame>
          <ScrollArea className="min-h-0 flex-1">{rows}</ScrollArea>
        </PickerFrame>
      ) : (
        <OverlayContent>{rows}</OverlayContent>
      )}
    </Overlay>
  );
}

const rootElement = document.querySelector('#root');
if (rootElement === null) throw new Error('missing #root');
createRoot(rootElement).render(<Fixture />);
