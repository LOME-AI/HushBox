import { Hono } from 'hono';
import { hc } from 'hono/client';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ERROR_CODES } from '@hushbox/shared';
import { createErrorResponse } from '../errors/index.js';
import { rejectInvalid, respondOk } from './respond.js';
import type { RefusalResponse } from './respond.js';
import type { Context } from 'hono';
import type { ErrorResponse } from '@hushbox/shared';
import type { InferResponseType } from 'hono/client';
import type { JSONParsed } from 'hono/utils/types';

describe('respondOk', () => {
  it('answers 200 with the JSON body unchanged', async () => {
    const app = new Hono().get('/thing', (c) => respondOk(c, { value: 7 }));
    const res = await app.request('/thing');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 7 });
  });

  it('preserves the body type so hc infers the 200 response', async () => {
    const app = new Hono().get('/thing', (c) => respondOk(c, { value: 7 as const }));
    // The client is constructed (a value use of `hc`, no request is made — the
    // base URL is never dereferenced) purely as a `typeof` anchor. The assertion
    // proves `hc<typeof app>` recovers the concrete 200 body type rather than the
    // `unknown` a bare-`Response` tail would leave.
    const _typeClient = hc<typeof app>('http://demo.invalid');
    type Body = Awaited<ReturnType<Awaited<ReturnType<typeof _typeClient.thing.$get>>['json']>>;
    expectTypeOf<Body>().toEqualTypeOf<{ value: 7 }>();
    const res = await app.request('/thing');
    expect(await res.json()).toEqual({ value: 7 });
  });
});

describe('RefusalResponse', () => {
  const refuse = (c: Context): RefusalResponse =>
    c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);

  const refusingApp = new Hono().get('/thing', (c) =>
    c.req.query('deny') === undefined ? respondOk(c, { value: 7 as const }) : refuse(c)
  );

  it('answers the uniform code body at the refusal status', async () => {
    const res = await refusingApp.request('/thing?deny=1');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('leaves the sibling success body inferable rather than collapsing it', () => {
    const _typeClient = hc<typeof refusingApp>('http://demo.invalid');
    expectTypeOf<InferResponseType<typeof _typeClient.thing.$get, 200>>().toEqualTypeOf<{
      value: 7;
    }>();
  });

  it('keeps the refusal body itself typed at its status', () => {
    const _typeClient = hc<typeof refusingApp>('http://demo.invalid');
    expectTypeOf<InferResponseType<typeof _typeClient.thing.$get, 404>>().toEqualTypeOf<
      JSONParsed<ErrorResponse>
    >();
  });
});

describe('rejectInvalid', () => {
  const app = new Hono().post(
    '/thing',
    zValidator('json', z.object({ value: z.number() }), rejectInvalid),
    (c) => respondOk(c, { value: c.req.valid('json').value })
  );

  it('returns no response when the parse succeeded, so the handler runs', async () => {
    const passThroughApp = new Hono().get('/thing', (c) => {
      expect(rejectInvalid({ success: true }, c)).toBeUndefined();
      return respondOk(c, { value: 7 as const });
    });
    const res = await passThroughApp.request('/thing');
    expect(res.status).toBe(200);
  });

  it('answers a malformed body with the uniform validation code at 400', async () => {
    const res = await app.request('/thing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'seven' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });
});
