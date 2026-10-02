import { describe, expect, it } from 'vitest';
import { TEST_DAY_START, isoAt } from '../testing/test-time.ts';
import { BASE_SYSTEM_PREAMBLE, RUNNABLE_DOCUMENTS_GUIDANCE } from './base-preamble.ts';
import { buildTurnSystemPrompt } from './system-prompt.ts';

/** The calendar day the preamble is expected to name. */
const NOW_DAY = isoAt(TEST_DAY_START).slice(0, 10);

describe('buildTurnSystemPrompt', () => {
  describe('base preamble', () => {
    it('states the HushBox assistant identity', () => {
      expect(buildTurnSystemPrompt({ utcDay: NOW_DAY })).toContain(
        'You are a helpful AI assistant powered by HushBox.'
      );
    });

    it('describes the unified multi-model product', () => {
      const prompt = buildTurnSystemPrompt({ utcDay: NOW_DAY });
      expect(prompt).toContain('unified AI chat interface');
      expect(prompt).toContain('switch models mid-conversation');
    });

    it('states the encryption notice', () => {
      const prompt = buildTurnSystemPrompt({ utcDay: NOW_DAY });
      expect(prompt).toContain('All conversations are encrypted');
      expect(prompt).toContain('only the user can decrypt them');
    });

    it('renders the day key it is given as the current date', () => {
      expect(buildTurnSystemPrompt({ utcDay: NOW_DAY })).toContain(`Current date: ${NOW_DAY}`);
    });
  });

  describe('runnable-documents capability section', () => {
    it('advertises the runnable-documents guidance on every turn', () => {
      expect(buildTurnSystemPrompt({ utcDay: NOW_DAY })).toContain(RUNNABLE_DOCUMENTS_GUIDANCE);
    });

    it('places the capability guidance after the base preamble', () => {
      const prompt = buildTurnSystemPrompt({ utcDay: NOW_DAY });
      const baseIndex = prompt.indexOf('You are a helpful AI assistant');
      const guidanceIndex = prompt.indexOf(RUNNABLE_DOCUMENTS_GUIDANCE);
      expect(baseIndex).toBeGreaterThanOrEqual(0);
      expect(guidanceIndex).toBeGreaterThan(baseIndex);
    });

    it('places the capability guidance before the custom-instructions section', () => {
      const prompt = buildTurnSystemPrompt({ utcDay: NOW_DAY, customInstructions: 'Be terse.' });
      const guidanceIndex = prompt.indexOf(RUNNABLE_DOCUMENTS_GUIDANCE);
      const customIndex = prompt.indexOf("## User's Custom Instructions");
      expect(guidanceIndex).toBeGreaterThan(0);
      expect(customIndex).toBeGreaterThan(guidanceIndex);
    });
  });

  describe('custom instructions section', () => {
    it('appends the section when instructions are present', () => {
      const prompt = buildTurnSystemPrompt({ utcDay: NOW_DAY, customInstructions: 'Be terse.' });
      expect(prompt).toContain("## User's Custom Instructions\nBe terse.");
    });

    it('omits the section entirely when instructions are absent', () => {
      expect(buildTurnSystemPrompt({ utcDay: NOW_DAY })).not.toContain(
        "User's Custom Instructions"
      );
    });

    it('omits the section when instructions are an empty string', () => {
      expect(buildTurnSystemPrompt({ utcDay: NOW_DAY, customInstructions: '' })).not.toContain(
        "User's Custom Instructions"
      );
    });

    it('treats whitespace-only instructions as absent (base-only, no dangling section)', () => {
      expect(buildTurnSystemPrompt({ utcDay: NOW_DAY, customInstructions: '   \n\t ' })).toBe(
        buildTurnSystemPrompt({ utcDay: NOW_DAY })
      );
    });

    it('places the custom-instructions section after the base preamble', () => {
      const prompt = buildTurnSystemPrompt({
        utcDay: NOW_DAY,
        customInstructions: 'Speak French.',
      });
      const baseIndex = prompt.indexOf('You are a helpful AI assistant');
      const customIndex = prompt.indexOf("## User's Custom Instructions");
      expect(baseIndex).toBeGreaterThanOrEqual(0);
      expect(customIndex).toBeGreaterThan(baseIndex);
    });
  });

  it('base-only output is the preamble+date followed by the runnable-documents guidance', () => {
    expect(buildTurnSystemPrompt({ utcDay: NOW_DAY })).toBe(
      [`${BASE_SYSTEM_PREAMBLE}\nCurrent date: ${NOW_DAY}`, RUNNABLE_DOCUMENTS_GUIDANCE].join(
        '\n\n'
      )
    );
  });
});
