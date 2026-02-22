import * as React from 'react';

interface AuthShakeErrorProps {
  error: string | null;
  errorKey: number;
}

export function AuthShakeError({
  error,
  errorKey,
}: Readonly<AuthShakeErrorProps>): React.JSX.Element | null {
  if (!error) return null;

  return (
    <p key={errorKey} role="alert" className="text-destructive animate-shake text-center text-sm">
      {error}
    </p>
  );
}
