import { exitWhenWritten, runCli } from './run.js';
import { filmVerbs } from './verbs.driver.js';

await exitWhenWritten(await runCli(process.argv.slice(2), filmVerbs));
