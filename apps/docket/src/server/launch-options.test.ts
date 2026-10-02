import { describe, it, expect } from 'vitest';
import { DEFAULT_IDLE_MINUTES, parseLaunchOptions } from './launch-options';

describe('parseLaunchOptions', () => {
  it('defaults to the generated port, no audit and a thirty minute idle window', () => {
    expect(parseLaunchOptions([])).toEqual({
      port: null,
      idleMinutes: DEFAULT_IDLE_MINUTES,
      audit: null,
    });
  });

  it('reads a port override', () => {
    expect(parseLaunchOptions(['--port', '9999']).port).toBe(9999);
  });

  it('reads an idle window in minutes', () => {
    expect(parseLaunchOptions(['--idle', '5']).idleMinutes).toBe(5);
  });

  it('accepts a fractional idle window', () => {
    expect(parseLaunchOptions(['--idle', '0.5']).idleMinutes).toBe(0.5);
  });

  it('turns the idle window off', () => {
    expect(parseLaunchOptions(['--no-idle']).idleMinutes).toBeNull();
  });

  it('reads the default audit', () => {
    expect(parseLaunchOptions(['--audit', '2026-07-30']).audit).toBe('2026-07-30');
  });

  it('accepts the equals form', () => {
    expect(parseLaunchOptions(['--idle=15', '--audit=2026-07-30'])).toEqual({
      port: null,
      idleMinutes: 15,
      audit: '2026-07-30',
    });
  });

  it('rejects a flag whose value is missing', () => {
    expect(() => parseLaunchOptions(['--idle'])).toThrow('--idle needs a value');
  });

  it('rejects a non-numeric idle window', () => {
    expect(() => parseLaunchOptions(['--idle', 'soon'])).toThrow('--idle needs a positive number');
  });

  it('rejects an idle window of zero', () => {
    expect(() => parseLaunchOptions(['--idle', '0'])).toThrow('--idle needs a positive number');
  });

  it('rejects a port that is not a whole number', () => {
    expect(() => parseLaunchOptions(['--port', '80.5'])).toThrow('--port needs a whole number');
  });

  it('rejects an empty default audit', () => {
    expect(() => parseLaunchOptions(['--audit', ''])).toThrow('--audit needs a value');
  });

  it('rejects an unknown flag rather than ignoring a typo', () => {
    expect(() => parseLaunchOptions(['--idel', '5'])).toThrow('unknown option --idel');
  });
});
