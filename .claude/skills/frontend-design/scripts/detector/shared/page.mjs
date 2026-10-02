/** Check if content looks like a full page (not a component/partial) */
/** @param {string} content */
function isFullPage(content) {
  const stripped = content.replace(/<!--[\s\S]*?-->/g, '');
  return /<!doctype\s|<html[\s>]|<head[\s>]/i.test(stripped);
}

/**
 * The text a source's body states, as a reader sees it.
 *
 * Script and style are program text rather than copy, a comment is not rendered
 * at all, and a run of whitespace in normal flow renders as one space. Every
 * rule that judges copy reads through this one reading, because two of them
 * disagreeing about whether a phrase written across a line break is one phrase
 * is two rules disagreeing about what the page says. The three questions this
 * settles are settled the way a browser settles them, which is where the answers
 * came from: `innerText` of a body drops comments and collapses whitespace.
 *
 * @param {string} html
 * @returns {string}
 */
function stripHtmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * The scope a verdict claims, declared by the verdict itself.
 *
 * A document-scope verdict is one a fragment of a page can answer differently
 * from the page it was cut out of: the fonts the page settles on, its spacing
 * rhythm, its heading outline, its own surface, the copy it states in
 * aggregate. Every other verdict that carries this vocabulary is read off markup
 * that means the same wherever it sits, so it is answerable on a component
 * source and this is the value it leaves undeclared.
 */
const SCOPE_DOCUMENT = 'document';

/**
 * The page gate: which verdicts a source of component shape may carry. It is
 * the whole of that decision in this detector — both engines reach it, and no
 * page-scope verdict is collected past it.
 *
 * The membership is derived rather than listed — it is whatever declared
 * {@link SCOPE_DOCUMENT} at the point its verdict was reached, so a rule joins
 * the gate only by saying so beside the claim it makes, and a rule whose
 * verdict passes through here reports everywhere until someone states
 * otherwise. That direction is deliberate: an element-side rule written behind
 * a page-side gate went silent on exactly the component sources it was for, and
 * a rule that over-reports is visible while a rule that is silent is not.
 *
 * WHAT THIS DOES NOT DECIDE, because it is a different question about a
 * different property of the source: whether a source's text is copy a reader
 * sees at all. A `.ts` file holding a page in a template literal is
 * page-shaped and its text is program text, and that is settled where a source
 * type is known rather than here, where only the characters are.
 *
 * @template {{ scope?: string }} T
 * @param {string} content
 * @param {readonly T[]} findings
 * @returns {T[]}
 */
function reportableOnSource(content, findings) {
  if (isFullPage(content)) return [...findings];
  return findings.filter((f) => f.scope !== SCOPE_DOCUMENT);
}

export { SCOPE_DOCUMENT, isFullPage, reportableOnSource, stripHtmlToText };
