import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectSkillInputs,
  collectSkillTargets,
  generateSkills,
  getSkillTemplateValues,
  withNotice,
} from './generate-skills.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

const NOTICE = '<!-- test-notice -->';

function makeFragment(rootDir: string, body: string): void {
  const dir = path.join(rootDir, '.claude/skills/anti-ai-writing');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'anti-slop-rules.md'), body);
}

function makeSkillTemplate(rootDir: string, name: string, body: string): void {
  const dir = path.join(rootDir, '.claude/skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.template.md'), body);
}

function makeAgentTemplate(rootDir: string, name: string, body: string): void {
  const dir = path.join(rootDir, '.claude/agent-templates');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.md`), body);
}

function makeVoice(rootDir: string, body: string): void {
  const dir = path.join(rootDir, '.claude/skills/write-blog');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'voice.md'), body);
}

function makeCore(rootDir: string, body: string): void {
  const dir = path.join(rootDir, '.claude/skills/subagent-driven-dev');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'subagent-driven-core.md'), body);
}

function makeAgentsCore(rootDir: string, body: string): void {
  const dir = path.join(rootDir, '.claude/skills/subagent-driven-dev');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'sdd-agents-core.md'), body);
}

function makeFrontendDesignCore(rootDir: string, body: string): void {
  const dir = path.join(rootDir, '.claude/skills/frontend-design');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'frontend-design-core.md'), body);
}

function makeResearchFileMode(rootDir: string, body: string): void {
  const dir = path.join(rootDir, '.claude/agent-templates/fragments');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'research-file-mode.md'), body);
}

const REGISTRY_PATH = '.claude/agent-templates/model-categories.json';

/** Writes the model-category registry: an object is serialized, a string is written verbatim. */
function makeRegistry(rootDir: string, registry: object | string): void {
  const dir = path.join(rootDir, '.claude/agent-templates');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'model-categories.json'),
    typeof registry === 'string' ? registry : JSON.stringify(registry)
  );
}

function makeHandWrittenAgent(rootDir: string, name: string): void {
  const dir = path.join(rootDir, '.claude/agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\n---\n\nhand-written\n`);
}

/** Every shared input the template values are read from, so a run reaches its targets. */
function makeSharedInputs(rootDir: string): void {
  makeFragment(rootDir, 'rules');
  makeVoice(rootDir, 'voice');
  makeCore(rootDir, '<!-- @section: SDD_X -->\n\nx\n');
  makeResearchFileMode(rootDir, 'file mode');
  makeAgentsCore(rootDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
  makeFrontendDesignCore(rootDir, '<!-- @section: FD_X -->\n\nfd\n');
}

/** The generator's own source counts as an input, so the cache engages only once it exists under the root. */
function makeGeneratorSource(rootDir: string): void {
  mkdirSync(path.join(rootDir, 'scripts/skills'), { recursive: true });
  writeFileSync(path.join(rootDir, 'scripts/skills/generate-skills.ts'), 'source');
}

function readAgent(rootDir: string, name: string): string {
  return readFileSync(path.join(rootDir, '.claude/agents', `${name}.md`), 'utf8');
}

/** Runs the generator expecting it to refuse, and returns everything it wrote to stderr. */
function stderrOfRefusal(rootDir: string): string {
  const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
  const mockError = vi.spyOn(console, 'error').mockImplementation(vi.fn());
  try {
    expect(() => generateSkills(rootDir)).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
    return mockError.mock.calls.map((call) => call.join(' ')).join('\n');
  } finally {
    mockExit.mockRestore();
    mockError.mockRestore();
  }
}

/** Runs the generator expecting it to succeed, with its progress lines silenced. */
function generateQuietly(rootDir: string): string[] {
  const mockError = vi.spyOn(console, 'error').mockImplementation(vi.fn());
  try {
    return generateSkills(rootDir);
  } finally {
    mockError.mockRestore();
  }
}

describe('withNotice', () => {
  it('inserts the notice after YAML frontmatter', () => {
    const out = withNotice('---\nname: x\n---\n\n# Body\ntext', NOTICE);

    expect(out).toBe('---\nname: x\n---\n\n<!-- test-notice -->\n\n# Body\ntext');
  });

  it('prepends the notice when there is no frontmatter', () => {
    const out = withNotice('# Hello\nworld', NOTICE);

    expect(out).toBe('<!-- test-notice -->\n\n# Hello\nworld');
  });

  it('prepends the notice when the frontmatter is unterminated', () => {
    const out = withNotice('---\nname: x\nno close', NOTICE);

    expect(out).toBe('<!-- test-notice -->\n\n---\nname: x\nno close');
  });
});

describe('getSkillTemplateValues', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'skills-values-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('returns the trimmed fragment under ANTI_SLOP_CHECKLIST', () => {
    makeFragment(temporaryDir, '\n## Banned Vocabulary\n\nrules\n\n');
    makeVoice(temporaryDir, 'voice');
    makeCore(temporaryDir, '<!-- @section: SDD_X -->\n\nx\n');
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');

    const values = getSkillTemplateValues(temporaryDir);

    expect(values['ANTI_SLOP_CHECKLIST']).toBe('## Banned Vocabulary\n\nrules');
  });

  it('returns the trimmed voice fragment under BLOG_VOICE', () => {
    makeFragment(temporaryDir, 'slop');
    makeVoice(temporaryDir, '\n## Voice\n\nblend\n\n');
    makeCore(temporaryDir, '<!-- @section: SDD_X -->\n\nx\n');
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');

    const values = getSkillTemplateValues(temporaryDir);

    expect(values['BLOG_VOICE']).toBe('## Voice\n\nblend');
  });

  it('returns the trimmed research file-mode fragment under RESEARCH_FILE_MODE', () => {
    makeFragment(temporaryDir, 'slop');
    makeVoice(temporaryDir, 'voice');
    makeCore(temporaryDir, '<!-- @section: SDD_X -->\n\nx\n');
    makeResearchFileMode(temporaryDir, '\n## Two return modes\n\nfile mode\n\n');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');

    const values = getSkillTemplateValues(temporaryDir);

    expect(values['RESEARCH_FILE_MODE']).toBe('## Two return modes\n\nfile mode');
  });

  it('counts the research file-mode fragment among the generator inputs', () => {
    makeFragment(temporaryDir, 'slop');
    makeVoice(temporaryDir, 'voice');
    makeCore(temporaryDir, '<!-- @section: SDD_X -->\n\nx\n');
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');

    expect(collectSkillInputs(temporaryDir)).toContain(
      path.join(temporaryDir, '.claude/agent-templates/fragments/research-file-mode.md')
    );
  });

  it('counts the voice fragment among the generator inputs', () => {
    makeFragment(temporaryDir, 'slop');
    makeVoice(temporaryDir, 'voice');
    makeCore(temporaryDir, '<!-- @section: SDD_X -->\n\nx\n');
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');

    expect(collectSkillInputs(temporaryDir)).toContain(
      path.join(temporaryDir, '.claude/skills/write-blog/voice.md')
    );
  });

  it('parses each marked core section into a trimmed named value', () => {
    makeFragment(temporaryDir, 'slop');
    makeVoice(temporaryDir, 'voice');
    makeCore(
      temporaryDir,
      '<!-- top comment -->\n\n<!-- @section: SDD_WHY_NO_CODE -->\n\nnever edit.\n\n<!-- @section: SDD_SUBAGENTS -->\n\ntwo agent types.\n'
    );
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');

    const values = getSkillTemplateValues(temporaryDir);

    expect(values['SDD_WHY_NO_CODE']).toBe('never edit.');
    expect(values['SDD_SUBAGENTS']).toBe('two agent types.');
  });

  it("drops the formatter's range-ignore comments from a section's value", () => {
    makeFragment(temporaryDir, 'slop');
    makeVoice(temporaryDir, 'voice');
    makeCore(
      temporaryDir,
      '<!-- @section: SDD_X -->\n\n<!-- prettier-ignore-start -->\nTASK: <one line>\n- item\n<!-- prettier-ignore-end -->\n'
    );
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');

    const values = getSkillTemplateValues(temporaryDir);

    expect(values['SDD_X']).toBe('TASK: <one line>\n- item');
  });

  it('parses the sdd agents core and the frontend-design core into named values', () => {
    makeFragment(temporaryDir, 'slop');
    makeVoice(temporaryDir, 'voice');
    makeCore(temporaryDir, '<!-- @section: SDD_X -->\n\nx\n');
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_ROLE -->\n\nyou implement.\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_BANS -->\n\nno side stripes.\n');

    const values = getSkillTemplateValues(temporaryDir);

    expect(values['IMPL_ROLE']).toBe('you implement.');
    expect(values['FD_BANS']).toBe('no side stripes.');
  });

  it('counts both agent-side core files among the generator inputs', () => {
    makeFragment(temporaryDir, 'slop');
    makeVoice(temporaryDir, 'voice');
    makeCore(temporaryDir, '<!-- @section: SDD_X -->\n\nx\n');
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');

    const inputs = collectSkillInputs(temporaryDir);

    expect(inputs).toContain(
      path.join(temporaryDir, '.claude/skills/subagent-driven-dev/sdd-agents-core.md')
    );
    expect(inputs).toContain(
      path.join(temporaryDir, '.claude/skills/frontend-design/frontend-design-core.md')
    );
  });

  it('refuses a section name that two core files both define', () => {
    makeFragment(temporaryDir, 'slop');
    makeVoice(temporaryDir, 'voice');
    makeCore(temporaryDir, '<!-- @section: SDD_X -->\n\nx\n');
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: SDD_X -->\n\nagain\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');

    expect(() => getSkillTemplateValues(temporaryDir)).toThrow(
      'section SDD_X is defined in more than one core file'
    );
  });
});

describe('collectSkillTargets', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'skills-targets-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('discovers only skill directories that contain a SKILL.template.md', () => {
    makeSkillTemplate(temporaryDir, 'write-blog', 'x');
    makeSkillTemplate(temporaryDir, 'anti-ai-writing', 'y');
    mkdirSync(path.join(temporaryDir, '.claude/skills/no-template'), { recursive: true });

    const targets = collectSkillTargets(temporaryDir);

    expect(targets.map((t) => t.name)).toEqual(['anti-ai-writing', 'write-blog']);
    expect(targets[1]?.outputPath).toBe(
      path.join(temporaryDir, '.claude/skills/write-blog/SKILL.md')
    );
  });

  it('discovers agent templates after the skills, keyed by their basename', () => {
    makeSkillTemplate(temporaryDir, 'write-blog', 'x');
    makeAgentTemplate(temporaryDir, 'blog-slop-hunter', 'y');
    mkdirSync(path.join(temporaryDir, '.claude/agents'), { recursive: true });
    writeFileSync(path.join(temporaryDir, '.claude/agents/analyst.md'), 'hand-written');

    const targets = collectSkillTargets(temporaryDir);

    expect(targets.map((t) => t.name)).toEqual(['write-blog', 'blog-slop-hunter']);
    expect(targets[1]?.templatePath).toBe(
      path.join(temporaryDir, '.claude/agent-templates/blog-slop-hunter.md')
    );
    expect(targets[1]?.outputPath).toBe(
      path.join(temporaryDir, '.claude/agents/blog-slop-hunter.md')
    );
  });

  it('names every agent template by its basename, in name order', () => {
    mkdirSync(path.join(temporaryDir, '.claude/skills'), { recursive: true });
    makeAgentTemplate(temporaryDir, 'doc-writer', 'x');
    makeAgentTemplate(temporaryDir, 'analyst', 'y');
    makeAgentTemplate(temporaryDir, 'blog-slop-hunter', 'z');

    const targets = collectSkillTargets(temporaryDir);

    // The order asserted is the order the whole set comes out in, not evidence
    // that the sort produced it: a directory listing that is already ordered
    // gives the same answer with the sort removed, and every filesystem this
    // has been run against lists an ordinary directory in order.
    expect(targets.map((target) => target.name)).toEqual([
      'analyst',
      'blog-slop-hunter',
      'doc-writer',
    ]);
  });
});

describe('generateSkills', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'skills-generate-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('substitutes the shared checklist and writes SKILL.md with the notice', () => {
    makeFragment(temporaryDir, '## Banned Vocabulary\n\nNever use em-dashes.');
    makeVoice(temporaryDir, 'voice');
    makeCore(temporaryDir, '<!-- @section: SDD_X -->\n\nx\n');
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');
    makeSkillTemplate(
      temporaryDir,
      'anti-ai-writing',
      '---\nname: anti-ai-writing\n---\n\n# Anti-Slop Rules\n\nintro\n\n{{ANTI_SLOP_CHECKLIST}}\n'
    );
    makeRegistry(temporaryDir, { categories: {}, agents: {} });
    const mockError = vi.spyOn(console, 'error').mockImplementation(vi.fn());

    generateSkills(temporaryDir);

    const output = readFileSync(
      path.join(temporaryDir, '.claude/skills/anti-ai-writing/SKILL.md'),
      'utf8'
    );
    expect(output).toContain('## Banned Vocabulary');
    expect(output).toContain('Never use em-dashes.');
    expect(output).not.toContain('{{ANTI_SLOP_CHECKLIST}}');
    expect(output).toContain('AUTO-GENERATED');
    // The notice must land after the frontmatter, never before the `---` fence.
    expect(output.indexOf('AUTO-GENERATED')).toBeGreaterThan(
      output.indexOf('name: anti-ai-writing')
    );

    mockError.mockRestore();
  });

  it('writes a notice that names no particular injected source, so it holds for every output', () => {
    makeFragment(temporaryDir, 'rules');
    makeVoice(temporaryDir, 'voice');
    makeCore(temporaryDir, '<!-- @section: SDD_X -->\n\nx\n');
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');
    makeAgentTemplate(temporaryDir, 'analyst', '---\nname: analyst\n---\n\nbody\n');
    makeRegistry(temporaryDir, {
      categories: { judgment: { model: 'opus' } },
      agents: { analyst: 'judgment' },
    });

    generateQuietly(temporaryDir);

    expect(readFileSync(path.join(temporaryDir, '.claude/agents/analyst.md'), 'utf8')).toContain(
      '<!-- AUTO-GENERATED from .claude/agent-templates/analyst.md and the shared sources it draws on. Do not edit directly; edit those sources, then run pnpm generate:skills. -->'
    );
  });

  it('generates an agent from its template with a notice naming that template', () => {
    makeFragment(temporaryDir, '## Banned Vocabulary\n\nNever use em-dashes.');
    makeVoice(temporaryDir, 'voice');
    makeCore(temporaryDir, '<!-- @section: SDD_X -->\n\nx\n');
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');
    makeAgentTemplate(
      temporaryDir,
      'blog-slop-hunter',
      '---\nname: blog-slop-hunter\n---\n\nYou hunt slop.\n\n{{ANTI_SLOP_CHECKLIST}}\n'
    );
    makeRegistry(temporaryDir, {
      categories: { review: {} },
      agents: { 'blog-slop-hunter': 'review' },
    });
    const mockError = vi.spyOn(console, 'error').mockImplementation(vi.fn());

    generateSkills(temporaryDir);

    const output = readFileSync(
      path.join(temporaryDir, '.claude/agents/blog-slop-hunter.md'),
      'utf8'
    );
    expect(output).toContain('Never use em-dashes.');
    expect(output).not.toContain('{{ANTI_SLOP_CHECKLIST}}');
    expect(output).toContain('AUTO-GENERATED from .claude/agent-templates/blog-slop-hunter.md');
    expect(output.indexOf('AUTO-GENERATED')).toBeGreaterThan(
      output.indexOf('name: blog-slop-hunter')
    );
    expect(mockError).toHaveBeenCalledWith('✓ Generated agents/blog-slop-hunter.md from template');

    mockError.mockRestore();
  });

  it('exits with code 1 on an unmatched template variable', () => {
    makeFragment(temporaryDir, 'rules');
    makeVoice(temporaryDir, 'voice');
    makeCore(temporaryDir, '<!-- @section: SDD_X -->\n\nx\n');
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');
    makeSkillTemplate(
      temporaryDir,
      'write-blog',
      '---\nname: write-blog\n---\n\n{{ANTI_SLOP_CHECKLIST}} {{UNKNOWN_VAR}}'
    );
    makeRegistry(temporaryDir, { categories: {}, agents: {} });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const mockError = vi.spyOn(console, 'error').mockImplementation(vi.fn());
    const mockLog = vi.spyOn(console, 'log').mockImplementation(vi.fn());

    expect(() => {
      generateSkills(temporaryDir);
    }).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockError).toHaveBeenCalledWith('ERROR: Unmatched template variables found:');
    expect(mockError).toHaveBeenCalledWith(' - {{UNKNOWN_VAR}}');

    mockExit.mockRestore();
    mockError.mockRestore();
    mockLog.mockRestore();
  });

  it('returns the output path of every generated skill', () => {
    makeFragment(temporaryDir, 'rules');
    makeVoice(temporaryDir, 'voice');
    makeCore(temporaryDir, '<!-- @section: SDD_X -->\n\nx\n');
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');
    makeSkillTemplate(temporaryDir, 'write-blog', '---\nname: write-blog\n---\n\nbody\n');
    makeSkillTemplate(temporaryDir, 'anti-ai-writing', '---\nname: a\n---\n\nbody\n');
    makeAgentTemplate(temporaryDir, 'blog-slop-hunter', '---\nname: b\n---\n\nbody\n');
    makeRegistry(temporaryDir, {
      categories: { review: {} },
      agents: { 'blog-slop-hunter': 'review' },
    });
    const mockError = vi.spyOn(console, 'error').mockImplementation(vi.fn());

    const outputs = generateSkills(temporaryDir);

    expect(outputs).toEqual([
      path.join(temporaryDir, '.claude/skills/anti-ai-writing/SKILL.md'),
      path.join(temporaryDir, '.claude/skills/write-blog/SKILL.md'),
      path.join(temporaryDir, '.claude/agents/blog-slop-hunter.md'),
    ]);

    mockError.mockRestore();
  });

  it('keeps stdout to the output paths when the cache skips generation', () => {
    makeFragment(temporaryDir, 'rules');
    makeVoice(temporaryDir, 'voice');
    makeCore(temporaryDir, '<!-- @section: SDD_X -->\n\nx\n');
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');
    makeSkillTemplate(temporaryDir, 'write-blog', '---\nname: write-blog\n---\n\nbody\n');
    makeRegistry(temporaryDir, { categories: {}, agents: {} });
    // The generator's own source counts as an input, so the cache engages only
    // once every input exists under the temporary root.
    mkdirSync(path.join(temporaryDir, 'scripts/skills'), { recursive: true });
    writeFileSync(path.join(temporaryDir, 'scripts/skills/generate-skills.ts'), 'source');
    const mockError = vi.spyOn(console, 'error').mockImplementation(vi.fn());
    const mockLog = vi.spyOn(console, 'log').mockImplementation(vi.fn());

    generateSkills(temporaryDir);
    const second = generateSkills(temporaryDir);

    expect(mockError).toHaveBeenCalledWith('✓ Skills up to date — skipping');
    expect(mockLog).not.toHaveBeenCalled();
    expect(second).toEqual([path.join(temporaryDir, '.claude/skills/write-blog/SKILL.md')]);

    mockError.mockRestore();
    mockLog.mockRestore();
  });

  it('writes its progress lines to stderr', () => {
    makeFragment(temporaryDir, 'rules');
    makeVoice(temporaryDir, 'voice');
    makeCore(temporaryDir, '<!-- @section: SDD_X -->\n\nx\n');
    makeResearchFileMode(temporaryDir, 'file mode');
    makeAgentsCore(temporaryDir, '<!-- @section: IMPL_X -->\n\nimpl\n');
    makeFrontendDesignCore(temporaryDir, '<!-- @section: FD_X -->\n\nfd\n');
    makeSkillTemplate(temporaryDir, 'write-blog', '---\nname: write-blog\n---\n\nbody\n');
    makeRegistry(temporaryDir, { categories: {}, agents: {} });
    const mockError = vi.spyOn(console, 'error').mockImplementation(vi.fn());
    const mockLog = vi.spyOn(console, 'log').mockImplementation(vi.fn());

    generateSkills(temporaryDir);

    expect(mockError).toHaveBeenCalledWith('✓ Generated write-blog/SKILL.md from template');
    expect(mockLog).not.toHaveBeenCalled();

    mockError.mockRestore();
    mockLog.mockRestore();
  });
});

describe('the model-category registry', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'skills-registry-'));
    makeSharedInputs(temporaryDir);
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  describe('reading the registry file', () => {
    it('refuses a run when the registry file is missing, naming the file', () => {
      makeSkillTemplate(temporaryDir, 'write-blog', '---\nname: write-blog\n---\n\nbody\n');

      const stderr = stderrOfRefusal(temporaryDir);

      expect(stderr).toContain(`${REGISTRY_PATH} is missing`);
    });

    it('refuses a registry file that is not valid JSON, naming the file', () => {
      makeRegistry(temporaryDir, '{ "categories": ');

      const stderr = stderrOfRefusal(temporaryDir);

      expect(stderr).toContain(`${REGISTRY_PATH} is not valid JSON`);
    });

    it('refuses a registry that does not match the registry shape, naming the file and the fault', () => {
      makeRegistry(temporaryDir, { categories: { review: { model: 'sonet' } }, agents: {} });

      const stderr = stderrOfRefusal(temporaryDir);

      expect(stderr).toContain(`${REGISTRY_PATH} does not match the registry shape`);
      expect(stderr).toContain('categories.review.model');
    });
  });

  describe('the registry shape', () => {
    it('refuses a top-level key other than categories and agents', () => {
      makeRegistry(temporaryDir, { categories: {}, agents: {}, defaults: {} });

      expect(stderrOfRefusal(temporaryDir)).toContain('Unrecognized key: "defaults"');
    });

    it('refuses a registry without an agents map', () => {
      makeRegistry(temporaryDir, { categories: {} });

      expect(stderrOfRefusal(temporaryDir)).toContain('agents');
    });

    it('refuses a category key other than model and effort', () => {
      makeRegistry(temporaryDir, { categories: { review: { temperature: 1 } }, agents: {} });

      expect(stderrOfRefusal(temporaryDir)).toContain('Unrecognized key: "temperature"');
    });

    it('refuses an effort outside the allowed levels', () => {
      makeRegistry(temporaryDir, { categories: { review: { effort: 'extreme' } }, agents: {} });

      expect(stderrOfRefusal(temporaryDir)).toContain('categories.review.effort');
    });

    it('refuses an agent mapped to something other than a category name', () => {
      makeRegistry(temporaryDir, { categories: {}, agents: { analyst: 3 } });

      expect(stderrOfRefusal(temporaryDir)).toContain('agents.analyst');
    });

    it.each(['fable', 'opus', 'sonnet', 'haiku', 'claude-sonnet-4-5', 'claude-opus-4.1'])(
      'accepts %s as a model',
      (model) => {
        makeAgentTemplate(temporaryDir, 'analyst', '---\nname: analyst\n---\n\nbody\n');
        makeRegistry(temporaryDir, {
          categories: { judgment: { model } },
          agents: { analyst: 'judgment' },
        });

        generateQuietly(temporaryDir);

        expect(readAgent(temporaryDir, 'analyst')).toContain(`\nmodel: ${model}\n---\n`);
      }
    );

    it.each(['low', 'medium', 'high', 'xhigh', 'max'])('accepts %s as an effort', (effort) => {
      makeAgentTemplate(temporaryDir, 'analyst', '---\nname: analyst\n---\n\nbody\n');
      makeRegistry(temporaryDir, {
        categories: { judgment: { effort } },
        agents: { analyst: 'judgment' },
      });

      generateQuietly(temporaryDir);

      expect(readAgent(temporaryDir, 'analyst')).toContain(`\neffort: ${effort}\n---\n`);
    });
  });

  describe('the frontmatter lines written', () => {
    it("ends the frontmatter with the category's model then its effort", () => {
      makeAgentTemplate(
        temporaryDir,
        'analyst',
        '---\nname: analyst\ntools: Read\ncolor: purple\n---\n\nbody\n'
      );
      makeRegistry(temporaryDir, {
        categories: { judgment: { model: 'opus', effort: 'high' } },
        agents: { analyst: 'judgment' },
      });

      generateQuietly(temporaryDir);

      expect(readAgent(temporaryDir, 'analyst')).toMatch(
        /^---\nname: analyst\ntools: Read\ncolor: purple\nmodel: opus\neffort: high\n---\n/
      );
    });

    it('writes neither line when the category carries neither', () => {
      makeAgentTemplate(temporaryDir, 'analyst', '---\nname: analyst\n---\n\nbody\n');
      makeRegistry(temporaryDir, { categories: { lookup: {} }, agents: { analyst: 'lookup' } });

      generateQuietly(temporaryDir);

      expect(readAgent(temporaryDir, 'analyst')).toMatch(/^---\nname: analyst\n---\n/);
    });

    it('writes only the model line when the category carries no effort', () => {
      makeAgentTemplate(temporaryDir, 'analyst', '---\nname: analyst\n---\n\nbody\n');
      makeRegistry(temporaryDir, {
        categories: { judgment: { model: 'opus' } },
        agents: { analyst: 'judgment' },
      });

      generateQuietly(temporaryDir);

      expect(readAgent(temporaryDir, 'analyst')).toMatch(/^---\nname: analyst\nmodel: opus\n---\n/);
    });

    it('writes only the effort line when the category carries no model', () => {
      makeAgentTemplate(temporaryDir, 'analyst', '---\nname: analyst\n---\n\nbody\n');
      makeRegistry(temporaryDir, {
        categories: { judgment: { effort: 'high' } },
        agents: { analyst: 'judgment' },
      });

      generateQuietly(temporaryDir);

      expect(readAgent(temporaryDir, 'analyst')).toMatch(
        /^---\nname: analyst\neffort: high\n---\n/
      );
    });
  });

  describe('refusing an agent the registry does not cover', () => {
    it('refuses an agent template with no entry in the registry', () => {
      makeAgentTemplate(temporaryDir, 'analyst', '---\nname: analyst\n---\n\nbody\n');
      makeRegistry(temporaryDir, { categories: {}, agents: {} });

      expect(stderrOfRefusal(temporaryDir)).toContain(
        `.claude/agent-templates/analyst.md has no entry in ${REGISTRY_PATH}`
      );
    });

    it('refuses a registry entry that has no agent template', () => {
      makeRegistry(temporaryDir, { categories: { lookup: {} }, agents: { ghost: 'lookup' } });

      expect(stderrOfRefusal(temporaryDir)).toContain(
        `${REGISTRY_PATH} names agent ghost, which has no template`
      );
    });

    it('refuses a registry entry naming a category the registry does not define', () => {
      makeAgentTemplate(temporaryDir, 'analyst', '---\nname: analyst\n---\n\nbody\n');
      makeRegistry(temporaryDir, { categories: {}, agents: { analyst: 'thinking' } });

      expect(stderrOfRefusal(temporaryDir)).toContain(
        `${REGISTRY_PATH} puts agent analyst in category thinking, which it does not define`
      );
    });

    it('refuses an agent template whose frontmatter sets a model', () => {
      makeAgentTemplate(temporaryDir, 'analyst', '---\nname: analyst\nmodel: fable\n---\n\nbody\n');
      makeRegistry(temporaryDir, { categories: { lookup: {} }, agents: { analyst: 'lookup' } });

      expect(stderrOfRefusal(temporaryDir)).toContain(
        '.claude/agent-templates/analyst.md sets model: or effort: in its frontmatter'
      );
    });

    it('refuses an agent template whose frontmatter sets an effort', () => {
      makeAgentTemplate(temporaryDir, 'analyst', '---\nname: analyst\neffort: low\n---\n\nbody\n');
      makeRegistry(temporaryDir, { categories: { lookup: {} }, agents: { analyst: 'lookup' } });

      expect(stderrOfRefusal(temporaryDir)).toContain(
        '.claude/agent-templates/analyst.md sets model: or effort: in its frontmatter'
      );
    });

    it('refuses an agent template that does not open with a frontmatter block', () => {
      makeAgentTemplate(temporaryDir, 'analyst', '# Analyst\n\nbody\n');
      makeRegistry(temporaryDir, { categories: { lookup: {} }, agents: { analyst: 'lookup' } });

      expect(stderrOfRefusal(temporaryDir)).toContain(
        '.claude/agent-templates/analyst.md does not open with a YAML frontmatter block'
      );
    });

    it('refuses an agent definition that has no template', () => {
      makeHandWrittenAgent(temporaryDir, 'rote-worker');
      makeRegistry(temporaryDir, { categories: {}, agents: {} });

      expect(stderrOfRefusal(temporaryDir)).toContain(
        '.claude/agents/rote-worker.md has no template at .claude/agent-templates/rote-worker.md'
      );
    });

    it('names every offender in one refusal', () => {
      makeHandWrittenAgent(temporaryDir, 'rote-worker');
      makeAgentTemplate(temporaryDir, 'analyst', '---\nname: analyst\n---\n\nbody\n');
      makeRegistry(temporaryDir, { categories: {}, agents: { ghost: 'lookup' } });

      const stderr = stderrOfRefusal(temporaryDir);

      expect(stderr).toContain('.claude/agents/rote-worker.md has no template');
      expect(stderr).toContain('.claude/agent-templates/analyst.md has no entry');
      expect(stderr).toContain('names agent ghost, which has no template');
      expect(stderr).toContain('puts agent ghost in category lookup');
    });

    it('refuses an agent definition with no template on a run the cache skips', () => {
      makeGeneratorSource(temporaryDir);
      makeSkillTemplate(temporaryDir, 'write-blog', '---\nname: write-blog\n---\n\nbody\n');
      makeRegistry(temporaryDir, { categories: {}, agents: {} });
      generateQuietly(temporaryDir);
      makeHandWrittenAgent(temporaryDir, 'rote-worker');

      const stderr = stderrOfRefusal(temporaryDir);

      expect(stderr).toContain('.claude/agents/rote-worker.md has no template');
    });
  });

  describe('the registry as a generator input', () => {
    it('counts the registry file among the generator inputs', () => {
      expect(collectSkillInputs(temporaryDir)).toContain(path.join(temporaryDir, REGISTRY_PATH));
    });

    it('regenerates every agent when the registry changes', () => {
      makeGeneratorSource(temporaryDir);
      makeAgentTemplate(temporaryDir, 'analyst', '---\nname: analyst\n---\n\nbody\n');
      makeAgentTemplate(temporaryDir, 'web-researcher', '---\nname: web-researcher\n---\n\nbody\n');
      const agents = { analyst: 'judgment', 'web-researcher': 'judgment' };
      makeRegistry(temporaryDir, { categories: { judgment: { model: 'sonnet' } }, agents });
      generateQuietly(temporaryDir);
      makeRegistry(temporaryDir, { categories: { judgment: { model: 'opus' } }, agents });

      generateQuietly(temporaryDir);

      expect(readAgent(temporaryDir, 'analyst')).toContain('\nmodel: opus\n');
      expect(readAgent(temporaryDir, 'web-researcher')).toContain('\nmodel: opus\n');
    });
  });

  it('generates a skill exactly as before, whatever the registry carries', () => {
    makeSkillTemplate(temporaryDir, 'write-blog', '---\nname: write-blog\n---\n\nbody\n');
    makeAgentTemplate(temporaryDir, 'write-blog', '---\nname: write-blog\n---\n\nbody\n');
    makeRegistry(temporaryDir, {
      categories: { judgment: { model: 'opus', effort: 'max' } },
      agents: { 'write-blog': 'judgment' },
    });

    generateQuietly(temporaryDir);

    expect(
      readFileSync(path.join(temporaryDir, '.claude/skills/write-blog/SKILL.md'), 'utf8')
    ).toBe(
      '---\nname: write-blog\n---\n\n<!-- AUTO-GENERATED from .claude/skills/write-blog/SKILL.template.md and the shared sources it draws on. Do not edit directly; edit those sources, then run pnpm generate:skills. -->\n\nbody\n'
    );
  });
});

describe('the agents directory', () => {
  const agentsDir = path.join(REPO_ROOT, '.claude/agents');
  const agentFiles = readdirSync(agentsDir).filter((file) => file.endsWith('.md'));

  it('holds only agent definitions, never a template', () => {
    expect(agentFiles.filter((file) => file.endsWith('.template.md'))).toEqual([]);
  });

  it('holds no unexpanded template variable', () => {
    const leaking = agentFiles.filter((file) =>
      /\{\{[A-Z_]+\}\}/.test(readFileSync(path.join(agentsDir, file), 'utf8'))
    );
    expect(leaking).toEqual([]);
  });
});
