import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSystemPrompt } from './build-system-prompt.js';

describe('buildSystemPrompt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('base module', () => {
    it('always includes HushBox assistant identity', () => {
      const prompt = buildSystemPrompt([]);
      expect(prompt).toContain('HushBox');
      expect(prompt).toContain('helpful');
    });

    it('includes current date', () => {
      const prompt = buildSystemPrompt([]);
      expect(prompt).toContain('2025-01-15');
    });

    it('includes guidance for accurate and concise responses', () => {
      const prompt = buildSystemPrompt([]);
      expect(prompt).toContain('accurate');
      expect(prompt).toContain('concise');
    });
  });

  describe('python-execution capability', () => {
    it('includes python section when capability is present', () => {
      const prompt = buildSystemPrompt(['python-execution']);
      expect(prompt).toContain('Python Code Execution');
      expect(prompt).toContain('execute_python');
    });

    it('includes available libraries', () => {
      const prompt = buildSystemPrompt(['python-execution']);
      expect(prompt).toContain('numpy');
      expect(prompt).toContain('pandas');
      expect(prompt).toContain('matplotlib');
    });

    it('excludes python section when capability is not present', () => {
      const prompt = buildSystemPrompt([]);
      expect(prompt).not.toContain('Python Code Execution');
    });
  });

  describe('javascript-execution capability', () => {
    it('includes javascript section when capability is present', () => {
      const prompt = buildSystemPrompt(['javascript-execution']);
      expect(prompt).toContain('JavaScript Code Execution');
      expect(prompt).toContain('execute_javascript');
    });

    it('mentions Node.js environment', () => {
      const prompt = buildSystemPrompt(['javascript-execution']);
      expect(prompt).toContain('Node.js');
    });

    it('excludes javascript section when capability is not present', () => {
      const prompt = buildSystemPrompt([]);
      expect(prompt).not.toContain('JavaScript Code Execution');
    });
  });

  describe('multiple capabilities', () => {
    it('includes all sections for multiple capabilities', () => {
      const prompt = buildSystemPrompt(['python-execution', 'javascript-execution']);
      expect(prompt).toContain('HushBox');
      expect(prompt).toContain('Python Code Execution');
      expect(prompt).toContain('JavaScript Code Execution');
    });

    it('joins sections with double newlines', () => {
      const prompt = buildSystemPrompt(['python-execution']);
      // Base and Python sections should be separated by double newline
      expect(prompt).toMatch(/HushBox[\s\S]*\n\n[\s\S]*Python/);
    });
  });

  describe('prompt structure', () => {
    it('returns a non-empty string', () => {
      const prompt = buildSystemPrompt([]);
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('does not include undefined capabilities', () => {
      // Should handle unknown capabilities gracefully
      const prompt = buildSystemPrompt(['vision'] as never[]);
      expect(prompt).not.toContain('undefined');
    });
  });
});
