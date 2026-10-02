import * as React from 'react';
import {
  ModalActions,
  Overlay,
  OverlayContent,
  OverlayHeader,
  useCopyToClipboard,
} from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { isNative } from '@/capacitor/platform';
import { openExternalUrl } from '@/capacitor/browser';

/** A web page, which the native shell's system browser can open. */
const WEB_PAGE = /^https?:\/\//i;

/**
 * Opens a link outside the app. On the web it is a new tab carrying no
 * referrer, so the site learns nothing of the conversation the link was in.
 * The native shell hands a web page to the system browser, which takes only
 * http and https; any other scheme, such as mailto or tel, keeps the
 * platform's own handling, as Streamdown's link check gave it.
 */
function openExternal(url: string): void {
  if (isNative() && WEB_PAGE.test(url)) {
    void openExternalUrl(url);
    return;
  }
  globalThis.open(url, '_blank', 'noopener,noreferrer');
}

interface ExternalLinkDialogProps {
  /** The page the reader chose, or `null` while nothing is being opened. */
  readonly url: string | null;
  readonly onClose: () => void;
}

/**
 * The one check before a page outside the app opens, for a link in an answer
 * (Streamdown's link safety renders it) and for a search row's source alike:
 * the whole address is shown, and nothing leaves the app until the reader
 * confirms.
 */
export function ExternalLinkDialog({
  url,
  onClose,
}: ExternalLinkDialogProps): React.JSX.Element | null {
  if (url === null) return null;
  return <OpenExternalLinkDialog url={url} onClose={onClose} />;
}

function OpenExternalLinkDialog({
  url,
  onClose,
}: Readonly<{ url: string; onClose: () => void }>): React.JSX.Element {
  const { copy, copied } = useCopyToClipboard();
  return (
    <Overlay
      open
      // Mounted only while a page is chosen, so the only change it reports is a dismissal.
      onOpenChange={onClose}
      ariaLabel="Open external link?"
    >
      <OverlayContent data-testid={TEST_IDS.externalLinkDialog}>
        <OverlayHeader
          title="Open external link?"
          description="You're about to visit an external website."
        />
        <p className="bg-muted rounded-md p-3 font-mono text-sm break-all">{url}</p>
        <ModalActions
          cancel={{
            label: copied ? 'Copied' : 'Copy link',
            onClick: () => {
              void copy(url);
            },
            testId: TEST_IDS.externalLinkCopyButton,
          }}
          primary={{
            label: 'Open link',
            onClick: () => {
              openExternal(url);
              onClose();
            },
            testId: TEST_IDS.externalLinkOpenButton,
          }}
        />
      </OverlayContent>
    </Overlay>
  );
}
