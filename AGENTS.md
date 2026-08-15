# Vela

一个 DeepSeek Harness (DSH) 插件：让单个 Operator 像管理同事一样指派、追踪并验收多个 AI Agent 的工作。host + client 双面插件。

## 开发前必读

- **`CONTEXT.md`** — 领域术语表。命名领域概念时使用其中的规范术语，不要漂移到 `_Avoid_` 列出的同义词。
- **`docs/adr/`** — 架构决策记录。改动任何区域前先读该区域相关的 ADR。**若你的输出与某份 ADR 冲突，显式指出，不要静默覆盖。**
- **`.scratch/`** — issue tracker，spec 与 ticket 都在这里。

## DSH 插件约束

本项目是 DSH 插件，实现时遵循 `dsh-plugin-development` skill。几条最容易踩的红线：

- **运行面最小。** manifest、`exports`、`cordis.patch.yml` 与构建产物必须一致；任何入口都不能指向不存在的文件。
- **host / client 是两个 tsc program。** client 的 import 不得越过平台模块表——`@deepseek-ai/` 作用域外的第三方库正常打包，作用域内的跨插件值导入会在构建期被 purity gate 拒绝。
- **所有长生命周期资源必须可清理。** route、registry、timer、watcher、DOM、React root、存储都要有 disposer，挂在当前 fiber 上。
- **不注册工具。** 见 ADR-0012：Agent 不能写 Board。
- **验证要走真实组合。** 不只手搓 `ctx.plugin()`；至少一条路径经真实 Loader/patch 启动，并在全新 `DSH_HOME` + scratch profile 上验证 `dsh plugin add` → `--dump-config` → GUI。
- **dsh 处于 developer preview**，无兼容承诺。slot 名、平台模块表、service 接口都可能漂移；一切以当前 checkout 的实际代码为准，不凭文档猜。

## 许可义务

Board UI 从 Multica 移植（ADR-0005）。Multica License 条件 (b) **无非商业豁免**：Board 界面必须保留 Multica 的 logo、产品名与版权署名；派生文件需在头部注释标注来源；任何再分发必须完整交付整个 Multica LICENSE 与 NOTICE。

## Agent skills

### Issue tracker

Issues 与 spec 以 markdown 文件存放在 `.scratch/<feature-slug>/`（本地 tracker，无远端）。See `docs/agents/issue-tracker.md`.

### Triage labels

沿用五个 canonical 角色标签，记录在每个 issue 文件顶部的 `Status:` 行。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：根 `CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.
