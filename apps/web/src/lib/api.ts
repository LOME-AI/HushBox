import { frontendEnvSchema } from '@lome-chat/shared';

const env = frontendEnvSchema.parse({
  VITE_API_URL: import.meta.env['VITE_API_URL'] as unknown,
});

export function getApiUrl(): string {
  return env.VITE_API_URL;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

type HeadersInit = Headers | string[][] | Record<string, string>;

function normalizeHeaders(headers: HeadersInit): Record<string, string> {
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers) as Record<string, string>;
  }
  return headers;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, ...init } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (init.headers) {
    const additionalHeaders = normalizeHeaders(init.headers as HeadersInit);
    Object.assign(headers, additionalHeaders);
  }

  const fetchOptions: RequestInit = {
    ...init,
    headers,
    credentials: 'include',
  };

  if (body !== undefined) {
    fetchOptions.body = JSON.stringify(body);
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const response = await fetch(`${env.VITE_API_URL}${normalizedPath}`, fetchOptions);

  const data: unknown = await response.json();

  if (!response.ok) {
    const errorMessage =
      typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
        ? data.error
        : 'Request failed';
    throw new ApiError(errorMessage, response.status, data);
  }

  return data as T;
}

export const api = {
  get<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'GET' });
  },

  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: 'POST', body });
  },

  patch<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: 'PATCH', body });
  },

  delete<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'DELETE' });
  },
};

export {
  type ConversationResponse as Conversation,
  type ListConversationsResponse as ConversationsResponse,
  type MessageResponse as Message,
  type CreateConversationRequest,
  type GetConversationResponse as ConversationResponse,
  type UpdateConversationRequest,
  type CreateConversationResponse,
  type DeleteConversationResponse,
  type UpdateConversationResponse,
  type CreateMessageResponse,
  type CreateMessageRequest,
} from '@lome-chat/shared';
