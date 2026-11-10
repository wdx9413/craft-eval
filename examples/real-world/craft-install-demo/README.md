# Craft 安装版生命周期演示（固定合成页面）

此演示按固定本地竞品页面依次经过模型配置占位、只读研究、Markdown 交付、保留用户编辑、进程重启后续接、追加竞品、项目纠正与撤销。运行不联网、不调用模型，Key 只用 [REDACTED] 占位。

    npm run build
    node dist/src/cli.js scenario examples/real-world/craft-install-demo/scenario.json \
      examples/real-world/craft-install-demo/subject.json \
      examples/real-world/craft-install-demo/runtime.json \
      --workspace examples/real-world/craft-install-demo/workspace \
      --output /tmp/craft-install-demo-run

每一步由独立合成 Host 进程运行，共用 workspace 文件；这覆盖 Craft-Eval 的固定场景和磁盘续接，不证明真实模型配置、Workbench HTTP、macOS 通知、系统重启或安装包效果。桌面通知和审批行为由 Workbench 的独立 UI seam 测试覆盖。
