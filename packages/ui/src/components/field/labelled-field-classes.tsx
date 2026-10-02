/**
 * A labelled field's frame: the stack that sets its label above the control, the label, the
 * column holding the control with its help and message rows, and the help line. A control
 * drawn outside `SelectField`, such as an in-row input beside one, takes the same frame from
 * here so the two line up. The literals stay in a `.tsx` file because the shared stylesheet's
 * class scan of `packages/ui` reads `.tsx` files only.
 */
export const LABELLED_FIELD_CLASSES = {
  stack: 'flex min-w-0 flex-col gap-2',
  label: 'text-foreground text-sm font-medium',
  control: 'flex min-w-0 flex-col',
  help: 'text-muted-foreground mt-2 text-xs',
} as const;
