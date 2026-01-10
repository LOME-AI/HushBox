import { describe, it, expect } from 'vitest';
import { createErrorResponse, errorJson } from './error-response.js';
import {
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_NOT_FOUND,
  ERROR_CODE_VALIDATION,
} from '@lome-chat/shared';

describe('createErrorResponse', () => {
  it('creates error response with just message', () => {
    const response = createErrorResponse('Something went wrong');
    expect(response).toEqual({ error: 'Something went wrong' });
  });

  it('creates error response with code', () => {
    const response = createErrorResponse('Unauthorized', ERROR_CODE_UNAUTHORIZED);
    expect(response).toEqual({
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
    });
  });

  it('creates error response with details', () => {
    const response = createErrorResponse('Validation failed', ERROR_CODE_VALIDATION, {
      field: 'email',
    });
    expect(response).toEqual({
      error: 'Validation failed',
      code: 'VALIDATION',
      details: { field: 'email' },
    });
  });
});

describe('errorJson', () => {
  it('creates JSON response with 400 status by default', () => {
    const response = errorJson('Bad request');
    expect(response.status).toBe(400);
  });

  it('creates JSON response with specified status', () => {
    const response = errorJson('Not found', ERROR_CODE_NOT_FOUND, undefined, 404);
    expect(response.status).toBe(404);
  });

  it('returns correct JSON body', async () => {
    const response = errorJson('Unauthorized', ERROR_CODE_UNAUTHORIZED, undefined, 401);
    const body = await response.json();
    expect(body).toEqual({
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
    });
  });

  it('includes details in body', async () => {
    const response = errorJson('Validation error', ERROR_CODE_VALIDATION, { field: 'name' }, 400);
    const body = await response.json();
    expect(body).toEqual({
      error: 'Validation error',
      code: 'VALIDATION',
      details: { field: 'name' },
    });
  });
});
