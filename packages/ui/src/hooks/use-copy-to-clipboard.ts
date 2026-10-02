import * as React from 'react';

const DEFAULT_RESET_MS = 2000;

interface UseCopyToClipboardOptions {
  /** How long `copied` stays true after a successful copy. Defaults to 2000. */
  readonly resetAfterMs?: number;
}

interface UseCopyToClipboardReturn {
  /** Copies `text`, resolving to whether it landed on the clipboard. */
  readonly copy: (text: string) => Promise<boolean>;
  /** True from a successful copy until the reset delay elapses. */
  readonly copied: boolean;
}

/**
 * Selection-based copy, for the environments the async Clipboard API is not in:
 * insecure origins and older WebViews. Handles arbitrarily long text, which is
 * why the carrier is a textarea rather than an input.
 */
function copyBySelection(text: string): boolean {
  const carrier = document.createElement('textarea');
  carrier.value = text;
  carrier.setAttribute('readonly', '');
  carrier.setAttribute('aria-hidden', 'true');
  carrier.style.position = 'fixed';
  carrier.style.opacity = '0';
  carrier.style.pointerEvents = 'none';
  document.body.append(carrier);
  try {
    carrier.select();
    // eslint-disable-next-line @typescript-eslint/no-deprecated, sonarjs/deprecation -- execCommand IS the fallback: it is the only synchronous copy the environments without the async Clipboard API have
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    carrier.remove();
  }
}

async function writeToClipboard(text: string): Promise<boolean> {
  try {
    // The DOM lib types `clipboard` as always present; on insecure origins and
    // in older WebViews it is absent, so the same catch covers both a missing
    // API and a refused write.
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyBySelection(text);
  }
}

/** Copy-to-clipboard with the transient "Copied" acknowledgement every call site needs. */
export function useCopyToClipboard(options?: UseCopyToClipboardOptions): UseCopyToClipboardReturn {
  const resetAfterMs = options?.resetAfterMs ?? DEFAULT_RESET_MS;
  const [copied, setCopied] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  React.useEffect(() => {
    return () => {
      clearTimeout(timerRef.current);
    };
  }, []);

  const copy = React.useCallback(
    async (text: string): Promise<boolean> => {
      const written = await writeToClipboard(text);
      if (!written) {
        return false;
      }
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setCopied(false);
      }, resetAfterMs);
      return true;
    },
    [resetAfterMs]
  );

  return { copy, copied };
}
