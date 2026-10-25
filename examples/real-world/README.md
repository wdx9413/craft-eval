# Real-world evaluation suites

Four suites that exercise `craft-eval` against third-party code instead of its
own examples. **94 independent cases** in total, each graded on its own checks.

## Subjects

The checkouts live outside this repo at `../eval-subjects/` (sibling of
`craft-eval/`), so they are not vendored here:

| Suite | Subject | Language | Cases | What each case grades |
| --- | --- | --- | --- | --- |
| `mcp-filesystem` | [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) (`src/filesystem`) | TypeScript | 24 | One MCP behaviour: handshake, tool listing, each of 12 tools, error paths, path confinement |
| `claude-seo` | [AgriciDaniel/claude-seo](https://github.com/AgriciDaniel/claude-seo) | Python | 24 | One capability area's pytest group (agentic output, auth hardening, cost tracking, …) |
| `pocketflow` | [The-Pocket/PocketFlow](https://github.com/The-Pocket/PocketFlow) | Python | 23 | One graph semantic (walk, conditional, retry, batch, async fan-out) + its own unit files |
| `craft-eval` | this repo | TypeScript | 23 | One evaluator capability (trace handling, artifact guards, MCP mocking, …) |

## Running

```powershell
# once, to prepare the third-party checkouts
git clone --depth 1 https://github.com/modelcontextprotocol/servers.git ../eval-subjects/mcp-servers
git clone --depth 1 https://github.com/AgriciDaniel/claude-seo.git        ../eval-subjects/claude-seo
git clone --depth 1 https://github.com/The-Pocket/PocketFlow.git          ../eval-subjects/pocketflow

# the filesystem server must be built, because the suite drives its dist entry
cd ../eval-subjects/mcp-servers/src/filesystem && npm install && npm run build

# then, from the repo root
npm run build
# mcp-filesystem's per-case workspaces are generated, not committed
powershell -File examples/real-world/mcp-filesystem/materialize.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File examples/real-world/run-all.ps1
```

`run-all.ps1` prints one row per suite plus a total, and exits non-zero if any
suite is not `complete` or has failures.

Expected result on a machine without `gcloud` and without outbound whois:

```
Suite          Cases Status   Passed Failed
-----          ----- ------   ------ ------
mcp-filesystem    24 complete     24      0
claude-seo        24 complete     22      2
pocketflow        23 complete     23      0
craft-eval        23 complete     23      0

total: 92/94 cases passed
```

## Why cases, not one blob per repo

A suite with one case per repo answers "did anything break". A suite with one
case per behaviour answers "what broke", and lets a consumer act on the report:

- `mcp-filesystem`: the four security cases (dotdot, absolute-outside-root,
  write-outside-root, mkdir-outside-root) fail independently of the twelve
  happy-path tool cases, so a confinement regression cannot hide behind a
  passing round-trip.
- `claude-seo`: the two failing cases are `webmaster-integrations` and
  `gcloud-adc`. Both are environment limits — no `gcloud` binary, no outbound
  whois — not subject defects. Every other capability area passes.
- `pocketflow`: thirteen cases probe the library's own semantics (including
  non-obvious ones like "retry counts attempts, not retries" and "Flow walks
  copies of the start node"), ten run its own unit files per area.
- `craft-eval`: one case per evaluator capability, so a regression in trace
  validation reports as `03-missing-terminal-trace-…` rather than "tests failed".

## Per-case workspaces

`mcp-filesystem` gives every case its own directory under `workspaces/`, because
each probe needs different seed files (a file to move, a directory to list, a
missing path to reject). A case names its workspace with the `workspace` field,
resolved under `--workspace`; a path that escapes it is rejected at load time.

`craft-eval` builds and runs its own suite, which needs `node_modules` and
`dist` — both excluded from the sandbox copy. Those cases set `in_place: true`,
which runs them against the checkout itself. Their `outputs/` is redirected
outside the checkout so the subject is never written to.

## Regenerating a suite

Each suite's cases are generated from a script, so adding a case is a one-line
change rather than hand-edited JSON:

```powershell
node examples/real-world/mcp-filesystem/build-probes.mjs   # probe definitions
powershell -File examples/real-world/mcp-filesystem/materialize.ps1  # per-case workspaces
node examples/real-world/mcp-filesystem/build-suite.mjs    # suite.json
node examples/real-world/claude-seo/build-suite.mjs
node examples/real-world/pocketflow/build-suite.mjs
node examples/real-world/craft-eval/build-suite.mjs
```

## Platform notes

- Interpreters are passed explicitly (`py -3`) rather than relying on `python`:
  on this Windows host `python.exe` resolves to the Microsoft Store stub, which
  fails inside a spawned child. This is what the `interpreter` field on `script`
  checks exists for.
- `subject.env` may not use the `CRAFT_EVAL_` prefix — those variables are
  evaluator controls and are rejected at load time. The filesystem driver
  receives its connection descriptor through `EVAL_SUBJECT_SERVER` instead.
- `npm`/`cmd` output on Windows is not UTF-8 by default; adapters that capture
  it must pass `encoding="utf-8", errors="replace"`.
- `process.execPath` is the embedding host when a script runs under one, so the
  suite generators use `node` from `PATH` rather than `process.execPath`.
