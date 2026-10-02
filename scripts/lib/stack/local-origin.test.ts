import { describe, it, expect, afterEach, vi } from 'vitest';
import { localOriginFor } from './local-origin.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('localOriginFor', () => {
  it('builds the origin from the port variable the generator mints for the service', () => {
    vi.stubEnv('HB_VITE_PORT', '10042');
    expect(localOriginFor('vite')).toBe('http://localhost:10042');
  });

  it('reads a different variable for a different service', () => {
    vi.stubEnv('HB_API_PORT', '10242');
    expect(localOriginFor('api')).toBe('http://localhost:10242');
  });

  it('names the missing variable rather than defaulting to a literal port', () => {
    vi.stubEnv('HB_VITE_PORT', '');
    expect(() => localOriginFor('vite')).toThrow('HB_VITE_PORT');
  });

  it('rejects a value that is not a port', () => {
    vi.stubEnv('HB_VITE_PORT', 'nope');
    expect(() => localOriginFor('vite')).toThrow('HB_VITE_PORT');
  });

  it('rejects a port outside the range a host can bind', () => {
    vi.stubEnv('HB_VITE_PORT', '70000');
    expect(() => localOriginFor('vite')).toThrow('70000');
  });
});
