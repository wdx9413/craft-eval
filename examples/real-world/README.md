# Real-world evaluation suites

Four suites that exercise `craft-eval` against third-party code instead of its
own examples. They exist to prove the evaluator generalises: the subjects were
written by other people, in three languages, and none of them was modified to
make grading easier.

## Subjects

The checkouts live outside this repo at `../eval-subjects/` (sibling of
`craft-eval/`), so they are not vendored here:

| Subject | Repo | Language | What is graded |
| --- | --- | --- | --- |
| `mcp-filesystem` | [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) (`src/filesystem`) | TypeScript | MCP protocol handshake, tool listing, file write/read round-trip |
| `claude-seo` | [AgriciDaniel/claude-seo](https://github.com/AgriciDaniel/claude-seo) | Python | Full `pytest` run: collection, pass rate, absence of internal errors |
| `pocketflow` | [The-Pocket/PocketFlow](https://github.com/The-Pocket/PocketFlow) | Python | Full `unittest` discovery: every test passes |
| `craft-eval` | this repo | TypeScript | Self-check: `npm run build` succeeds and the whole suite passes |

## Running

```powershell
# once, to prepare the third-party checkouts
git clone --depth 1 https://github.com/modelcontextprotocol/servers.git ../eval-subjects/mcp-servers
git clone --depth 1 https://github.com/AgriciDaniel/claude-seo.git        ../eval-subjects/claude-seo
git clone --depth 1 https://github.com/The-Pocket/PocketFlow.git          ../eval-subjects/pocketflow

# the filesystem server must be built, because the suite drives its dist entry
cd ../eval-subjects/mcp-servers/src/filesystem && npm install && npm run build

# then, from the repo root
powershell -NoProfile -ExecutionPolicy Bypass -File examples/real-world/run-all.ps1
```

`run-all.ps1` prints one row per suite and exits non-zero if any suite is not
`complete` or has failures.

## What each suite demonstrates

### `mcp-filesystem` — server mode

The subject is a long-running stdio server, not a script that exits. This is the
case the `driver` field was added for: the evaluator starts `argv` as a service,
runs `driver.argv` to completion, then terminates the service. The driver is an
MCP client that performs `initialize`, `tools/list`, `write_file` and
`read_file`, and records the results in `outputs/mcp-result.json`; the checks
grade that JSON.

Verdicts are attributed to the driver, which is what makes a server testable at
all — a server never exits on its own, so "exit code" would otherwise be
meaningless.

### `claude-seo` — pass-rate grading over a large suite

1053 tests. The adapter runs pytest with `--junitxml` and converts the report to
JSON, so grading does not depend on scraping console output.

Nine tests fail in this environment for reasons unrelated to the subject: the
`lxml` parser and the `gcloud` CLI are absent. The pass-rate script therefore
accepts >= 98%, and a separate check asserts `errors == 0` so a collection
crash (which is a real defect) cannot hide inside a tolerable failure count.

### `pocketflow` — zero-dependency determinism

56 tests, no API keys, no network. The suite asserts both that the count is
sane (`>= 30`) and that `ok` is true, so deleting tests cannot turn a red suite
green.

### `craft-eval` — self-application

Builds the evaluator and runs its own 22 tests through the same machinery. This
is the regression guard for the other three: if a change breaks the runner, this
suite fails first and locally.

## Platform notes

- Interpreters are passed explicitly (`py -3`) rather than relying on `python`:
  on this Windows host `python.exe` resolves to the Microsoft Store stub, which
  fails inside a spawned child. This is exactly what the `interpreter` field on
  `script` checks exists for.
- `subject.env` may not use the `CRAFT_EVAL_` prefix — those variables are
  evaluator controls and are rejected at load time. The filesystem driver
  receives its connection descriptor through `EVAL_SUBJECT_SERVER` instead.
- `npm`/`cmd` output on Windows is not UTF-8 by default; adapters that capture
  it must pass `encoding="utf-8", errors="replace"`.
