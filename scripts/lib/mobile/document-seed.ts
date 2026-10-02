/**
 * The conversation a mobile-test run seeds for the document flow: who owns it,
 * the assistant message carrying the document, and the request body that
 * creates it.
 */

// The mobile persona (scripts/lib/seed/personas.ts MOBILE_TEST_PERSONA) that
// Maestro logs in as; the seeded HTML-document conversation is owned by it.
export const DOCUMENT_SEED_OWNER_EMAIL = 'test-mobile@test.hushbox.ai';

// A deliberately import-free HTML document (>= MIN_LINES_FOR_DOCUMENT lines, so
// the web parser extracts it as a runnable `html` document) embedded in an
// assistant message. Import-free keeps the on-device render independent of
// esm.sh / the module stub being reachable from the emulator — the heading and
// list are all the render needs to prove execution.
export const DOCUMENT_SEED_MESSAGE = [
  'Here is a simple web page you can preview.',
  '',
  '```html',
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="utf-8" />',
  '    <title>Mobile render proof</title>',
  '  </head>',
  '  <body>',
  '    <main>',
  '      <h1>Mobile render proof</h1>',
  '      <p>This document rendered inside the on-device WebView sandbox.</p>',
  '      <ul>',
  '        <li>First item</li>',
  '        <li>Second item</li>',
  '        <li>Third item</li>',
  '      </ul>',
  '    </main>',
  '  </body>',
  '</html>',
  '```',
].join('\n');

export function documentSeedPayload(): string {
  return JSON.stringify({
    ownerEmail: DOCUMENT_SEED_OWNER_EMAIL,
    // The Maestro flow taps the seeded conversation's chat row by this exact
    // title text; an untitled row renders the placeholder and is untappable.
    title: 'Mobile render proof',
    messages: [
      { content: 'Show me a simple web page.', senderType: 'user' },
      { content: DOCUMENT_SEED_MESSAGE, senderType: 'ai' },
    ],
  });
}
