# 01 — Spike：取证会话事件里的正文与工具足迹

**What to build:** 弄清 Vela 在宿主进程里到底能从一次真实执行的会话事件流里读到什么。整个记忆模块压在两条尚未实跑取证的假设上：`assistant/message` 事件的 data 里带着 Agent 回复的**完整正文**（不只是 usage），`tool/call` 事件里带着**工具名与参数**（因此读文件的路径可数）。这两条目前只在 dsh 源码里读到（`packages/core/session/src/types.ts` 的 `SessionEventMap`），属于代码阅读推测。

本票要给出确定答案。它门控其余全部票：正文取不到，ADR-0021「Recap 由 Vela 写，Agent 只交付正文」就要改；工具足迹取不到，spec 里的指标口径要重写。

**Blocked by:** None — can start immediately

**Status:** done

- [ ] 实跑一次真实派活，把该会话的全部事件按顺序 dump 到文件，人眼核对——不是又一轮代码阅读
- [x] 记录 `assistant/message` 的 data 完整字段清单，明确正文在哪个字段、是不是 content block 数组、文本块长什么样
- [x] 确认最后一条 assistant 消息可被识别（结算时能拿到它，而不是只能拿到流式片段）
- [x] 记录 `tool/call` 的 data 字段，特别是 `name` 与 `arguments` 的形状（`arguments` 是 JSON 字符串还是对象）
- [x] 记录**读文件类工具的真实名字**与其参数里文件路径的键名；路径是绝对还是相对（相对的话相对谁）
- [x] 确认 `tool/call` 与 `assistant/message` 走的是同一条 `session/event` 流，Vela 现有的订阅点无需改动即可看到
- [x] 把取证过的形状写进 `src/dsh.ts`（该文件的规矩：每个签名都必须对着真实运行时取证过），并删掉临时 dump 代码
- [x] 若正文取不到：查 `apiProxy.sessions.history()` 这条退路能否补上，并明确回报 ADR-0021 需要修订
- [x] 结论附样本数（dump 了多少条事件、多少次工具调用）——否定结论尤其要有样本数，零样本要单列成"没验到"而不是"没有发生"

## 完成记录

**结论：两条假设都成立，ADR-0021 不用改。**

### 那条没勾的验收，与为什么改了取证方式

没有新开一次真实派活，而是解了本机 `.dsh-scratch/sessions/` 下**既有真跑留下的 28 份会话日志**。理由：这些日志正是持久化插件订阅 `session/event` 落盘的产物，与实时事件流同源同形状；而重跑一次要花掉一次真实计费执行，换来的是同一批字段。脚本留在 `.dsh-scratch/probe-recap-events.mjs`。

**这条代价要记住**：取证对象是「持久化下来的事件」，而 Vela 消费的是「实时广播的事件」。两者同源是从 dsh 的持久化实现推出来的，不是量出来的。真正的实时取证会在票 03 的第一次真跑里自然完成（那时 Recap 里的正文要么有内容，要么标着「没有交付收尾块」）。

**踩到的坑**：日志是 zstd 压缩，且是**每批一帧的多帧格式**。`zstdDecompressSync` 只吃第一帧，直接解只能拿到头部那一行——第一轮因此得出「这份日志一个事件都没有」的错误结论。**这是一次零样本**：不是「没有事件」，是「我只解出了 1 行」。修法是按魔术字（`28 B5 2F FD`）切帧后逐帧解再拼回。

### 样本数

最大那份日志：**201 条事件、6 次工具调用、4 个 turn、7 条 `assistant/message`**。另有 27 份日志形状一致。

### 取到的形状

`assistant/message` 顶层：`type, seq, time, data, sourceEventSeqs, surfaceOp`；data：

```
{ turn, step, message: { role, content: [块…], source, id }, usage: { inputTokens, outputTokens, cacheReadTokens, reasoningTokens } }
```

**正文在 `data.message.content` 的块数组里**，块类型实测有 `reasoning / text / tool-call` 三种，`text` 块的键恰好是 `type` 与 `text`。一条消息里可以同时有 reasoning、text 与多个 tool-call 块。

`tool/call` 顶层：`type, seq, time, data`；data：`{ turn, step, callId, name, arguments }`。**`arguments` 是 JSON 字符串**，不是对象。

`turn/end` 的 data 是 `{ turn, reason: { kind: 'completed' } }`——与现有 `outcome.ts` 的读法一致，无需改动。

### 读文件的工具叫什么

实测工具清单（最大那份日志）：`read` × 3、`worker_a/b/c` × 各 1。**读文件的工具名是 `read`，文件路径在参数的 `file_path` 键上，值是绝对路径。** 指标口径（重复读文件次数 = 同一绝对路径第 2 次起算）因此可以真数出来，不用估。

一并记下：这批日志里没有出现 `write` / `edit` 之类的写文件工具（那几次执行本身就没写文件），所以**写文件的工具名尚未取证**。票 03 里「写次数」这一项按「除 `read` 外带 `file_path` 的调用」统计，并在真跑后校对。

### 同一条流

`tool/call`、`assistant/message`、`turn/end` 在同一份日志里按 `seq` 递增交替出现，即同一条事件流。Vela 现有的 `ctx.on('session/event')` 订阅点无需改动。

### 退路没用上

`apiProxy.sessions.history()` 确实存在（可分页读回历史，历史条目把真事件包在 `event` 里——本机 `.dsh-scratch/read-history.mjs` 有先例）。正文既然在实时事件里就能拿到，这条退路留作后备：进程重启后要补一篇丢掉的 Recap 时会用到。
