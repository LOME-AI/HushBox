import { describe, expect, it } from 'vitest';

import { findRunExpressions } from './workflow-run-expressions.js';

describe('findRunExpressions', () => {
  it('finds an expression substituted into an inline run command', () => {
    const workflow = `jobs:
  build:
    steps:
      - run: gh run cancel \${{ github.run_id }}
`;

    expect(findRunExpressions(workflow)).toEqual([
      { line: 4, text: '- run: gh run cancel ${{ github.run_id }}' },
    ]);
  });

  it('finds an expression in a step whose dash is padded with extra spaces', () => {
    const workflow = `jobs:
  build:
    steps:
      -   run: echo \${{ github.sha }}
`;

    expect(findRunExpressions(workflow)).toEqual([
      { line: 4, text: '-   run: echo ${{ github.sha }}' },
    ]);
  });

  it('finds an expression substituted into a block-scalar run body', () => {
    const workflow = `jobs:
  build:
    steps:
      - name: Deploy secrets
        run: |
          echo "\${{ secrets.FCM_SERVICE_ACCOUNT_JSON }}" | wrangler secret put FCM
`;

    expect(findRunExpressions(workflow)).toEqual([
      {
        line: 6,
        text: 'echo "${{ secrets.FCM_SERVICE_ACCOUNT_JSON }}" | wrangler secret put FCM',
      },
    ]);
  });

  it('leaves an expression bound through the step env block alone', () => {
    const workflow = `jobs:
  build:
    steps:
      - name: Deploy secrets
        run: |
          printf '%s' "$FCM" | wrangler secret put FCM
        env:
          FCM: \${{ secrets.FCM_SERVICE_ACCOUNT_JSON }}
`;

    expect(findRunExpressions(workflow)).toEqual([]);
  });

  it('leaves expressions outside a run body alone', () => {
    const workflow = `jobs:
  build:
    if: \${{ github.event_name == 'push' }}
    steps:
      - uses: actions/checkout@abc
        with:
          ref: \${{ github.sha }}
      - run: pnpm build
`;

    expect(findRunExpressions(workflow)).toEqual([]);
  });

  it('leaves a mapping key named run that is not a step alone', () => {
    const workflow = `jobs:
  run:
    env:
      DATABASE_URL: \${{ secrets.DATABASE_URL }}
    steps:
      - run: pnpm tsx ops/run.ts
`;

    expect(findRunExpressions(workflow)).toEqual([]);
  });

  it('stops attributing lines to a run body once the block dedents', () => {
    const workflow = `jobs:
  build:
    steps:
      - name: Build
        run: |
          pnpm build
        env:
          VERSION: \${{ inputs.version }}
      - name: Tag
        run: git tag "v\${{ inputs.version }}"
`;

    expect(findRunExpressions(workflow)).toEqual([
      { line: 10, text: 'run: git tag "v${{ inputs.version }}"' },
    ]);
  });

  it('finds an expression on a continuation line of an inline run command', () => {
    const workflow = `jobs:
  build:
    steps:
      - name: Release
        run: gh release create
          "v\${{ inputs.version }}"
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

    expect(findRunExpressions(workflow)).toEqual([{ line: 6, text: '"v${{ inputs.version }}"' }]);
  });

  it('finds an expression in a block scalar whose header puts the indent first', () => {
    const workflow = `jobs:
  build:
    steps:
      - name: Tag
        run: |2-
            git tag "v\${{ inputs.version }}"
`;

    expect(findRunExpressions(workflow)).toEqual([
      { line: 6, text: 'git tag "v${{ inputs.version }}"' },
    ]);
  });

  it('finds an expression on a shell comment line inside a run body', () => {
    const workflow = `jobs:
  build:
    steps:
      - name: Announce
        run: |
          # release notes: \${{ github.event.head_commit.message }}
          gh release create
`;

    expect(findRunExpressions(workflow)).toEqual([
      { line: 6, text: '# release notes: ${{ github.event.head_commit.message }}' },
    ]);
  });

  it('finds an expression in a composite action step', () => {
    const action = `runs:
  using: composite
  steps:
    - run: echo "\${{ inputs.token }}"
      shell: bash
`;

    expect(findRunExpressions(action)).toEqual([
      { line: 4, text: '- run: echo "${{ inputs.token }}"' },
    ]);
  });

  it('finds an expression in a step following a comment dedented past its steps block', () => {
    const workflow = `jobs:
  build:
    steps:
      - name: Build
        run: |
          pnpm build
# the release is cut from the build above
      - name: Tag
        run: git tag "v\${{ inputs.version }}"
`;

    expect(findRunExpressions(workflow)).toEqual([
      { line: 9, text: 'run: git tag "v${{ inputs.version }}"' },
    ]);
  });

  it('finds an expression in a step written as a flow mapping', () => {
    const workflow = `jobs:
  build:
    steps:
      - { run: 'echo \${{ github.sha }}', shell: bash }
`;

    expect(findRunExpressions(workflow)).toEqual([
      { line: 4, text: "- { run: 'echo ${{ github.sha }}', shell: bash }" },
    ]);
  });

  it('finds an expression under a quoted run key', () => {
    const workflow = `jobs:
  build:
    steps:
      - "run": echo "\${{ secrets.TOKEN }}"
`;

    expect(findRunExpressions(workflow)).toEqual([
      { line: 4, text: '- "run": echo "${{ secrets.TOKEN }}"' },
    ]);
  });

  it('finds an expression on a last line written without a newline after it', () => {
    const workflow = `jobs:
  build:
    steps:
      - run: echo "\${{ github.sha }}"`;

    expect(findRunExpressions(workflow)).toEqual([
      { line: 4, text: '- run: echo "${{ github.sha }}"' },
    ]);
  });

  it('reads a steps sequence whose items are not all mappings', () => {
    const workflow = `jobs:
  build:
    steps:
      - not a step
      - run: echo "\${{ github.sha }}"
`;

    expect(findRunExpressions(workflow)).toEqual([
      { line: 5, text: '- run: echo "${{ github.sha }}"' },
    ]);
  });

  it('refuses a source the YAML parser rejects rather than reading it as clean', () => {
    const workflow = `jobs:
  build:
    steps:
      - run: echo "\${{ github.sha }}"
\t- run: echo tab
`;

    expect(() => findRunExpressions(workflow)).toThrow(/not parseable YAML/);
  });
});
