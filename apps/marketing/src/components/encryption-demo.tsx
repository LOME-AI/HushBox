import * as React from 'react';
import { cn, buttonVariants } from '@hushbox/ui';
import { generateKeyPair, encryptTextForEpoch } from '@hushbox/crypto';

type EncryptionDemoProps = React.ComponentProps<'div'>;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function EncryptionDemo({ className, ...props }: Readonly<EncryptionDemoProps>): React.JSX.Element {
  const [text, setText] = React.useState('This is private.');
  const [showEncrypted, setShowEncrypted] = React.useState(false);

  const demoPublicKey = React.useMemo(() => generateKeyPair().publicKey, []);

  const cipherHex = React.useMemo(() => {
    try {
      const blob = encryptTextForEpoch(demoPublicKey, text || 'demo');
      return toHex(blob);
    } catch {
      return '(encryption unavailable)';
    }
  }, [demoPublicKey, text]);

  return (
    <div
      data-slot="encryption-demo"
      className={cn('space-y-4 overflow-hidden rounded-lg border-2 p-4 sm:p-6', className)}
      {...props}
    >
      <h3 className="font-semibold">See it for yourself</h3>

      <div>
        <label className="text-muted-foreground text-xs">What you type:</label>
        <input
          type="text"
          value={text}
          onChange={(e): void => {
            setText(e.target.value);
          }}
          className="bg-background mt-1 w-full rounded-md border px-3 py-2 text-sm"
        />
      </div>

      <button
        type="button"
        onClick={(): void => {
          setShowEncrypted((previous) => !previous);
        }}
        className={buttonVariants({
          variant: showEncrypted ? 'outline' : 'default',
          size: 'sm',
        })}
      >
        {showEncrypted ? 'Show readable' : "Show what's stored"}
      </button>

      <div
        className={cn(
          'min-h-[3rem] rounded-md px-3 py-2 transition-colors duration-300 sm:px-4 sm:py-3',
          showEncrypted ? 'bg-muted' : 'bg-muted/30'
        )}
      >
        {showEncrypted ? (
          <code
            data-testid="cipher-output"
            className="text-muted-foreground font-mono text-sm break-all"
          >
            {cipherHex}
          </code>
        ) : (
          <p className="text-sm">{text || '(type something above)'}</p>
        )}
      </div>

      <p
        className={cn(
          'text-muted-foreground text-xs transition-opacity duration-300',
          showEncrypted ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      >
        &uarr; This is all our servers see. Without your password, it&apos;s meaningless.
      </p>
    </div>
  );
}

export { EncryptionDemo, type EncryptionDemoProps };
