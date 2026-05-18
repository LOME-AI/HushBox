import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({ rm: vi.fn() }));
vi.mock('execa', () => ({ execa: vi.fn() }));

import { rm } from 'node:fs/promises';
import { execa } from 'execa';
import { removeDirectory, runTurboClean, runClean } from './clean.js';

const mockRm = vi.mocked(rm);
const mockExeca = vi.mocked(execa);

describe('clean', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('removeDirectory', () => {
    it('calls fs.rm with recursive and force', async () => {
      mockRm.mockResolvedValue();
      await removeDirectory('node_modules');
      expect(mockRm).toHaveBeenCalledWith('node_modules', { recursive: true, force: true });
    });

    it('propagates fs.rm errors', async () => {
      mockRm.mockRejectedValue(new Error('EACCES'));
      await expect(removeDirectory('node_modules')).rejects.toThrow('EACCES');
    });
  });

  describe('runTurboClean', () => {
    it('spawns turbo clean with inherited stdio', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0 } as never);
      await runTurboClean();
      expect(mockExeca).toHaveBeenCalledWith('turbo', ['clean'], { stdio: 'inherit' });
    });
  });

  describe('runClean', () => {
    it('runs turbo clean then removes node_modules', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0 } as never);
      mockRm.mockResolvedValue();
      await runClean();
      expect(mockExeca).toHaveBeenCalledWith('turbo', ['clean'], { stdio: 'inherit' });
      expect(mockRm).toHaveBeenCalledWith('node_modules', { recursive: true, force: true });
    });

    it('does not remove node_modules if turbo clean throws', async () => {
      mockExeca.mockRejectedValue(new Error('turbo failed'));
      await expect(runClean()).rejects.toThrow('turbo failed');
      expect(mockRm).not.toHaveBeenCalled();
    });
  });
});
