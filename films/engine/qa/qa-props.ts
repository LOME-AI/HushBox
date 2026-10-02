/** The input props of the contrast gate's background pass: the look draws everything but its text. */
export const HIDDEN_TEXT_PROPS = { qaHideText: true } as const;

/**
 * The containment pair's input props: the look's own pixels, the post chain
 * skipped, with its text and without. Motion blur stays on in both.
 */
export const UNFINISHED_TEXT_PROPS = { qaSkipPost: true } as const;
export const UNFINISHED_HIDDEN_TEXT_PROPS = { qaSkipPost: true, qaHideText: true } as const;

function readFlag(inputProps: Readonly<Record<string, unknown>>, name: string): boolean {
  const value = inputProps[name];
  if (value === undefined) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new TypeError(`input prop ${name} must be true or false, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Whether the input props ask for the text to be hidden; `qaHideText` is a boolean or absent. */
export function readQaHideText(inputProps: Readonly<Record<string, unknown>>): boolean {
  return readFlag(inputProps, 'qaHideText');
}

/** Whether the input props ask for the post chain to be skipped; `qaSkipPost` is a boolean or absent. */
export function readQaSkipPost(inputProps: Readonly<Record<string, unknown>>): boolean {
  return readFlag(inputProps, 'qaSkipPost');
}
