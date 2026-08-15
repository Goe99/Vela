# 07 — 派活：Run 启动、Running Lane 与跳转会话

**What to build:** Operator 在卡片上一键派活，Vela 为该 Issue 起一个 Run，Agent 在自己的顶层会话里真实执行，卡片自动流转到 Running。点击这个 Run 就跳进它的会话，Board 随之关闭。这一票把「像管同事一样派活」这句话变成可点击的东西。

**Blocked by:** 02 — Spike：确认 sandbox 档位的施加机制；04 — 创建 Issue 并在 Board 上展示

**Status:** done

- [x] 卡片上一键派活，为该 Issue 新建一个 Run
- [x] Run 是一个**顶层会话**，不是 subagent 子会话；工作目录取自 Issue 的 Workspace
- [x] Agent 被真实驱动执行任务：创建会话 → 创建 agent → 提交任务 → 等待结束
- [x] Run 启动后 Issue 自动进入 Running Lane，无需 Operator 操作
- [x] Run 使用全局默认的 agent preset 与 sandbox 档位，档位按 02 的结论施加
- [x] 点击某个 Run 打开它的会话并关闭 Board
- [x] 「启动一个 Run」收敛在一个窄接口后面，接收一份已解析完成的执行配置
- [x] Run 记录只持有其会话标识；执行日志**不**被复制进 Vela 的存储
- [x] 执行期的沙箱审批仍走 DSH 原生通道，Vela 不拦截、不包装、不改写
- [x] Run 结束原因被正确读取并区分（正常完成 / 被中止 / 出错 / 达到 token 上限 / 被中断）
- [x] 插件在 host 面**不注册任何工具**
- [x] host 侧测试用 fake 的会话与 agent 服务覆盖 Run 生命周期，不真实调用模型
- [x] 插件 fiber 卸载时其创建的 Agent 被清理，明确会话的归属与残留策略

## 完成记录

**已实跑端到端验证。** 一张卡片派活后：Agent 在自己的顶层会话里真的建出了目标文件，卡片自动流到待验收（**不是** Done），token 用量正确快照进 Run，接受后进 Done，且从 Done 直接拖回 Running 被 409 拒绝。

**执行路径与票面不同**：不是 `sessions.create()` + `agents.create()`，而是官方的 `apiProxy.sessions`（因为第三方插件解析不到那几个运行时模块）；结束判定用 `turn/end` 事件而非 `whenIdle()`。结论不变（Run 是顶层会话），详见 ADR-0015。

**最后一条的真实情况：策略是「不清理」。** 插件卸载时 Vela 只清自己的计时器与在途记账，**不**去终止已创建的 Agent 或会话——会话是 DSH 的资产不是 Vela 的，杀掉一个 Operator 可能正在看的会话比留着它更坏。残留后果由**启动时对账**处理：停在 running 的 Run 被结算为 interrupted（用量标为未知），因此卡片不会永远停在 Running。这条有测试覆盖。
