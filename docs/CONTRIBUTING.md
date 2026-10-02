# Contributing

Guide for contributing to HushBox.

---

## Prerequisites

- **Node.js** - [Download](https://nodejs.org/), any release that runs pnpm. The runtime
  this repository runs on is declared once, as `devEngines.runtime` in the root
  `package.json`; `pnpm install` resolves it through `pnpm-lock.yaml` and installs it, and
  every command run through pnpm uses it. An `npm` or `npx` command issued inside the
  repository reads that declaration too and refuses with `EBADDEVENGINES` when the shell's
  Node falls outside the range; run the tool as `pnpm exec <tool>` instead, which puts the
  installed runtime first on `PATH`.
- **pnpm** - the version `packageManager` in the root `package.json` declares; install it
  with `npm install -g pnpm@<that version>`
- **Docker** - [Download](https://docker.com/products/docker-desktop/)

---

## Quick Start

```bash
git clone https://github.com/LOME-AI/HushBox.git
cd hushbox
pnpm install
pnpm dev
```

This starts Docker services, runs migrations, and launches all dev servers.

---

## Documentation

- [TECH-STACK.md](./TECH-STACK.md) - Architecture and technology decisions
- [CODE-RULES.md](./CODE-RULES.md) - Coding standards

---

## Pull Request Process

1. Create a branch or fork from `main`
2. Make changes with tests
3. Ensure all checks pass (`pnpm lint && pnpm typecheck && pnpm test`)
4. Submit PR with clear description
5. Address review feedback
6. HushBox team runs "pr test" for integration tests
7. Merge when approved

---

## Contributor Assignment Agreement

All contributors must sign our Contributor Assignment Agreement before pull requests can be merged:

- **Individual contributors:** When you open your first pull request, the CLA Assistant bot will comment with a link to review and sign the [Individual CAA](https://gist.github.com/ctf05/24b91cac419a904919d1ad30eb14b9cd). You only need to sign once.
- **Company contributors:** If you are contributing on behalf of an employer or organization, contact legal@hushbox.ai to arrange Entity CAA signing before submitting contributions.

If you have questions about the agreement, contact legal@hushbox.ai before submitting a contribution.

---

## Questions?

- Open an issue for bugs or feature requests
- Email hello@hushbox.ai for other inquiries
