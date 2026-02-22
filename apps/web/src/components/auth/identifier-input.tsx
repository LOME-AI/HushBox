import * as React from 'react';
import { Mail } from 'lucide-react';
import { FormInput, type FormInputProps } from '@/components/shared/form-input';

type IdentifierInputProps = Omit<FormInputProps, 'label' | 'type' | 'autoComplete' | 'icon'>;

export function IdentifierInput(props: Readonly<IdentifierInputProps>): React.JSX.Element {
  return (
    <FormInput
      label="Email or Username"
      type="text"
      autoComplete="username"
      icon={<Mail className="h-5 w-5" />}
      {...props}
    />
  );
}
