import * as React from 'react';
import { TextField } from '@hushbox/ui/field';
import { Mail } from '@hushbox/ui/icons';

type IdentifierInputProps = Omit<
  React.ComponentProps<'input'>,
  'type' | 'autoComplete' | 'placeholder' | 'size'
> & {
  error?: string | undefined;
  success?: string | undefined;
};

export function IdentifierInput({
  error,
  success,
  ...props
}: Readonly<IdentifierInputProps>): React.JSX.Element {
  return (
    <TextField
      label="Email or Username"
      type="text"
      autoComplete="username"
      icon={Mail}
      {...(error === undefined ? {} : { error })}
      {...(success === undefined ? {} : { success })}
      {...props}
    />
  );
}
