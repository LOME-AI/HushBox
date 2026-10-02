import { deriveEventName } from './event-name.ts';

/**
 * The auto-captured event names that marketing anchors pointing at
 * `routePaths` fire under.
 *
 * Two readers decide by this one answer: the beacon, which decides whether a
 * click joins the campaign-free product-entry set, and the funnel view, whose
 * entry step filters the campaign-keyed event rows. They are labelled the same
 * thing on the dashboard, so a second spelling on either side would leave two
 * tiles counting different event sets under one label.
 *
 * Derived rather than written: the beacon stores whatever
 * {@link deriveEventName} produced from the page's own markup, so a literal
 * here would be a second spelling of the same name that has to agree to be
 * correct. Throws when a path yields no legal name, because a filter naming
 * something nothing ever writes reports zero clicks and looks healthy.
 *
 * Takes the destinations rather than reaching for them, so each caller names
 * the list it counts and this stays a pure mapping.
 */
export function productEntryEventNames(routePaths: readonly string[]): readonly string[] {
  return routePaths.map((routePath) => {
    const name = deriveEventName({
      tagName: 'a',
      textContent: null,
      getAttribute: (attribute) => (attribute === 'href' ? routePath : null),
    });
    if (name === null) {
      throw new Error(`no growth event name derives from the route path '${routePath}'`);
    }
    return name;
  });
}
