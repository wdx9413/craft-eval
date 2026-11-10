# Craft public web research fixtures

This synthetic-only scenario exercises the normal Craft-Eval shared-workspace scenario runner. Its fixed cases cover source-backed findings, conflicting sources, missing promotion terms, an untrusted page instruction, a fetch failure, and partial delivery. The fake host writes only fixture-derived Markdown and performs no network request or model call.

From the Craft-Eval repository root, build the CLI and run:

```sh
npm run build
node dist/src/cli.js scenario examples/real-world/craft-web-research/scenario.json \
  examples/real-world/craft-web-research/subject.json \
  examples/real-world/craft-web-research/runtime.json \
  --workspace examples/real-world/craft-web-research/workspace \
  --output /tmp/craft-public-web-research-run
```

The run exercises suite generation, the shared-workspace executor, Markdown artifacts, final checks, and a scenario report. It validates evaluator wiring and report expectations only. It is not evidence that Craft performed HTTP requests, that a model interpreted pages correctly, or that Workbench connected to Craft over HTTP.
