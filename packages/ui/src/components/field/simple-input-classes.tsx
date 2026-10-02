/**
 * The simple input's look, shared by the plain `Input` and `InlineInput`: each adds
 * its own border colour and whatever else sets it apart. The literals stay in a `.tsx`
 * file because the shared stylesheet's class scan of `packages/ui` reads `.tsx` files
 * only.
 */
export const SIMPLE_INPUT_CLASSES =
  'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 h-9 w-full min-w-0 appearance-none rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm focus-visible:border-ring aria-invalid:border-destructive';
