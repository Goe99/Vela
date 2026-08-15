---
status: accepted
---

# Run 执行策略：默认不自动重试，配置为全局默认 + Issue 覆盖

本 ADR 补齐 ADR-0007 显式留下的缺口——Run 失败之后会发生什么，以及一次 Run 的执行参数从哪里来。

## 重试：机制存在，默认关闭

Issue 持有 `maxAttempts` 字段，**默认值为 0，即不自动重试**。Run 失败后 Issue 进入 Failed Lane 等待 Operator 处置。

Agent 的失败绝大多数是**确定性失败**——任务描述不清、缺少上下文、依赖未安装。这类失败重试三次只会消耗三倍 token 得到同一个错误，而消耗掉的 token 不可逆。默认关闭让 Operator 先看一眼失败原因；字段保留，等确认某类任务确实是瞬时失败（网络、限流）后再按 Issue 开启。

被拒绝的替代方案：**完全不提供重试机制**（价值主张要求「重试与超时策略」，机制必须在位）；**默认自动重试到 maxAttempts**（把不可逆的成本消耗设为默认行为）。

## 执行配置：全局默认 + Issue 覆盖

agent preset、sandbox 档位、超时三项均采用「全局默认值 + Issue 可覆盖」。

sandbox 档位必须能按 Issue 设定：「改 README」与「改构建脚本」的风险档位天然不同，统一档位要么过松要么过紧。但每次派活弹配置对话框会破坏一键派活的手感，而那是 Board 的核心体验。默认值覆盖绝大多数卡片，其余在卡片上单独覆盖。

被拒绝的替代方案：**每次派活弹配置对话框**（毁掉一键派活）；**只有全局默认、不可覆盖**（sandbox 档位无法按风险分级）。

## Consequences

「启动一个 Run」的窄接口（ADR-0004）需接收一份已解析完成的执行配置，解析顺序为 Issue 覆盖值 → 全局默认值。全局默认值属于插件的 Cordis 配置行，任何部署可能需要调整的值都应成为配置项而非源码常量。

## 三项配置的施加机制（已实跑确认）

三项配置的施加路径**并不统一**，实现时不要假设它们都是创建参数：

- **agent preset**：✅ 创建会话时作为参数给出（`apiProxy.sessions.create` 的 `agentPreset`），决定 model / provider / tools / system prompt。
- **超时**：✅ 无内置参数，由 Vela 自己计时并请求宿主取消。注意取消调用返回**不等于**执行已结束，因此还要等 `turn/end`，并为「等不到」设一个有界宽限后强制结算。
- **权限档位**：✅ 机制已查清，**但与原推测不同**。它不是 `sandbox/mode` 事件的手工追加，而是官方的 `ctx.permissionPresets` 服务：`set(session, presetName)` 会同时写入 sandbox 与 approval 两个 knob。详见 ADR-0014。

一处**术语修正**：本 ADR 原文把档位写成 read-only / workspace-write / danger-full-access 三个固定值。那是 `SandboxMode` 的取值，而 Vela 配置的是**权限 preset 的名字**——默认表里两者恰好同名，但部署可以改表。实测本机部署提供的正是这三个名字，但 Vela 对着 `permissionPresets.names` 动态校验而不写死。

决策本身（全局默认 + Issue 覆盖）不受影响，变的只是实现路径。
