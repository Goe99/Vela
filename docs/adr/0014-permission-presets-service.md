---
status: accepted
---

# 权限档位经 permissionPresets 服务施加，Vela 配置的是 preset 名字

本 ADR 关掉 ADR-0010 留下的最后一个证据缺口——一次 Run 的权限档位到底怎么施加。答案已实跑确认。

Run 的权限档位由官方的 **`ctx.permissionPresets` 服务**施加：`set(session, presetName)` 记录选择，并把该 preset 绑定的 sandbox 与 approval 两个 knob 分别经各自的 setter 写入会话。Vela 在会话创建之后、提交任务之前调用它。

## 一个被推翻的推测

设计阶段的推测是「向会话追加一条 `sandbox/mode` 事件」。那条路径技术上存在（`Session.append` 是公开的），但**它是错的抽象层**：sandbox 与 approval 是两个独立 knob，只写前者会留下一个权限组合不完整的会话；而 preset 表正是官方用来保证两者成对出现的机制。绕过它等于自己维护一份平行的权限语义。

## Vela 配置的是名字，不是档位值

`set` 接收的是 preset **名字**，不是 `SandboxMode` 取值。默认表里两者恰好同名（`workspace-write`、`danger-full-access`），实测本机部署还额外提供了 `read-only`——**部署可以改表**。因此：

- `Issue.exec.sandbox` 的类型是 `string`，不是三值联合。
- 派活前对着 `permissionPresets.names` 校验；未知名字在**创建会话之前**就被拒绝。一个拼错的档位名若等到 `set` 抛错才发现，那时会话已建好、Agent 已空转，收拾比拒绝一次配置贵得多。
- Board 视图把 `names` 一并下发给浏览器，编辑表单据此生成下拉框——UI 因此永远只列出这个部署真正支持的档位。

## Consequences

不指定档位时 Vela **什么都不做**，会话沿用发布时钉入的用户默认（框架的 `pinInitialPermission` 负责）。这让「不覆盖」成为真正的零行为，而不是悄悄改成某个 Vela 自选的值。

施加失败（服务未挂载、会话未 attach、名字未知）时 Run 立即结算为 error 且**任务从未被提交**——绝不让 Agent 在权限未知的情况下跑起来。这条不变量有测试覆盖。
