import * as React from 'react';
import { cn } from '../../lib/utilities';
import { buttonVariants } from '../button';

type EncryptionDemoProps = React.ComponentProps<'div'>;

function EncryptionDemo({ className, ...props }: Readonly<EncryptionDemoProps>): React.JSX.Element {
  const [text, setText] = React.useState('This is private.');
  const [showEncrypted, setShowEncrypted] = React.useState(false);

  const cipherText = React.useMemo(() => {
    try {
      return btoa(text);
    } catch {
      return btoa('demo');
    }
  }, [text]);

  return (
    <div
      data-slot="encryption-demo"
      className={cn('space-y-4 overflow-hidden rounded-lg border p-4 sm:p-6', className)}
      {...props}
    >
      <h3 className="text-sm font-semibold">See it for yourself</h3>

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

      <div className="bg-muted/30 relative min-h-[3rem] rounded-md px-3 py-2 sm:px-4 sm:py-3">
        <div
          className={cn(
            'transition-opacity duration-300',
            showEncrypted ? 'opacity-0' : 'opacity-100'
          )}
        >
          <p className="text-sm">{text || '(type something above)'}</p>
        </div>
        <div
          className={cn(
            'bg-muted absolute inset-0 rounded-md px-3 py-2 transition-opacity duration-300 sm:px-4 sm:py-3',
            showEncrypted ? 'opacity-100' : 'pointer-events-none opacity-0'
          )}
        >
          <code className="text-muted-foreground font-mono text-sm break-all">{cipherText}</code>
        </div>
      </div>

      <p
        className={cn(
          'text-muted-foreground text-xs transition-opacity duration-300',
          showEncrypted ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      >
        ↑ This is all our servers see. Without your password, it&apos;s meaningless.
      </p>
    </div>
  );
}

export { EncryptionDemo, type EncryptionDemoProps };
