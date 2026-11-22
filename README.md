# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bayusantosz3995/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bayusantosz3995/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Agent harnesses apply edits that models write, and models write them in four
formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks,
the V4A patch format, and text-editor tool calls as JSON. mend reads all four
to one written specification, finds the lines an edit names even when the model
drifted their whitespace or indentation, and changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the patch file, relative to the working directory. When it is
  absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new` for
a move) and `ok: <n> files`. Exit 1 lists every failed edit and prints
`failed: <k> of <n> edits`; nothing is written. Exit 2 is a single `error:`
line: `usage`, `no-patch`, `format`, or `parse <N>`.

## Matching

An edit's old lines are found at the first of three tiers at which they occur:
exact, then trailing whitespace ignored, then leading and trailing whitespace
ignored. Context lines are written back as the file's own matched lines, and
at tier 2 the new lines are re-indented to the file's indentation. Unified
hunks take the occurrence nearest the hunk's (often wrong) line number;
SEARCH/REPLACE blocks fail as ambiguous when the old lines occur more than
once; V4A chunks follow a cursor with optional anchors.

## Files

- `main.ts` — the CLI. Node 22 and its standard library alone.
- `runner.ts` — the kit's trial runner, kept as it is.
- `check.ts` — the practice set on your own machine:
  `node check.ts <practice.json>`.
- `SPEC.md` — the whole specification (version 1).

## Practice

    node check.ts ../program/generator/practice.json

100 of 100 practice checks pass: practice score 1000.

## License

MIT. See `LICENSE`.
