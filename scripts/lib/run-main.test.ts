import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runMain } from './run-main.js';

describe('runMain', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => null) as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => null);
  });

  it('runs the action and exits with the returned code', async () => {
    await runMain(() => 42);
    expect(exitSpy).toHaveBeenCalledWith(42);
  });

  it('exits with 0 when the action returns nothing', async () => {
    await runMain(() => {
      /* no return */
    });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits with 0 when the action returns a non-number value', async () => {
    await runMain(() => 'done');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('awaits a Promise return value and exits with the resolved code', async () => {
    await runMain(() => Promise.resolve(7));
    expect(exitSpy).toHaveBeenCalledWith(7);
  });

  it('exits with 1 and logs the message when the action throws an Error', async () => {
    await runMain(() => {
      throw new Error('boom');
    });
    expect(errorSpy).toHaveBeenCalledWith('boom');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with 1 and logs a string when the action throws a non-Error', async () => {
    await runMain(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'plain string failure';
    });
    expect(errorSpy).toHaveBeenCalledWith('plain string failure');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with 1 and logs the message when the returned Promise rejects', async () => {
    await runMain(() => Promise.reject(new Error('rejected')));
    expect(errorSpy).toHaveBeenCalledWith('rejected');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
