import { describe, expect, it } from 'vitest';
import { SingleFlight } from './single-flight.js';

describe('SingleFlight', () => {
  it('builds once and hands every caller the same value', async () => {
    let builds = 0;
    const flight = new SingleFlight(() => {
      builds += 1;
      return Promise.resolve({ id: builds });
    });

    const [first, second] = await Promise.all([flight.get(), flight.get()]);

    expect(builds).toBe(1);
    expect(first).toBe(second);
  });

  it('starts a fresh build after the previous one rejected', async () => {
    let builds = 0;
    const flight = new SingleFlight(() => {
      builds += 1;
      return builds === 1
        ? Promise.reject(new Error('first build failed'))
        : Promise.resolve('built');
    });

    await expect(flight.get()).rejects.toThrow('first build failed');

    await expect(flight.get()).resolves.toBe('built');
    expect(builds).toBe(2);
  });

  it('attempts a build on every call while the failure persists', async () => {
    let builds = 0;
    const flight = new SingleFlight(() => {
      builds += 1;
      return Promise.reject(new Error('still failing'));
    });

    await expect(flight.get()).rejects.toThrow('still failing');
    await expect(flight.get()).rejects.toThrow('still failing');
    await expect(flight.get()).rejects.toThrow('still failing');

    expect(builds).toBe(3);
  });

  it('keeps the built value after a successful build', async () => {
    let builds = 0;
    const flight = new SingleFlight(() => {
      builds += 1;
      return Promise.resolve(builds);
    });

    await expect(flight.get()).resolves.toBe(1);
    await expect(flight.get()).resolves.toBe(1);
    expect(builds).toBe(1);
  });
});
