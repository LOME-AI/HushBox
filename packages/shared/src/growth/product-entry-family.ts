/**
 * The family label the marketing hourly view stamps on its campaign-free
 * product-entry rows, and the value a reader filters that family by.
 *
 * One constant rather than a literal on each side: the view writes the label
 * into its own SQL text and the dashboard selects rows by it, so two spellings
 * that must agree would drift silently — the filter would match no row and
 * report zero entrants, which reads exactly like an hour nobody clicked in. No
 * compiler and no gate sees that disagreement, so the only thing that prevents
 * it is there being one spelling to import.
 */
export const GROWTH_PRODUCT_ENTRY_FAMILY = 'product-entry';
