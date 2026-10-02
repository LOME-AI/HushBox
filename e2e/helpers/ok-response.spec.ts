import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { expectOkResponse, type CheckedResponse, type ExpectedStatus } from './ok-response.js';

const SPEC_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    'The assertion reads a response node-side and builds a message from it. No page is opened, so no rendering engine participates.',
});

/** What the local proxy answers when the Worker behind it drops the connection. */
const PROXY_DROP_BODY = 'Error: Network connection lost.\n    at stack-frame-with-install-path';

function stubResponse(
  status: number,
  headers: Record<string, string>,
  body: string
): CheckedResponse {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    headers: () => headers,
    text: () => Promise.resolve(body),
  };
}

/** The message `expectOkResponse` throws for `response`, or null when it passes. */
async function failureMessage(
  response: CheckedResponse,
  expected?: ExpectedStatus
): Promise<string | null> {
  try {
    await expectOkResponse(response, 'group-chat creation', expected);
    return null;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

const proxyDrop = stubResponse(
  500,
  { 'content-type': 'text/plain;charset=UTF-8' },
  PROXY_DROP_BODY
);

test.describe('A setup response that is not OK', SPEC_MATRIX, () => {
  test('passes a 2xx response', async () => {
    const created = stubResponse(201, { 'content-type': 'application/json' }, '{}');

    expect(await failureMessage(created)).toBeNull();
  });

  test('opens the message with the label, then the status', async () => {
    expect(await failureMessage(proxyDrop)).toMatch(/^group-chat creation failed: 500 /);
  });

  test("names a proxy drop's content type", async () => {
    expect(await failureMessage(proxyDrop)).toContain('text/plain');
  });

  test("quotes the first line of a proxy drop's body", async () => {
    expect(await failureMessage(proxyDrop)).toContain('Network connection lost');
  });

  test('leaves out every body line after the first', async () => {
    expect(await failureMessage(proxyDrop)).not.toContain('stack-frame-with-install-path');
  });

  test('ends the quoted line at a lone carriage return', async () => {
    const crOnly = stubResponse(500, { 'content-type': 'text/plain' }, 'first\rsecond');

    expect(await failureMessage(crOnly)).toMatch(/ first$/);
  });

  test('ends the quoted line at a Unicode line separator', async () => {
    const lineSeparated = stubResponse(500, { 'content-type': 'text/plain' }, 'first\u2028second');

    expect(await failureMessage(lineSeparated)).toMatch(/ first$/);
  });

  test("quotes a handler refusal's code", async () => {
    const refusal = stubResponse(
      500,
      { 'content-type': 'application/json' },
      '{"code":"INTERNAL"}'
    );

    expect(await failureMessage(refusal)).toContain('INTERNAL');
  });

  test('caps the quoted line at 300 characters', async () => {
    const quoted = 'x'.repeat(300);
    const oversized = stubResponse(502, { 'content-type': 'text/plain' }, `${quoted}overflow`);

    expect(await failureMessage(oversized)).toMatch(new RegExp(`${quoted}$`));
  });

  test('passes a response answering the one expected status', async () => {
    const conflict = stubResponse(409, { 'content-type': 'application/json' }, '{}');

    expect(await failureMessage(conflict, 409)).toBeNull();
  });

  test('refuses a success other than the one expected status', async () => {
    const created = stubResponse(201, { 'content-type': 'application/json' }, '{}');

    expect(await failureMessage(created, 200)).toEqual(
      expect.stringMatching(/^group-chat creation failed: 201 /)
    );
  });

  test('passes a response answering any status in the expected set', async () => {
    const conflict = stubResponse(409, { 'content-type': 'application/json' }, '{}');

    expect(await failureMessage(conflict, [200, 409])).toBeNull();
  });

  test('refuses a success outside the expected set', async () => {
    const created = stubResponse(201, { 'content-type': 'application/json' }, '{}');

    expect(await failureMessage(created, [200, 409])).toEqual(
      expect.stringMatching(/^group-chat creation failed: 201 /)
    );
  });

  test('says so when the response names no content type', async () => {
    const bare = stubResponse(503, {}, '');

    expect(await failureMessage(bare)).toContain('no content-type');
  });
});
