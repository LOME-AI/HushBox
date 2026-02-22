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
