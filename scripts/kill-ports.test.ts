import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('kill-port', () => ({ default: vi.fn() }));

import killPort from 'kill-port';
import { resolvePorts, killPorts } from './kill-ports.js';

const mockKillPort = vi.mocked(killPort);

describe('kill-ports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['KP_TEST_A'];
    delete process.env['KP_TEST_B'];
    delete process.env['KP_TEST_C'];
  });

  describe('resolvePorts', () => {
    it('reads port numbers from process.env for each name', () => {
      process.env['KP_TEST_A'] = '4321';
      process.env['KP_TEST_B'] = '5678';
      expect(resolvePorts(['KP_TEST_A', 'KP_TEST_B'])).toEqual([4321, 5678]);
    });

    it('skips env vars that are unset', () => {
      process.env['KP_TEST_A'] = '4321';
      expect(resolvePorts(['KP_TEST_A', 'KP_TEST_B'])).toEqual([4321]);
    });

    it('skips env vars that are non-numeric', () => {
      process.env['KP_TEST_A'] = '4321';
      process.env['KP_TEST_B'] = 'notaport';
      expect(resolvePorts(['KP_TEST_A', 'KP_TEST_B'])).toEqual([4321]);
    });

    it('returns empty array when no names provided', () => {
      expect(resolvePorts([])).toEqual([]);
    });
  });

  describe('killPorts', () => {
    it('calls kill-port for each port', async () => {
      mockKillPort.mockResolvedValue(undefined as never);
      await killPorts([4321, 5678]);
      expect(mockKillPort).toHaveBeenCalledTimes(2);
      expect(mockKillPort).toHaveBeenCalledWith(4321);
      expect(mockKillPort).toHaveBeenCalledWith(5678);
    });

    it('does not throw when kill-port rejects (port not in use)', async () => {
      mockKillPort.mockRejectedValue(new Error('No process running on port 4321'));
      await expect(killPorts([4321])).resolves.toBeUndefined();
    });

    it('continues to next port after one rejection', async () => {
      mockKillPort.mockRejectedValueOnce(new Error('No process'));
      mockKillPort.mockResolvedValueOnce(undefined as never);
      await killPorts([4321, 5678]);
      expect(mockKillPort).toHaveBeenCalledTimes(2);
    });

    it('no-ops on empty list', async () => {
      await killPorts([]);
      expect(mockKillPort).not.toHaveBeenCalled();
    });
  });
});
