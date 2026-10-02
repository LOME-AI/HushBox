import { cn } from '../../lib/utilities';

type ButtonVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'link'
  | 'destructive'
  | 'bare';
type ButtonSize = 'sm' | 'default' | 'lg' | 'xl';
type DrawnVariant = Exclude<ButtonVariant, 'bare'>;

/** What every button keeps whatever it draws: the cursor for each state. */
const BUTTON_CURSOR =
  'cursor-pointer disabled:cursor-not-allowed aria-disabled:cursor-not-allowed aria-busy:cursor-progress';

// The transition names its properties so the focus outline, drawn by the base layer,
// appears at once; `transition-all` and `transition-colors` both carry the outline.
const BUTTON_FRAME = cn(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent text-sm font-medium whitespace-nowrap select-none',
  'transition-[color,background-color,border-color,box-shadow,opacity]',
  'focus-visible:border-ring aria-invalid:border-destructive',
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
);

const BUTTON_TOUCH = 'pointer-coarse:min-h-11';

const VARIANT_LOOK: Record<DrawnVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline:
    'border-border-control bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:hover:bg-input/50',
  ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
  link: 'text-primary underline-offset-4 hover:underline',
  destructive: 'bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/60',
};

// Disabled is neutral in every variant: a filled button takes the subtle fill, the
// others go transparent, and all take the disabled ink.
const FILLED_DISABLED =
  'disabled:border-border disabled:bg-muted disabled:text-disabled-ink aria-disabled:border-border aria-disabled:bg-muted aria-disabled:text-disabled-ink';

const CLEAR_DISABLED =
  'disabled:bg-transparent disabled:text-disabled-ink disabled:no-underline aria-disabled:bg-transparent aria-disabled:text-disabled-ink aria-disabled:no-underline';

const VARIANT_DISABLED: Record<DrawnVariant, string> = {
  default: FILLED_DISABLED,
  secondary: FILLED_DISABLED,
  outline: cn(
    'disabled:border-border disabled:text-disabled-ink disabled:bg-transparent disabled:shadow-none dark:disabled:bg-transparent',
    'aria-disabled:border-border aria-disabled:text-disabled-ink aria-disabled:bg-transparent aria-disabled:shadow-none dark:aria-disabled:bg-transparent'
  ),
  ghost: CLEAR_DISABLED,
  link: CLEAR_DISABLED,
  destructive: cn(FILLED_DISABLED, 'dark:disabled:bg-muted dark:aria-disabled:bg-muted'),
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 has-[>svg]:px-2.5',
  default: 'h-9 px-4 py-2 has-[>svg]:px-3',
  lg: 'h-10 px-6 has-[>svg]:px-4',
  xl: 'h-14 rounded-sm px-4 font-black has-[>svg]:px-3',
};

// A link is text: it drops the size's box, whatever size it is given.
const LINK_BOX = 'h-auto rounded-xs border-0 px-0 py-0 has-[>svg]:px-0';

/** The frame and resting look of a drawn variant, without its cursor, box or disabled look. */
function buttonLookClasses(variant: DrawnVariant): string {
  return cn(BUTTON_FRAME, VARIANT_LOOK[variant]);
}

/** The frame and look of a drawn variant, cursor and disabled look included, without its box. */
function drawnButtonClasses(variant: DrawnVariant): string {
  return cn(BUTTON_CURSOR, buttonLookClasses(variant), VARIANT_DISABLED[variant]);
}

// A block button's space decides its width: it fills a parent 40rem or narrower and keeps
// its own width, at least 12rem, centred, in a wider one; `(40rem - 100%) * 1e4` is far above
// the parent's width up to 40rem and far below zero beyond it (the button group classes state
// the factor's bound). Inside a button group the group's member rules win only by stylesheet
// order, at equal specificity; the kit's button-groups browser test pins it by computed width.
const BLOCK_WIDTH =
  'data-block:mx-auto data-block:flex data-block:w-full data-block:max-w-[max(12rem,100%_+_(40rem_-_100%)_*_1e4)] data-block:min-w-fit';

// A wrappable label caps `min-w-fit` at the parent's width, so a label too long for one
// line wraps, centred, and never pushes a block button past its space. The wrap and height
// rules also hold for any button inside a group marked `data-wrap-labels`, which
// `measureButtonGroups` sets on every button group; a button side by side in a row holds at
// least its widest label's width, so its label never wraps there. The `:is()` keeps their
// specificity that of `data-block:` alone, so the group's member rules still win by order.
const BLOCK_WRAP =
  '[&:is([data-block],[data-wrap-labels]_*)]:whitespace-normal [&:is([data-block],[data-wrap-labels]_*)]:text-center [&:is([data-block],[data-wrap-labels]_*)]:wrap-anywhere';

// Inside a row of two or more labelled buttons, a button never narrows below the row's
// widest label, and once the labels cannot all share a line the row stacks, as a
// label-driven row does. Stacked in a group 40rem or narrower, a button takes the whole
// width; in a wider one it keeps the members' width, at least 12rem and the widest label,
// and equal inline margins fill the rest of its line, so it stands alone there, centred.
// While the labels fit, the floor sits at or under each button's share and the margins are
// 0. `--btn-eq` and `--btn-count` come from `measureButtonGroups`; 0.5rem, 12rem and 40rem
// are the group classes' gap, member floor and width switch, and 1e4 their factor. The
// `:not()` lifts both rules above the group's own `min-w-0` and `mx-0` member rules.
const SHARED_ROW_FLOOR =
  '[[data-wrap-labels=shared]>&:not([data-slot=icon-button])]:min-w-[min(100%,max(12rem,var(--btn-eq,0px),100%_+_(40rem_-_100%)_*_1e4),max(var(--btn-eq,0px),(var(--btn-count,1)_*_var(--btn-eq,0px)_+_(var(--btn-count,1)_-_1)_*_0.5rem_-_100%)_*_1e4))] [[data-wrap-labels=shared]>&:not([data-slot=icon-button])]:mx-[max(0px,min((100%_-_max(12rem,var(--btn-eq,0px)))_/_2,(var(--btn-count,1)_*_var(--btn-eq,0px)_+_(var(--btn-count,1)_-_1)_*_0.5rem_-_100%)_*_1e4,(100%_-_40rem)_*_1e4))]';

// A block button's size height becomes a floor, so wrapped lines grow it. Each padding
// leaves a one-line label inside the floor, keeping that button at its exact height. The
// block floor outranks the plain touch floor, so a size under 2.75rem restates it.
const BLOCK_HEIGHT: Record<ButtonSize, string> = {
  sm: '[&:is([data-block],[data-wrap-labels]_*)]:h-auto [&:is([data-block],[data-wrap-labels]_*)]:min-h-8 [&:is([data-block],[data-wrap-labels]_*)]:py-1 [&:is([data-block],[data-wrap-labels]_*)]:pointer-coarse:min-h-11',
  default:
    '[&:is([data-block],[data-wrap-labels]_*)]:h-auto [&:is([data-block],[data-wrap-labels]_*)]:min-h-9 [&:is([data-block],[data-wrap-labels]_*)]:py-1.5 [&:is([data-block],[data-wrap-labels]_*)]:pointer-coarse:min-h-11',
  lg: '[&:is([data-block],[data-wrap-labels]_*)]:h-auto [&:is([data-block],[data-wrap-labels]_*)]:min-h-10 [&:is([data-block],[data-wrap-labels]_*)]:py-2 [&:is([data-block],[data-wrap-labels]_*)]:pointer-coarse:min-h-11',
  xl: '[&:is([data-block],[data-wrap-labels]_*)]:h-auto [&:is([data-block],[data-wrap-labels]_*)]:min-h-14 [&:is([data-block],[data-wrap-labels]_*)]:py-3',
};

function buttonVariants({
  variant = 'default',
  size = 'default',
}: Readonly<{ variant?: ButtonVariant; size?: ButtonSize }>): string {
  if (variant === 'bare') return BUTTON_CURSOR;
  return cn(
    drawnButtonClasses(variant),
    BUTTON_TOUCH,
    SIZE_CLASSES[size],
    variant === 'link' ? LINK_BOX : BLOCK_HEIGHT[size],
    BLOCK_WIDTH,
    BLOCK_WRAP,
    SHARED_ROW_FLOOR
  );
}

export {
  buttonLookClasses,
  buttonVariants,
  drawnButtonClasses,
  type ButtonSize,
  type ButtonVariant,
  type DrawnVariant,
};
