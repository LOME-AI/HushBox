/**
 * Error response utilities for consistent API error handling.
 */

import type { ErrorResponse } from '@lome-chat/shared';

/**
 * Creates a standardized error response object.
 *
 * @param message - Human-readable error message
 * @param code - Optional machine-readable error code
 * @param details - Optional additional context
 * @returns ErrorResponse object
 */
export function createErrorResponse(
  message: string,
  code?: string,
  details?: Record<string, unknown>
): ErrorResponse {
  const response: ErrorResponse = { error: message };
  if (code !== undefined) {
    response.code = code;
  }
  if (details !== undefined) {
    response.details = details;
  }
  return response;
}

/**
 * Creates a JSON Response with standardized error format.
 *
 * @param message - Human-readable error message
 * @param code - Optional machine-readable error code
 * @param details - Optional additional context
 * @param status - HTTP status code (default: 400)
 * @returns Response object with JSON body
 */
export function errorJson(
  message: string,
  code?: string,
  details?: Record<string, unknown>,
  status = 400
): Response {
  const body = createErrorResponse(message, code, details);
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
