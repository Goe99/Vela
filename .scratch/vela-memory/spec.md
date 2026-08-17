# Spec: Vela Memory — 带验收闸门的 Agent 记忆

> 状态：ready-for-agent
> 依据：ADR-0021 至 ADR-0027；受 ADR-0006 / 0007 / 0011 / 0012 / 0015 / 0020 约束
> 术语：[CONTEXT.md](../../CONTEXT.md) 的 Memory / Recap / Trust Level / Recall / Gate
> 调研：[docs/research/okf.md](../../docs/research/okf.md)

## Problem Statement

Operator 反复派活，Agent 每次从零开始。四个具体痛点：

- **同一批文件被反复重读。** 上一次执行认清的目录结构、找到的关键文件，下一次执行完全不知道，重新摸一遍。
- **同一个坑撞两次。** 上次发现「这个测试要先跑 build」，这次的 Agent 又踩一遍。
- **记下来的东西凭什么可信没人回答。** 业界的记忆方案卷的是「怎么记、怎么取」；把一段没有任何人看过的模型自述喂回下一次执行，是在放大错误而不是积累经验。
- **记忆绑在框架里，换宿主就全丢。** 存进某个运行时的向量库或数据库，那份"经验"就只属于那个框架。

## Solution

Memory 是一个目录：一堆 Markdown 加一份索引，没有数据库、没有嵌入、没有服务端。落盘格式是 OKF v0.2 —— `git clone` 即搬运，人和 Agent 都能直接读。

一次 Run 结束，Vela 落一篇 Recap：正文来自 Agent 收尾时按格式交付的一段，客观足迹（碰过哪些文件、跑过哪些命令、用量耗时）由 Vela 自己从会话事件里数出来填。Agent 是交付者，不是写手（ADR-0021）。

**Gate 的一次判定同时裁定两件事**：这次交付算不算数，以及这篇 Recap 可不可信。接受则回写「人审过」，这篇才有资格参与下一次派活的 Recall；退回则留在未验证，重跑落新篇时旧篇标废弃（ADR-0025）。

派活时 Recall 只挑人审过的：先注入索引（极小），Agent 按需展开正文，注入的段落带标题、Operator 能查到这次实际给它看了什么（ADR-0027）。失败与中断的执行也落 Recap，但只落客观部分，且不参与 Recall（ADR-0026）。

一句话卖点：**业界回答"怎么记、怎么取"，Vela 回答"Agent 记下的东西凭什么可信"。**

## User Stories

### 沉淀

1. As an Operator, I want each finished Run to leave a written recap on disk, so that what the Agent worked out survives the end of its session.
2. As an Operator, I want recaps to be plain Markdown files, so that I can hand-edit them, `git diff` them, and carry them to another machine.
3. As an Operator, I want the factual part of a recap filled in by Vela rather than the Agent, so that I don't have to take the model's word for what it did.
4. As an Operator, I want a recap to say plainly when the Agent delivered no closing block, so that an empty recap isn't mistaken for a considered one.
5. As an Operator, I want recap writing to never break a Run's settlement, so that a full disk costs me a recap and not a card stuck in Running.

### 验收联动

6. As an Operator, I want accepting a card to also rule on its recap, so that judging the work and judging the knowledge are one action.
7. As an Operator, I want "keep this recap" ticked by default with the option to untick, so that a good delivery with a poor write-up doesn't silently earn a trusted badge.
8. As an Operator, I want a rejected attempt's recap kept but marked superseded once the retry lands, so that "this route was tried and failed" survives without polluting recall.
9. As an Operator, I want the human review recorded inside the file itself, so that someone I hand the directory to can see which entries were reviewed without running Vela.
10. As an Operator, I want a card to reach Done even if writing to the recap file fails, with the file repaired later, so that a disk hiccup never blocks acceptance.

### 记忆页

11. As an Operator, I want a "记忆" entry in the navigation, so that I can find the library without being told where it lives.
12. As an Operator, I want recaps listed per Workspace with their trust level and staleness visible, so that I can tell reviewed knowledge from unreviewed at a glance.
13. As an Operator, I want to open a recap and read it in place, so that I don't have to leave the panel to inspect what was recorded.
14. As an Operator, I want to delete a recap with a line left in the update log, so that removals are deliberate rather than silent.
15. As an Operator, I want an unconfigured Memory to say "not enabled" rather than show an empty list, so that I can tell "switched off" from "nothing recorded yet".
16. As an Operator, I want an unparseable file shown as unreadable rather than skipped, so that a broken file surfaces instead of vanishing.

### 召回

17. As an Operator, I want past reviewed recaps carried into a dispatch automatically, so that the Agent starts with what was already learned.
18. As an Operator, I want injected sections clearly headed, so that I can see which part of the task text Vela added.
19. As an Operator, I want to inspect what was actually shown to the Agent on a given Run, so that its behaviour is explainable after the fact.
20. As an Operator, I want the injection capped by a budget, so that memory never eats the context window it was meant to save.

### 失败与保鲜

21. As an Operator, I want failed and interrupted Runs to leave a factual record, so that "we hit this same error here last time" is available.
22. As an Operator, I want unreviewed records kept out of recall, so that nothing unvetted is fed back into the next Run.
23. As an Operator, I want recaps to go stale on a fixed date, so that knowledge about a codebase that has since moved on stops being injected.

### 指标

24. As an Operator, I want the repeated file reads of a Run counted, so that "memory reduced rework" is a number rather than a feeling.
25. As an Operator, I want to run the same batch of cards with memory on and off, so that the comparison is measured rather than asserted.

## Implementation Decisions

### 存储形态与布局

- **Memory 全局一份，路径显式配置，不配置就整个功能不启用**（ADR-0022）。新增配置项 `memoryPath`，语义与 `boardPath` 一致：绝对路径，不回落 `process.cwd()`，不猜 DSH 家目录。
- 目录布局：

```
<memoryPath>/
  index.md                      根索引，frontmatter 带 okf_version: "0.2"
  log.md                        更新历史，新的在前
  runs/<workspace-slug>/
    index.md                    该 Workspace 的索引
    <issue-number>-r<run-seq>.md
```

- `workspace-slug` 由 Workspace 绝对路径生成：basename 小写、非字母数字换 `-`，再接该绝对路径短哈希的前 8 位。不同仓库重名不会撞车，同一仓库跨重启稳定。
- 写入沿用 Board 快照那套原子发布（同目录临时文件 + fsync + rename），复用 `store.ts` 已验证的写法而不是另写一份。

### Recap 的字段

- frontmatter 唯一必填是 `type`，取值 `Run Summary`（本轮只有这一种 type）。推荐字段全给：`title`（Issue 标题）、`description`（一句话结果）、`tags`（`workspace:<slug>` / `issue:<number>` / `outcome:<…>`）。
- Vela 自己的扩展事实收在 `vela_run` 一个键下（OKF 允许任意扩展键）：Issue 编号、Run 序号、sessionId、outcome、用量、耗时、文件足迹（路径 + 读次数 + 写次数）、命令条数、以及本次的指标计数。**不另建统计存储**——实验报告从这些文件汇总。
- 正文固定四个小标题：`## 结论` / `## 做了什么` / `## 坑与注意`（这三段来自 Agent）、`## 客观足迹`（Vela 填）。
- **收尾块的形状**：派活文本要求 Agent 在最后一条回复里输出一个 ` ```vela-recap ` 围栏块，块内是上面前三个小标题。Vela 取最后一条 assistant 消息里最后一个该围栏块。用围栏而非裸小标题的理由：围栏在会话文本里是稳定可识别的边界（`extract.ts` 的 `stripFences` 已有先例），且围栏内的字不会被 Operator 误读成对他说的话。

### 信任与生命周期（两条轴，各管一件事）

- `status` 管生命周期：落盘 `draft` → Gate 接受 `stable` → 被新篇取代或被 Operator 否掉 `deprecated`。
- `verified[]` 管信任，Trust Level 由它**推导**，不存字段：无 `verified` = unverified；有人类 actor = human-reviewed；有非人 actor = machine-confirmed。
- **本轮不产生 machine-confirmed**（Vela 没有确定性 attester），但推导函数必须支持它——读别人的 bundle 时会遇到。
- `stale_after` = 落盘日期 + 90 天，写成绝对日期（规范要求）。90 天是常量，不做配置，测试锁住。

### 落盘时机

- 落盘接在 Run 结算处，与用量写入同一次快照事务之后。工具足迹在执行期间攒在内存里（与实时用量同款，不落盘）。
- 四种收尾各落什么：`completed` 落全篇；`error` / `timeout` / `aborted` / `interrupted` 只落客观部分，正文三段留空并标注原因（ADR-0026）。
- **写盘失败只记警告**，绝不冒泡到结算路径——一张卡的复盘没写成，不能把整个 dsh 拖下水。

### Gate 联动与双写

- 验收接口新增 `keepRecap`（缺省 `true`）。接受且保留 → 追加 `verified: { by: human:operator, at }` 并置 `status: stable`；接受但不保留、或退回 → 留 `draft` 且不写 `verified`。
- **顺序固定：先改 Board 快照，再回写文件。** Board 是真相（ADR-0025）。
- **对账不需要新增 schema 字段，因此 `BOARD_VERSION` 不升。** 待补的事实可由现有数据推导：卡片在 Done 且该 Run 的 Recap 仍是 `draft` → 补写 `verified`；`deprecated` 表示"故意不要"，与"没写成"因此可区分。对账在两处触发：插件启动时、以及打开记忆页时。

### Recall 与预算

- 候选集：**同一个 Workspace**、`status == stable`、未陈旧、非 `deprecated`。按 `verified` 时间倒序。
- 索引最多 10 篇（每篇一行标题）；正文最多展开 2 篇、合计不超过 4000 字符，超出则截到最后一个完整段落并标注已截断。三个数字写成常量并由测试锁住。
- `usage_count` **只在正文被真正展开时自增**，进索引不算——进索引只是候选，不代表被用到。
- 注入形状：`## 以前的经验`（Recall）与 `## 收尾要求`（收尾块约定）两段，带标题、与任务正文用 `---` 隔开（ADR-0027）。普通卡与小队卡都注入；小队卡里排在队长职责之后、任务之前。

### 导航与页面

- `nav.ts` 新增一项：key `memory`、label `记忆`、group `workspace`，摆在 `squads` 之后 `usage` 之前；`NavView` 加 `'memory'`（ADR-0024）。
- `nav.spec.ts` 的两条断言跟着改（数量 12→13、键名清单插入 `memory`）。**核心不变量不动**：每项都有明确归属、置灰两种原因分得开。
- 记忆页是 Vela 自己画的第四处界面。数据一律经 `BoardClient` 取，不绕过它另开 fetch。样式进 `styles.ts` 的 `data-vela-*` 体系；**CSS 变量必须先定义再引用**。

### 指标口径

- **重复读文件次数**：一次 Run 内，同一绝对路径的读类工具调用次数减一后求和（第 2 次起算）。读类工具的真实名字以票 01 的取证结果为准，不硬编码猜测。
- **注入压缩率**：注入段落字符数 ÷ 被选中 Recap 正文全文字符数。
- **Token**：`inputTokens` 与 `cacheReadTokens` **分列不合并**——缓存命中会让"省了多少"失真。

## Testing Decisions

沿用现有两个主接缝 + 一条纯逻辑接缝，不新增接缝层级。

### 纯逻辑（`src/domain/`，可脱离宿主单测）

frontmatter 往返相等、未知键原样保留回写、坏文件报出行号与键名、三档信任推导（含读到 machine-confirmed）、陈旧边界（到期当天算不算）、索引与更新历史生成、Recall 的候选筛选与预算裁剪、指标计数（同一路径读两次记一次重复）。

### host 接缝：HTTP 路由

记忆列表 / 详情 / 删除、验收带 `keepRecap` 的两种走向、未配置 `memoryPath` 时明确回"没开启"、对账能把漏写的 `verified` 补上、`deprecated` 不被对账误补。

### host 接缝：执行器

四种收尾各落什么、收尾块缺失时正文留空并标注、写盘失败只警告不影响结算、注入形状（有记忆/无记忆/小队卡三种）、`usage_count` 只在展开时自增。

### client 接缝

记忆页渲染（`renderToStaticMarkup`）、导航契约更新、"没开启"与"这篇读不了"两种态。

### 组合门禁

全新 `DSH_HOME` + scratch profile 真跑一次派活：磁盘上真出现 Recap 文件、验收后 `verified` 真落进文件、下一次派活的开场消息里真带上那段经验。

## Out of Scope

- **主题聚合（File Summary / Squad Playbook）**：合并多篇需要模型能力，而 Vela 拿不到模型（ADR-0021）。本轮只有 `Run Summary` 一种 type。
- **向量检索 / 嵌入 / 语义搜索**：OKF 明确把索引列为 non-goal；本轮按标签与时间选，不做相似度。
- **Attested Computation**：远期可选，本轮不做。
- **页面里编辑正文**：文件本来就能手改，页面编辑器对核心卖点无加成。
- **给 Failed 卡开验收动作**（ADR-0026）。
- **每张卡的「这次带记忆」开关**（ADR-0027，等对比数据出来再定）。
- **跨 Workspace 召回**。
- **产生 machine-confirmed**：需要确定性验收脚本，本轮只支持读。
- **第二宿主（headless CLI）**：它能把"可复用"从主张变证据，但不在本轮。

## Further Notes

### 实施前必须清掉的证据缺口

1. **`assistant/message` 事件 data 里正文的确切形状。** 只在 dsh 源码里读到（`packages/core/session/src/types.ts` 的 `SessionEventMap`），未实跑取证。**票 01 门控其余全部票**——取不到正文，ADR-0021 就要改（退路是 `apiProxy.sessions.history()` 分页读回来）。
2. **`tool/call` 的 `name` / `arguments` 形状与读文件类工具的真实名字。** 指标口径依赖它。
3. **模型能否稳定按围栏格式收尾。** 票 03 会给出第一批样本；命中率太低就把「收尾要求」写得更硬（带例子）。

### 实施顺序（按风险递减）

票 01（取证）与票 02（纯逻辑地基）可并行 —— 后者不依赖任何宿主事实。之后 03 打通落盘，04 / 05 / 06 三条从 03 分叉：04 补失败路径、05 是核心卖点、06 是找得到入口。07 建在 05 之上（只有人审过的才有资格被召回）。08 是人工对比实跑，出简历要的数字。

### 演进风险

- **OKF 还年轻**（v0.1 → v0.2），字段可能再变。解析集中在一处，改动面是一个文件（ADR-0023）。
- **口径要诚实**：规范由 Google Cloud 的数据目录团队提出、仓库声明「not an official Google product」，原生场景是数据知识与元数据而非 Agent 任务记忆。Vela 属于早期把它用到任务记忆的场景，对外表述照此说，不夸成标准背书。
- **做多少写多少**：票 03 落地才能说"基于 OKF 的记忆沉淀"，票 05 落地才能说"验收闸门与信任分级联动"，票 08 跑完才能给数字。
