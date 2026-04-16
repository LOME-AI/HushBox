import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseOrExit } from './run-cli';

describe('parseOrExit', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed result on success', () => {
    const parser = (args: string[]): { mode: string } | { error: string } => ({
      mode: args[0] ?? 'default',
    });

    const result = parseOrExit(parser, ['production']);
    expect(result).toEqual({ mode: 'production' });
  });

  it('calls process.exit(1) and logs error on parse failure', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const parser = (): { value: string } | { error: string } => ({
      error: 'Invalid arguments',
    });

    parseOrExit(parser, []);

    expect(errorSpy).toHaveBeenCalledWith('Invalid arguments');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('returns correct type from generic parser', () => {
    interface MyArgs {
      require: string[];
    }

    const parser = (args: string[]): MyArgs | { error: string } => ({
      require: args,
    });

    const result = parseOrExit(parser, ['ai-gateway', 'helcim']);
    expect(result).toEqual({ require: ['ai-gateway', 'helcim'] });
  });
});
