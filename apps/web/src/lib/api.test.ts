import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock import.meta.env before importing the module
vi.mock('@lome-chat/shared', () => ({
  frontendEnvSchema: {
    parse: () => ({ VITE_API_URL: 'http://localhost:8787' }),
  },
}));

import { api, ApiError } from './api';

describe('api client', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  describe('api.get', () => {
    it('makes GET request with correct headers', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: 'test' }),
      });

      await api.get('/test');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/test'),
        expect.objectContaining({
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        })
      );
    });

    it('returns parsed JSON on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ conversations: [] }),
      });

      const result = await api.get('/conversations');

      expect(result).toEqual({ conversations: [] });
    });

    it('throws ApiError on failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'Unauthorized' }),
      });

      await expect(api.get('/protected')).rejects.toThrow(ApiError);
    });

    it('includes error message from API response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'Unauthorized' }),
      });

      await expect(api.get('/protected')).rejects.toThrow('Unauthorized');
    });

    it('includes status in ApiError', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Not found' }),
      });

      try {
        await api.get('/missing');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(404);
      }
    });
  });

  describe('api.post', () => {
    it('makes POST request with body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: '123' }),
      });

      await api.post('/conversations', { title: 'New conversation' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/conversations'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'New conversation' }),
        })
      );
    });

    it('handles POST without body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      await api.post('/action');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/action'),
        expect.objectContaining({
          method: 'POST',
        })
      );
      // Verify body is not included when no data is passed
      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].body).toBeUndefined();
    });
  });

  describe('api.patch', () => {
    it('makes PATCH request with body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ updated: true }),
      });

      await api.patch('/conversations/123', { title: 'Updated' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/conversations/123'),
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ title: 'Updated' }),
        })
      );
    });
  });

  describe('api.delete', () => {
    it('makes DELETE request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ deleted: true }),
      });

      await api.delete('/conversations/123');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/conversations/123'),
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });
  });
});
