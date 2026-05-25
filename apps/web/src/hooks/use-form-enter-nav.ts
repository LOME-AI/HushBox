import { useEffect, type RefObject } from 'react';

const SKIP_TYPES = new Set([
  'checkbox',
  'radio',
  'hidden',
  'file',
  'range',
  'color',
  'image',
  'reset',
  'submit',
  'button',
]);

function getNavigableInputs(form: HTMLFormElement): HTMLInputElement[] {
  return [...form.querySelectorAll<HTMLInputElement>('input')].filter(
    (input) => !input.disabled && !SKIP_TYPES.has(input.type)
  );
}

function isNavigableEnter(e: KeyboardEvent): e is KeyboardEvent & { target: HTMLInputElement } {
  if (e.key !== 'Enter') return false;
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (!(e.target instanceof HTMLInputElement)) return false;
  return !SKIP_TYPES.has(e.target.type) && !e.target.disabled;
}

// Find the form's first enabled submit button. A button outside the form
// with form="<id>" is associated with that form per the HTML spec and
// counts here. We click() instead of calling form.requestSubmit() so the
// button's own onClick fires too — this lets ActionModal-style modals
// (whose submit logic is on the button click handler, not the form's
// onSubmit) route Enter through their primary action.
function findSubmitButton(form: HTMLFormElement): HTMLButtonElement | null {
  const submitSelector = 'button[type="submit"]:not([disabled]):not([aria-disabled="true"])';
  const inside = form.querySelector<HTMLButtonElement>(submitSelector);
  if (inside) return inside;
  // Outside the form, scan all enabled submit buttons and use the native
  // `button.form` back-reference (set by the browser when parsing `form="<id>"`)
  // to find ours. Avoids interpolating `form.id` into a CSS selector, which
  // would break for ids containing `"` or `\`.
  for (const candidate of document.querySelectorAll<HTMLButtonElement>(submitSelector)) {
    if (candidate.form === form) return candidate;
  }
  return null;
}

export function useFormEnterNav(formRef: RefObject<HTMLFormElement | null>): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!isNavigableEnter(e)) return;

      const form = formRef.current;
      if (!form) return;

      const inputs = getNavigableInputs(form);
      const currentIndex = inputs.indexOf(e.target);
      if (currentIndex === -1) return;

      e.preventDefault();
      if (currentIndex < inputs.length - 1) {
        inputs[currentIndex + 1]?.focus();
        return;
      }
      const submitButton = findSubmitButton(form);
      if (submitButton) {
        submitButton.click();
      } else {
        form.requestSubmit();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [formRef]);
}
