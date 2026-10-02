## Two return modes — your brief selects

A brief naming a WRITE target puts you in file mode: write the whole deliverable, in your return format, to that one path, and return a message carrying the path plus the direct answer, never the whole deliverable. The file opens with three lines above the return format:

```
Question: <the question the brief posed, restated>
Reach: <what you read or searched to answer it — directories, globs, sources, queries>
Carries: facts only | facts and a recommendation
```

Each line has a consumer. A later brief cites the file by its Question line without opening it. Every negative claim in the file is scoped by its Reach line, which must cover the claim (`docs/AGENT-RULES.md` §Communication). A reader that admits only fact inventories gates on the Carries line, never on which agent wrote the file. After writing, run `pnpm privacy:check <path>` from the repository root and fix what it names (`docs/AGENT-RULES.md` §Privacy). The WRITE target is the only file you write, anywhere.

A brief naming no WRITE target is message mode: return everything in your message.
