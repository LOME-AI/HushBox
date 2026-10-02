import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Mail } from 'lucide-react';
import { TextField } from './text-field';

// The test DOM computes no Tailwind CSS and does not track `:placeholder-shown`,
// so the floating label's CSS-only states are read as class tokens here; how they
// render is checked by eye on /dev/kit.

/** The floated look, keyed to the input's own state rather than to a React prop. */
const FLOATED_ON_INPUT_STATE = [
  'peer-[:is(:focus,:autofill,:not(:placeholder-shown))]:top-2',
  'peer-[:is(:focus,:autofill,:not(:placeholder-shown))]:translate-y-0',
  'peer-[:is(:focus,:autofill,:not(:placeholder-shown))]:text-xs',
  'peer-[:is(:focus,:autofill,:not(:placeholder-shown))]:text-primary',
];

function tokens(element: Element): string[] {
  return element.className.split(/\s+/);
}

/** Each property the element's transition classes name, or the class itself for a preset. */
function transitionProperties(element: Element): string[] {
  return tokens(element)
    .filter((token) => token.startsWith('transition'))
    .flatMap((token) => {
      const list = /^transition-\[(.+)\]$/.exec(token)?.[1];
      return list === undefined ? [token] : list.split(',');
    });
}

function labelOf(text: string): HTMLElement {
  const label = screen.getByText(text, { selector: 'label' });
  return label;
}

function messageRow(input: HTMLElement): HTMLElement {
  const id = input.getAttribute('aria-describedby') ?? '';
  const row = document.querySelector(`[id="${id.split(' ').at(-1) ?? ''}"]`);
  if (!(row instanceof HTMLElement)) throw new Error('no message row');
  return row;
}

describe('TextField', () => {
  describe('the label', () => {
    it('names the input', () => {
      render(<TextField label="Username" />);

      expect(screen.getByLabelText('Username').tagName).toBe('INPUT');
    });

    it('gives the input a blank placeholder so its emptiness is visible to CSS', () => {
      render(<TextField label="Username" />);

      expect(screen.getByLabelText('Username')).toHaveAttribute('placeholder', ' ');
    });

    it('marks the input as the peer the label reads', () => {
      render(<TextField label="Username" />);

      expect(tokens(screen.getByLabelText('Username'))).toContain('peer');
    });

    it('follows the input so the peer selector can reach it', () => {
      render(<TextField label="Username" />);

      const input = screen.getByLabelText('Username');
      expect(input.nextElementSibling).toBe(labelOf('Username'));
    });

    it('sits centred in muted ink while the field is empty', () => {
      render(<TextField label="Username" />);

      expect(tokens(labelOf('Username'))).toEqual(
        expect.arrayContaining(['top-1/2', '-translate-y-1/2', 'text-sm', 'text-muted-foreground'])
      );
    });

    it('floats on focus, fill or autofill by the input state alone', () => {
      render(<TextField label="Username" />);

      expect(tokens(labelOf('Username'))).toEqual(expect.arrayContaining(FLOATED_ON_INPUT_STATE));
    });

    it('keeps floating for an uncontrolled input once text is typed', async () => {
      const user = userEvent.setup();
      render(<TextField label="Username" />);
      const input = screen.getByLabelText('Username');

      await user.type(input, 'alice');
      await user.tab();

      expect(input).toHaveValue('alice');
      expect(tokens(labelOf('Username'))).toEqual(expect.arrayContaining(FLOATED_ON_INPUT_STATE));
    });

    it('carries no floated look that depends on a value prop', () => {
      render(<TextField label="Username" defaultValue="alice" />);

      expect(tokens(labelOf('Username'))).not.toContain('top-2');
    });

    it('moves past a leading icon', () => {
      render(<TextField label="Email" icon={Mail} />);

      expect(tokens(labelOf('Email'))).toContain('left-10');
    });

    it('lets the pointer reach the input through it', () => {
      render(<TextField label="Username" />);

      expect(tokens(labelOf('Username'))).toContain('pointer-events-none');
    });

    it('dims with a disabled input', () => {
      render(<TextField label="Amount" disabled />);

      expect(tokens(labelOf('Amount'))).toContain('peer-disabled:opacity-50');
    });
  });

  describe('without a visible label', () => {
    it('names the input by its aria-label', () => {
      render(<TextField aria-label="Search chats" placeholder="Search chats" />);

      expect(screen.getByRole('textbox', { name: 'Search chats' })).toBeInTheDocument();
    });

    it('shows the caller placeholder', () => {
      render(<TextField aria-label="Search chats" placeholder="Search chats" />);

      expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Search chats');
    });

    it('draws no label element', () => {
      const { container } = render(
        <TextField aria-label="Search chats" placeholder="Search chats" />
      );

      expect(container.querySelector('label')).toBeNull();
    });

    it('pads the input evenly', () => {
      render(<TextField aria-label="Search chats" placeholder="Search chats" />);

      expect(tokens(screen.getByRole('textbox'))).toContain('py-3');
    });

    it('rejects a field with neither a label nor an aria-label', () => {
      // A field no one can name must not compile, so the directive is the assertion.
      // @ts-expect-error -- a label, or an aria-label with a placeholder, is required
      render(<TextField />);
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('rejects a placeholder beside a visible label', () => {
      // @ts-expect-error -- a visible label owns the placeholder slot
      render(<TextField label="Username" placeholder="alice" />);
      expect(screen.getByLabelText('Username')).toBeInTheDocument();
    });

    it('rejects an aria-label without a placeholder', () => {
      // @ts-expect-error -- an unlabelled field shows its name as the placeholder
      render(<TextField aria-label="Search chats" />);
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });
  });

  describe('the multiline form', () => {
    it('renders a textarea', () => {
      render(<TextField multiline label="What you type" />);

      expect(screen.getByLabelText('What you type').tagName).toBe('TEXTAREA');
    });

    it('floats its label at the top in red while empty and unfocused', () => {
      render(<TextField multiline label="What you type" />);

      expect(tokens(labelOf('What you type'))).toEqual(
        expect.arrayContaining(['top-2', 'text-xs', 'text-primary'])
      );
    });

    it('never centres its label', () => {
      render(<TextField multiline label="What you type" />);

      expect(tokens(labelOf('What you type'))).not.toContain('top-1/2');
    });

    it('takes its height from the caller class', () => {
      render(<TextField multiline label="What you type" className="h-52" />);

      expect(tokens(screen.getByLabelText('What you type'))).toContain('h-52');
    });

    it('passes textarea props straight through', () => {
      render(<TextField multiline label="What you type" spellCheck={false} rows={4} />);

      const textarea = screen.getByLabelText('What you type');
      expect(textarea).toHaveAttribute('spellcheck', 'false');
      expect(textarea).toHaveAttribute('rows', '4');
    });

    it('wires an error the same way as the single-line form', () => {
      render(<TextField multiline label="What you type" error="Too long" />);

      const textarea = screen.getByLabelText('What you type');
      expect(textarea).toHaveAttribute('aria-invalid', 'true');
      expect(messageRow(textarea)).toHaveTextContent('Too long');
    });
  });

  describe('the box', () => {
    it('draws a 2px control border at the 8px radius', () => {
      render(<TextField label="Username" />);

      expect(tokens(screen.getByLabelText('Username'))).toEqual(
        expect.arrayContaining(['border-2', 'border-border-control', 'rounded-lg'])
      );
    });

    it('turns its border red on focus', () => {
      render(<TextField label="Username" />);

      expect(tokens(screen.getByLabelText('Username'))).toContain('focus:border-primary');
    });

    it('leaves the shared focus outline to draw', () => {
      render(<TextField label="Username" />);

      const outlineTokens = tokens(screen.getByLabelText('Username')).filter((token) =>
        token.includes('outline')
      );
      expect(outlineTokens).toEqual([]);
    });

    it('transitions no outline property, so the focus outline appears at once', () => {
      render(<TextField label="Username" />);

      const properties = transitionProperties(screen.getByLabelText('Username'));
      expect(properties.length).toBeGreaterThan(0);
      expect(
        properties.filter((property) =>
          /outline|^all$|^transition$|^transition-(all|colors)$/.test(property)
        )
      ).toEqual([]);
    });

    it('eases its border colour', () => {
      render(<TextField label="Username" />);

      expect(transitionProperties(screen.getByLabelText('Username'))).toContain('border-color');
    });

    it('draws a destructive border with an error', () => {
      render(<TextField label="Email" error="Enter a valid email address" />);

      const input = screen.getByLabelText('Email');
      expect(tokens(input)).toContain('border-destructive');
      expect(tokens(input)).not.toContain('focus:border-primary');
    });

    it('fades to half opacity when disabled', () => {
      render(<TextField label="Amount" disabled />);

      const input = screen.getByLabelText('Amount');
      expect(input).toBeDisabled();
      expect(tokens(input)).toContain('disabled:opacity-50');
    });

    it('pads for a floating label', () => {
      render(<TextField label="Username" />);

      expect(tokens(screen.getByLabelText('Username'))).toEqual(
        expect.arrayContaining(['pt-6', 'pb-2', 'px-3'])
      );
    });
  });

  describe('the message row', () => {
    it('is always rendered', () => {
      const { container } = render(<TextField label="Username" id="username" />);

      expect(container.querySelector('#username-message')).toBeEmptyDOMElement();
    });

    it('keeps its top margin while empty', () => {
      const { container } = render(<TextField label="Username" id="username" />);

      expect(tokens(container.querySelector('#username-message') ?? document.body)).toContain(
        'mt-1'
      );
    });

    it('keeps its top margin while empty in the multiline form', () => {
      const { container } = render(<TextField multiline label="Notes" id="notes" />);

      expect(tokens(container.querySelector('#notes-message') ?? document.body)).toContain('mt-1');
    });

    it('is not referenced while it is empty', () => {
      render(<TextField label="Username" />);

      expect(screen.getByLabelText('Username')).not.toHaveAttribute('aria-describedby');
    });

    it('marks the input invalid with an error', () => {
      render(<TextField label="Email" error="Enter a valid email address" />);

      expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    });

    it('describes the input by the row holding the error', () => {
      render(<TextField label="Email" error="Enter a valid email address" />);

      expect(messageRow(screen.getByLabelText('Email'))).toHaveTextContent(
        'Enter a valid email address'
      );
    });

    it('announces the error as an alert', () => {
      render(<TextField label="Email" error="Enter a valid email address" />);

      expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address');
    });

    it('shows a success line without an alert', () => {
      render(<TextField label="Username" success="Username is available" />);

      const input = screen.getByLabelText('Username');
      expect(messageRow(input)).toHaveTextContent('Username is available');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('describes the input by a success line when the error is empty', () => {
      render(<TextField label="Username" error="" success="Looks good" />);

      expect(messageRow(screen.getByLabelText('Username'))).toHaveTextContent('Looks good');
    });

    it('leaves the input valid with a success line', () => {
      render(<TextField label="Username" success="Username is available" />);

      expect(screen.getByLabelText('Username')).not.toHaveAttribute('aria-invalid');
    });

    it('keeps a description the caller gave beside its own', () => {
      render(
        <>
          <p id="hint">Letters and numbers</p>
          <TextField label="Username" aria-describedby="hint" error="Taken" />
        </>
      );

      const describedBy = screen.getByLabelText('Username').getAttribute('aria-describedby');
      expect(describedBy?.split(' ')).toEqual(['hint', expect.stringMatching(/-message$/)]);
    });
  });

  describe('the icon and suffix', () => {
    it('draws the leading icon hidden from assistive technology', () => {
      const { container } = render(<TextField label="Email" icon={Mail} />);

      expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    });

    it('sets the icon 0.75rem in, centred on the field', () => {
      const { container } = render(<TextField label="Email" icon={Mail} />);

      const svg = container.querySelector('svg');
      if (svg === null) throw new Error('no icon');
      expect(svg.getAttribute('class')?.split(' ')).toEqual(
        expect.arrayContaining(['absolute', 'left-3', 'top-1/2', '-translate-y-1/2'])
      );
    });

    it('pads the input past the icon', () => {
      render(<TextField label="Email" icon={Mail} />);

      expect(tokens(screen.getByLabelText('Email'))).toContain('pl-10');
    });

    it('renders the suffix centred on the field at half-strength ink', () => {
      render(
        <TextField
          label="Password"
          suffix={
            <button type="button" aria-label="Show password">
              eye
            </button>
          }
        />
      );

      const holder = screen.getByRole('button', { name: 'Show password' }).parentElement;
      if (holder === null) throw new Error('no suffix holder');
      expect(tokens(holder)).toEqual(
        expect.arrayContaining([
          'absolute',
          'right-3',
          'top-1/2',
          '-translate-y-1/2',
          'text-foreground/50',
        ])
      );
    });

    it('pads the input past the suffix', () => {
      render(<TextField label="Password" suffix={<span>hint</span>} />);

      expect(tokens(screen.getByLabelText('Password'))).toContain('pr-11');
    });
  });

  describe('native props', () => {
    it('uses the caller id on the input', () => {
      render(<TextField label="Name" id="op-field-name" />);

      expect(screen.getByLabelText('Name')).toHaveAttribute('id', 'op-field-name');
    });

    it('names the message row after the caller id', () => {
      render(<TextField label="Name" id="op-field-name" error="Required" />);

      expect(screen.getByLabelText('Name')).toHaveAttribute(
        'aria-describedby',
        'op-field-name-message'
      );
    });

    it('hands onChange the native change event', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn<(event: React.ChangeEvent<HTMLInputElement>) => void>();
      render(<TextField label="Username" onChange={onChange} />);

      await user.type(screen.getByLabelText('Username'), 'a');

      expect(onChange.mock.calls[0]?.[0].target.value).toBe('a');
    });

    it('passes onKeyDown through', async () => {
      const user = userEvent.setup();
      const onKeyDown = vi.fn();
      render(<TextField label="Username" onKeyDown={onKeyDown} />);

      await user.type(screen.getByLabelText('Username'), '{Enter}');

      expect(onKeyDown).toHaveBeenCalledOnce();
    });

    it('passes role and aria attributes through', () => {
      render(
        <TextField label="Model" role="combobox" aria-expanded={false} aria-controls="model-list" />
      );

      const input = screen.getByRole('combobox', { name: 'Model' });
      expect(input).toHaveAttribute('aria-expanded', 'false');
      expect(input).toHaveAttribute('aria-controls', 'model-list');
    });

    it('passes autocomplete, name and type through', () => {
      render(
        <TextField
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
        />
      );

      const input = screen.getByLabelText('Password');
      expect(input).toHaveAttribute('type', 'password');
      expect(input).toHaveAttribute('name', 'password');
      expect(input).toHaveAttribute('autocomplete', 'current-password');
    });

    it('hands the ref to the input', () => {
      const ref = React.createRef<HTMLInputElement>();
      render(<TextField label="Username" ref={ref} />);

      expect(ref.current).toBe(screen.getByLabelText('Username'));
    });

    it('keeps the caller aria-invalid when there is no error', () => {
      render(<TextField label="Username" aria-invalid />);

      expect(screen.getByLabelText('Username')).toHaveAttribute('aria-invalid', 'true');
    });
  });

  describe('the error test id', () => {
    it('lands on the error line', () => {
      render(<TextField label="Username" error="Taken" errorTestId="field-error" />);

      expect(screen.getByTestId('field-error')).toBe(screen.getByRole('alert'));
    });

    it('lands on the error line in the multiline form', () => {
      render(<TextField multiline label="Notes" error="Too long" errorTestId="field-error" />);

      expect(screen.getByTestId('field-error')).toBe(screen.getByRole('alert'));
    });

    it('never reaches the input', () => {
      render(<TextField label="Username" errorTestId="field-error" />);

      expect(screen.getByLabelText('Username')).not.toHaveAttribute('errortestid');
    });
  });
});
