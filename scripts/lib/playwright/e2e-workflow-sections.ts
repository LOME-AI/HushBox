import { formatRunProjects, RUN_PROJECTS_VARIABLE } from './browser-matrix.js';
import { E2E_PROJECTS } from './projects.js';

/**
 * One CI job per registered project. A project the registry does not declare
 * gets no job, which is the property that makes the registry the only place a
 * project can be declared.
 *
 * Three keys, because three are all any step reads: the browser is what
 * `playwright install` takes, the project is what the run step selects, and the
 * webhook lane gates the steps that wire the single Hookdeck listener.
 */
export function generateE2eMatrix(): string {
  return (
    E2E_PROJECTS.map((project) =>
      [
        `- project: ${project.name}`,
        `  browser: ${project.browser}`,
        ...('webhookLane' in project ? ['  webhookLane: true'] : []),
      ].join('\n')
    ).join('\n') + '\n'
  );
}

/**
 * The run each of those jobs belongs to. Work that must happen once per run
 * (engine-any carrier election) is resolved across these projects, never from
 * the one project a job's process executes.
 */
export function generateE2eRunSet(): string {
  const projects = formatRunProjects(E2E_PROJECTS.map((project) => project.name));
  return `${RUN_PROJECTS_VARIABLE}: '${projects}'\n`;
}
