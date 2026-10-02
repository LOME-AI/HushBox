import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { cn } from '@hushbox/ui';
import { TextField } from '@hushbox/ui/field';
import { ArrowRight, Icon, Lock } from '@hushbox/ui/icons';
import { Heading } from '@hushbox/ui/type';
import { generateKeyPair } from '@hushbox/crypto/content';

import { DEMO_SAMPLE_TEXT, encryptDemoSampleTo } from '../lib/encryption-demo-sample';
import type { DemoSample } from '../lib/encryption-demo-sample';

interface EncryptionDemoProps {
  /** The default text's bytes, encrypted at build time so hydration keeps the server's hex. */
  initialSample: DemoSample;
  className?: string;
}

/** Both panels share one height: the stored bytes of the default text show whole down to 320. */
const PANEL_HEIGHT = 'h-52 md:h-37';

function encryptOrNothing(publicKey: Uint8Array, text: string): DemoSample | null {
  try {
    return encryptDemoSampleTo(publicKey, text);
  } catch {
    return null;
  }
}

function EncryptionDemo({
  initialSample,
  className,
}: Readonly<EncryptionDemoProps>): React.JSX.Element {
  const [text, setText] = React.useState(DEMO_SAMPLE_TEXT);
  const [sample, setSample] = React.useState<DemoSample | null>(initialSample);
  const [publicKey] = React.useState(() => generateKeyPair().publicKey);

  return (
    <div
      data-slot="encryption-demo"
      className={cn(
        'flex flex-col gap-4 rounded-lg border-2 p-[clamp(1rem,0.7rem_+_1vw,1.5rem)]',
        className
      )}
    >
      <Heading level={3} variant="site-trust">
        See it for yourself
      </Heading>
      <div className="grid items-center gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.35fr)]">
        <div className="min-w-0 font-sans">
          <TextField
            multiline
            label="What you type"
            value={text}
            spellCheck={false}
            onChange={(event): void => {
              setText(event.target.value);
              setSample(encryptOrNothing(publicKey, event.target.value));
            }}
            className={cn(PANEL_HEIGHT, 'resize-none overflow-y-auto')}
          />
        </div>
        <div className="text-brand-red flex items-center justify-center">
          <Icon icon={ArrowRight} size="lg" className="max-md:rotate-90" />
        </div>
        <section
          aria-label="What our servers store"
          className={cn(
            PANEL_HEIGHT,
            'bg-background-subtle flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-md px-4 py-3 forced-colors:border forced-colors:border-[color:CanvasText]'
          )}
        >
          <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-x-3 text-xs">
            <span>What&apos;s stored</span>
            {sample !== null && (
              <span className="inline-flex items-center gap-[0.3rem] whitespace-nowrap">
                <Icon icon={Lock} size="xs" className="text-success" />
                {sample.byteLength} bytes
              </span>
            )}
          </div>
          <code
            data-testid={TEST_IDS.cipherOutput}
            className="text-site-cipher text-muted-foreground min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto font-mono break-all"
          >
            {sample === null ? '(encryption unavailable)' : sample.hex}
          </code>
        </section>
      </div>
      <p className="text-muted-foreground text-xs leading-[1.43]">
        This is all our servers see. Without your password, it&apos;s meaningless.
      </p>
    </div>
  );
}

export { EncryptionDemo };
