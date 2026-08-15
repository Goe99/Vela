---
status: accepted
---

# Gate 不复用 DSH 的 user-approval

Gate 是 Vela 自己的 Issue 状态（「待验收」Lane），**不建立在 DSH 的 `user-approval` 服务之上**。一个未来的读者很可能会问「为什么不用现成的审批服务」——因为两者语义正交：

| | `user-approval` | Gate |
|---|---|---|
| 时机 | 执行中 | 产出后 |
| 阻塞性 | 同步、阻塞 Agent | 异步、不阻塞 |
| 时间尺度 | 秒级，打断式 | 可积压数小时 |
| 对象 | 单次工具调用 | 一个 Run 的整体产出 |

把「可积压的异步验收」塞进「阻塞式同步审批」会导致 Agent 挂着等待 Operator，白占会话与上下文窗口，并让沙箱审批这个真正需要即时响应的通道被验收积压淹没。

## Consequences

两套机制并存分工：`user-approval` 管执行中的危险操作，Gate 管产出验收。Vela 不拦截、不包装、不改写 `user-approval` 的任何行为——Run 执行期间的审批弹窗仍由 DSH 原生通道处理，Board 至多做旁观展示。
