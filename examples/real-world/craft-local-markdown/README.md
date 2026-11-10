# Craft 本地 Markdown 交付用例

该固定场景要求助手读取 `materials/prices.md`，生成带来源的 Markdown 对比表，并写一份执行、核对和遗漏说明。数据为合成数据。

在 Craft-Eval 仓库根目录运行：

```bash
node dist/src/cli.js scenario examples/real-world/craft-local-markdown/scenario.json <subject.json> <runtime.json> \
  --workspace examples/real-world/craft-local-markdown/workspace --output /tmp/craft-local-markdown-run
```

`subject.json` 需配置本机可用的 Agent Host，`runtime.json` 需提供运行环境摘要。此用例通过 Craft-Eval 既有 Host 场景接口执行；它检查交付文件及报告内容，不会直接启动 Workbench 或替代真实 Workbench 端到端验收。
