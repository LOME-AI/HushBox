/** The class that marks a button group for `measureButtonGroups`; it draws nothing. */
const BUTTON_GROUP_MARKER = 'hb-button-group';

// A button's space decides its width, read through percentages rather than a size
// container: 100% is the group's width, and `(40rem - 100%) * 1e4` is far above the group's
// width while the group is 40rem or narrower and far below zero beyond it, so a max-width
// built on it lets a button fill a narrow group and holds it to max(12rem, the widest label)
// in a wide one. Every switch scales its difference by 1e4: a 1px difference becomes 1e4px,
// wider than any group, and a difference of a few thousand pixels, beyond what any group
// reaches at the largest text, stays under 3e7px. At 1e5 the three-button row's basis
// passed 4e7px at the largest text, and Chromium drew its stacked buttons wider than the row.
// A size container on the group was rejected: it collapses inside a content-sized ancestor.
// Icon buttons keep their own size, so every member rule skips them.
// A member's basis never falls below 4rem, which is more than any button size's inline
// padding and border. Below that, a flex item's base size is its padding, so a button that
// trims its padding beside an icon would start narrower and stay narrower once the row's
// space is shared; above it every member starts from the same basis and ends the same width.

/**
 * The space-driven row: equal widths, stacking in markup order below 18rem for two
 * buttons and below 28rem for three or more.
 */
const buttonRowClass = `${BUTTON_GROUP_MARKER} flex w-full flex-wrap justify-center gap-2 [&>:not([data-slot=icon-button])]:mx-0 [&>:not([data-slot=icon-button])]:min-w-0 [&>:not([data-slot=icon-button])]:flex-[1_1_max(4rem,(18rem_+_0.5px_-_100%)_*_1e4)] [&>:not([data-slot=icon-button])]:max-w-[max(12rem,var(--btn-eq,0px),100%_+_(40rem_-_100%)_*_1e4)] [&>:not([data-slot=icon-button]):nth-last-child(n+3)]:basis-[max(4rem,(28rem_+_0.5px_-_100%)_*_1e4)] [&>:nth-last-child(n+3)~:not([data-slot=icon-button])]:basis-[max(4rem,(28rem_+_0.5px_-_100%)_*_1e4)] [&>*>span]:overflow-hidden [&>*>span]:text-ellipsis`;

/**
 * The label-driven row: side by side while every button's widest label fits an equal
 * share of the row, stacked otherwise. `--btn-count` and `--btn-eq` come from
 * `measureButtonGroups`.
 */
const buttonLabelsRowClass = `${BUTTON_GROUP_MARKER} flex w-full flex-wrap justify-center gap-2 [&>:not([data-slot=icon-button])]:mx-0 [&>:not([data-slot=icon-button])]:min-w-0 [&>:not([data-slot=icon-button])]:flex-[1_1_max(4rem,(var(--btn-count,1)_*_var(--btn-eq,0px)_+_(var(--btn-count,1)_-_1)_*_0.5rem_-_100%)_*_1e4)] [&>:not([data-slot=icon-button])]:max-w-[max(12rem,var(--btn-eq,0px),100%_+_(40rem_-_100%)_*_1e4)]`;

/** Buttons one above another: full width in a group 40rem or narrower, equalised and centred beyond it. */
const buttonStackClass = `${BUTTON_GROUP_MARKER} flex w-full flex-col items-center gap-2 [&>:not([data-slot=icon-button])]:mx-0 [&>:not([data-slot=icon-button])]:w-full [&>:not([data-slot=icon-button])]:min-w-0 [&>:not([data-slot=icon-button])]:max-w-[max(12rem,var(--btn-eq,0px),100%_+_(40rem_-_100%)_*_1e4)]`;

export { BUTTON_GROUP_MARKER, buttonLabelsRowClass, buttonRowClass, buttonStackClass };
