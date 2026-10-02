import { formatQuestionsBrief } from '@hushbox/docket';
import { selectFindings } from './select-findings';
import type { CliDeps } from './deps';
import type { QuestionsCommand } from './parse-command';

/**
 * Every question still waiting on an answer, in the one document the console
 * hands over. The brief comes from `@hushbox/docket`, so what an agent reads
 * here and what the console shows are the same text, down to the command that
 * answers each question.
 *
 * It reads the Questions queue by name, so a dedicated finding owed an answer
 * is in this document as it is in the console's tab. The skip that keeps
 * dedicated work out of unscoped listings is about intake; this is the only
 * surface on which an outstanding question is discovered rather than already
 * known by id, and answering one is not taking the work on.
 */
export async function runQuestions(command: QuestionsCommand, deps: CliDeps): Promise<number> {
  const selection = await selectFindings(command, command.audit, deps, 'questions');
  if (selection === null) return 1;

  const brief = formatQuestionsBrief(selection.findings.map((entry) => entry.finding));
  if (brief === null) {
    deps.err(`docket: no question is waiting in ${selection.auditName}`);
    return 0;
  }

  deps.out(brief);
  return 0;
}
