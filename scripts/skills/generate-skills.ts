import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isMainModule } from '../lib/cli/is-main.js';
import { readCommandLineOrRefuse, type CommandSpec } from '../lib/cli/command-line.js';
import { withCache } from '../readme/cache.js';

/**
 * The single source of truth for the anti-slop checklist. Every skill that
 * embeds the checklist injects this file at generate time; no skill duplicates
 * the rules by hand and no skill points at another skill to read them.
 */
const FRAGMENT_PATH = '.claude/skills/anti-ai-writing/anti-slop-rules.md';

/**
 * The single source of truth for the subagent-driven orchestration engine.
 * Its `<!-- @section: NAME -->` markers split it into named values injected into
 * every subagent-driven skill's template, so no such skill hand-duplicates the
 * shared dispatch loop, scoped checks, or subagent roster.
 */
const CORE_PATH = '.claude/skills/subagent-driven-dev/subagent-driven-core.md';

/**
 * The single source of truth for the subagent-driven implementer and auditor
 * bodies. The plain agents and their UI variants are assembled from its
 * sections, so the two variants of a role cannot drift apart.
 */
const SDD_AGENTS_CORE_PATH = '.claude/skills/subagent-driven-dev/sdd-agents-core.md';

/**
 * The single source of truth for HushBox's frontend craft rules and the live
 * design-review method. The frontend-design skill, the design-review agent, and
 * the subagent-driven UI agents are all assembled from its sections.
 */
const FRONTEND_DESIGN_CORE_PATH = '.claude/skills/frontend-design/frontend-design-core.md';

/** Every file whose `<!-- @section: NAME -->` markers contribute template values. */
const SECTION_FILES = [CORE_PATH, SDD_AGENTS_CORE_PATH, FRONTEND_DESIGN_CORE_PATH] as const;

/**
 * The single source of truth for the blog voice, injected into the write-blog
 * skill and into the agents that judge a draft against that voice.
 */
const VOICE_PATH = '.claude/skills/write-blog/voice.md';

/**
 * The single source of truth for the research file-mode contract, injected into
 * the agent definitions that honour it. A fragment lives with whatever owns the
 * rule it states: under a skill's own directory when that skill's manual is the
 * authority, and here — the agent-templates fragments directory — when the rule
 * belongs to no skill and only agent definitions inject it, so an editor of one
 * skill's manual cannot silently rewrite an agent invoked from everywhere.
 */
const RESEARCH_FILE_MODE_PATH = '.claude/agent-templates/fragments/research-file-mode.md';

const SKILLS_DIR = '.claude/skills';

/**
 * Every agent definition has a template under this directory; the generated
 * definition lands in `.claude/agents/` under the same basename, and a file
 * there without a template is refused. Templates live outside the agents
 * directory because Claude Code loads every Markdown file there as an agent,
 * and a template sharing its output's `name:` frontmatter would compete with it
 * for that name.
 */
const AGENT_TEMPLATES_DIR = '.claude/agent-templates';

const AGENTS_DIR = '.claude/agents';

/**
 * The single source of truth for every agent's `model:` and `effort:`: it puts
 * each agent in a category and gives each category its values, so changing one
 * category's model regenerates every agent in it. Templates never carry either
 * key. Skills are outside it: a skill's `model:` lasts one turn, and skill
 * `model:`/`effort:` fields break claude.ai and Skills API upload.
 */
const MODEL_CATEGORIES_PATH = '.claude/agent-templates/model-categories.json';

/** The model aliases are an allowlist so a typo fails here, not silently at dispatch. */
const ModelCategoriesShape = z.strictObject({
  categories: z.record(
    z.string(),
    z.strictObject({
      model: z
        .union([
          z.enum(['fable', 'opus', 'sonnet', 'haiku']),
          z.string().regex(/^claude-[a-z0-9.-]+$/),
        ])
        .optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    })
  ),
  agents: z.record(z.string(), z.string()),
});

type ModelCategories = z.infer<typeof ModelCategoriesShape>;

/** A frontmatter key only the registry may set. */
const REGISTRY_OWNED_KEY = /^(?:model|effort)[ \t]*:/m;

const FRONTMATTER_OPEN = '---\n';

const FRONTMATTER_CLOSE = '\n---\n';

/**
 * Prepended to every generated file. It sits after the YAML frontmatter,
 * never before it: a skill's or agent's frontmatter `---` fence must be the
 * file's first line or Claude Code fails to parse it.
 */
function notice(templateName: string): string {
  return `<!-- AUTO-GENERATED from ${templateName} and the shared sources it draws on. Do not edit directly; edit those sources, then run pnpm generate:skills. -->`;
}

export interface SkillTarget {
  kind: 'skill' | 'agent';
  name: string;
  /** The generated file, relative to the tree it lives in, for progress lines. */
  label: string;
  templatePath: string;
  outputPath: string;
}

/**
 * A formatter range-ignore comment protects a section's exact lines in the
 * source file (a report format the formatter would otherwise reflow); it is a
 * fact about the source, so it never reaches a generated output.
 */
const FORMATTER_RANGE_IGNORE = /^[ \t]*<!-- prettier-ignore-(?:start|end) -->[ \t]*\n?/gm;

/**
 * Split a core file into named values, one per `<!-- @section: NAME -->`
 * marker. Each value is the text from its marker to the next marker (or EOF),
 * trimmed, with formatter range-ignore comments removed. Text before the first
 * marker (the file's header comment) is ignored.
 */
export function parseCoreSections(core: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const marker = /<!-- @section:\s*([A-Z0-9_]+)\s*-->/g;
  const matches = [...core.matchAll(marker)];
  for (const [index, match] of matches.entries()) {
    const name = match[1];
    /* v8 ignore next 3 -- the marker regex always captures group 1 on a match, so match[1] is never undefined for a matched result */
    if (name === undefined) {
      throw new Error(`section marker matched without a name: ${match[0]}`);
    }
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? core.length;
    sections[name] = core.slice(start, end).replaceAll(FORMATTER_RANGE_IGNORE, '').trim();
  }
  return sections;
}

/**
 * Every section from every section file, keyed by name. A name two files both
 * define is refused: the templates cannot say which text they meant.
 */
function parseSectionFiles(rootDir: string): Record<string, string> {
  const sections: Record<string, string> = {};
  for (const file of SECTION_FILES) {
    const parsed = parseCoreSections(readFileSync(path.resolve(rootDir, file), 'utf8'));
    for (const [name, value] of Object.entries(parsed)) {
      if (name in sections) {
        throw new Error(`section ${name} is defined in more than one core file (${file})`);
      }
      sections[name] = value;
    }
  }
  return sections;
}

/**
 * Template values injected into every SKILL.template.md. The checklist and the
 * section files are read from their single-source files so editing one file
 * updates every skill and agent that consumes it.
 */
export function getSkillTemplateValues(rootDir: string): Record<string, string> {
  const fragment = readFileSync(path.resolve(rootDir, FRAGMENT_PATH), 'utf8').trim();
  const voice = readFileSync(path.resolve(rootDir, VOICE_PATH), 'utf8').trim();
  const researchFileMode = readFileSync(
    path.resolve(rootDir, RESEARCH_FILE_MODE_PATH),
    'utf8'
  ).trim();
  return {
    ANTI_SLOP_CHECKLIST: fragment,
    BLOG_VOICE: voice,
    RESEARCH_FILE_MODE: researchFileMode,
    ...parseSectionFiles(rootDir),
  };
}

/**
 * Every skill directory that opts into generation by holding a SKILL.template.md,
 * then every agent template under the agent-templates directory.
 */
export function collectSkillTargets(rootDir: string): SkillTarget[] {
  const skillsDir = path.join(rootDir, SKILLS_DIR);
  const skills = readdirSync(skillsDir)
    .filter((name) => existsSync(path.join(skillsDir, name, 'SKILL.template.md')))
    .toSorted((a, b) => a.localeCompare(b))
    .map((name) => ({
      kind: 'skill' as const,
      name,
      label: `${name}/SKILL.md`,
      templatePath: path.join(skillsDir, name, 'SKILL.template.md'),
      outputPath: path.join(skillsDir, name, 'SKILL.md'),
    }));
  const templatesDir = path.join(rootDir, AGENT_TEMPLATES_DIR);
  const agents = (existsSync(templatesDir) ? readdirSync(templatesDir) : [])
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -'.md'.length))
    .toSorted((a, b) => a.localeCompare(b))
    .map((name) => ({
      kind: 'agent' as const,
      name,
      label: `agents/${name}.md`,
      templatePath: path.join(templatesDir, `${name}.md`),
      outputPath: path.join(rootDir, AGENTS_DIR, `${name}.md`),
    }));
  return [...skills, ...agents];
}

/** Files whose contents determine the generated SKILL.md output. */
export function collectSkillInputs(rootDir: string): string[] {
  return [
    path.join(rootDir, 'scripts/skills/generate-skills.ts'),
    path.join(rootDir, FRAGMENT_PATH),
    path.join(rootDir, VOICE_PATH),
    path.join(rootDir, RESEARCH_FILE_MODE_PATH),
    path.join(rootDir, MODEL_CATEGORIES_PATH),
    ...SECTION_FILES.map((file) => path.join(rootDir, file)),
    ...collectSkillTargets(rootDir).map((target) => target.templatePath),
  ];
}

/**
 * Insert the do-not-edit notice after the frontmatter fence, or at the top when
 * the file has none. Leading blank lines of the body are collapsed so the
 * output stays Prettier-clean.
 */
export function withNotice(content: string, notice: string): string {
  const close = frontmatterClose(content);
  if (close !== -1) {
    const insertAt = close + FRONTMATTER_CLOSE.length;
    const before = content.slice(0, insertAt);
    const after = content.slice(insertAt).replace(/^\n+/, '');
    return `${before}\n${notice}\n\n${after}`;
  }
  return `${notice}\n\n${content.replace(/^\n+/, '')}`;
}

/** Where the closing frontmatter fence starts, or -1 when content opens with no terminated frontmatter block. */
function frontmatterClose(content: string): number {
  return content.startsWith(FRONTMATTER_OPEN) ? content.indexOf(FRONTMATTER_CLOSE, 3) : -1;
}

function repoRelative(rootDir: string, file: string): string {
  return path.relative(rootDir, file).split(path.sep).join('/');
}

function refuse(heading: string, offenders: readonly string[]): never {
  console.error(`ERROR: ${heading}`);
  for (const offender of offenders) {
    console.error(` - ${offender}`);
  }
  process.exit(1);
}

function readModelCategories(rootDir: string): ModelCategories {
  const file = path.join(rootDir, MODEL_CATEGORIES_PATH);
  if (!existsSync(file)) refuse(`${MODEL_CATEGORIES_PATH} is missing`, []);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    refuse(`${MODEL_CATEGORIES_PATH} is not valid JSON`, [String(error)]);
  }
  const parsed = ModelCategoriesShape.safeParse(raw);
  if (!parsed.success) {
    refuse(`${MODEL_CATEGORIES_PATH} does not match the registry shape`, [
      z.prettifyError(parsed.error),
    ]);
  }
  return parsed.data;
}

/** Every `.claude/agents/*.md` file with no template of the same basename. */
function untemplatedAgents(rootDir: string, agentTargets: readonly SkillTarget[]): string[] {
  const agentsDir = path.join(rootDir, AGENTS_DIR);
  const templated = new Set(agentTargets.map((target) => target.outputPath));
  return (existsSync(agentsDir) ? readdirSync(agentsDir) : [])
    .filter((file) => file.endsWith('.md'))
    .toSorted((a, b) => a.localeCompare(b))
    .map((file) => path.join(agentsDir, file))
    .filter((file) => !templated.has(file))
    .map(
      (file) =>
        `${repoRelative(rootDir, file)} has no template at ${AGENT_TEMPLATES_DIR}/${path.basename(file)}`
    );
}

/** Every agent template the registry does not cover, or whose frontmatter it cannot own. */
function templateOffenders(
  rootDir: string,
  agentTargets: readonly SkillTarget[],
  registry: ModelCategories
): string[] {
  const offenders: string[] = [];
  for (const target of agentTargets) {
    const template = repoRelative(rootDir, target.templatePath);
    if (!Object.hasOwn(registry.agents, target.name)) {
      offenders.push(`${template} has no entry in ${MODEL_CATEGORIES_PATH}`);
    }
    const content = readFileSync(target.templatePath, 'utf8');
    const close = frontmatterClose(content);
    if (close === -1) {
      offenders.push(`${template} does not open with a YAML frontmatter block`);
    } else if (REGISTRY_OWNED_KEY.test(content.slice(0, close))) {
      offenders.push(
        `${template} sets model: or effort: in its frontmatter; ${MODEL_CATEGORIES_PATH} owns both`
      );
    }
  }
  return offenders;
}

/** Every registry entry naming an agent with no template or a category the registry does not define. */
function entryOffenders(agentTargets: readonly SkillTarget[], registry: ModelCategories): string[] {
  const templated = new Set(agentTargets.map((target) => target.name));
  const offenders: string[] = [];
  for (const [agent, category] of Object.entries(registry.agents)) {
    if (!templated.has(agent)) {
      offenders.push(`${MODEL_CATEGORIES_PATH} names agent ${agent}, which has no template`);
    }
    if (!Object.hasOwn(registry.categories, category)) {
      offenders.push(
        `${MODEL_CATEGORIES_PATH} puts agent ${agent} in category ${category}, which it does not define`
      );
    }
  }
  return offenders;
}

/**
 * The agent's frontmatter with its category's `model:` then `effort:` as the
 * last lines before the closing fence. A category with no model writes no
 * `model:` line rather than `inherit`: an absent line is the only form provably
 * identical to an agent never pinned.
 */
function withCategoryLines(content: string, agent: string, registry: ModelCategories): string {
  /* v8 ignore start -- {@link entryOffenders} refuses every agent without a defined category before any target is generated, so neither lookup misses */
  const category = registry.categories[registry.agents[agent] ?? ''];
  if (category === undefined) {
    throw new Error(`agent ${agent} has no defined category in ${MODEL_CATEGORIES_PATH}`);
  }
  /* v8 ignore stop */
  const lines = [
    ...(category.model === undefined ? [] : [`model: ${category.model}`]),
    ...(category.effort === undefined ? [] : [`effort: ${category.effort}`]),
  ];
  const close = frontmatterClose(content);
  return `${content.slice(0, close)}${['', ...lines].join('\n')}${content.slice(close)}`;
}

/**
 * Generate each skill's SKILL.md and each agent's definition from its template
 * by injecting the shared checklist, and each agent's model and effort from the
 * model-category registry. Exits code 1 on any refusal (blocks the commit).
 * Cached: skips when inputs and outputs are unchanged; the registry checks run
 * on every invocation.
 *
 * Returns every output path, on the cached branch too: the pre-commit hook
 * stages exactly this list, so a skipped run still has to say what it would
 * have written. Progress goes to stderr to keep stdout that list alone.
 */
export function generateSkills(rootDir: string): string[] {
  const targets = collectSkillTargets(rootDir);
  const agentTargets = targets.filter((target) => target.kind === 'agent');
  // Before the cache: an untemplated agent is not among the cached files, so a
  // check inside the cached branch would let a hand-written agent slip past.
  const untemplated = untemplatedAgents(rootDir, agentTargets);
  const registry = readModelCategories(rootDir);
  const offenders = [
    ...untemplated,
    ...templateOffenders(rootDir, agentTargets, registry),
    ...entryOffenders(agentTargets, registry),
  ];
  if (offenders.length > 0) refuse('agent definitions refused:', offenders);
  withCache(
    {
      label: 'Skills',
      hashPath: path.join(rootDir, SKILLS_DIR, '.cache/skills.hash'),
      inputs: collectSkillInputs(rootDir),
      outputs: targets.map((target) => target.outputPath),
    },
    () => {
      const values = getSkillTemplateValues(rootDir);
      for (const target of targets) {
        let content = readFileSync(target.templatePath, 'utf8');
        for (const [key, value] of Object.entries(values)) {
          content = content.replaceAll(new RegExp(String.raw`\{\{${key}\}\}`, 'g'), () => value);
        }

        const unmatchedVariables = content.match(/\{\{[A-Z_]+\}\}/g);
        if (unmatchedVariables) {
          console.error('ERROR: Unmatched template variables found:');
          for (const variable of new Set(unmatchedVariables)) {
            console.error(` - ${variable}`);
          }
          console.error(`Fix the placeholders in ${target.templatePath}`);
          process.exit(1);
        }

        if (target.kind === 'agent') content = withCategoryLines(content, target.name, registry);

        mkdirSync(path.dirname(target.outputPath), { recursive: true });
        writeFileSync(
          target.outputPath,
          withNotice(content, notice(repoRelative(rootDir, target.templatePath)))
        );
        console.error(`✓ Generated ${target.label} from template`);
      }
    }
  );
  return targets.map((target) => target.outputPath);
}

export const COMMAND_LINE = {
  command: 'pnpm generate:skills',
  summary: 'Writes every generated skill and agent definition from its template.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI wiring; generator covered via unit tests */
const isMain = isMainModule(import.meta.url);
if (isMain && readCommandLineOrRefuse(COMMAND_LINE, process.argv.slice(2)) !== null)
  console.log(generateSkills(process.cwd()).join('\n'));
/* v8 ignore stop */
