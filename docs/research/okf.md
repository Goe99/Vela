# OKF（Open Knowledge Format）调研与 Vela 融合方案

> 调研日期：2026-08-16
> 一手来源：
> - 规范全文：[GoogleCloudPlatform/knowledge-catalog · okf/SPEC.md (v0.2)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
> - 官方仓库：[GoogleCloudPlatform/knowledge-catalog](https://github.com/GoogleCloudPlatform/knowledge-catalog)
> - 发布博客：[Google Cloud Blog — How the Open Knowledge Format can improve data sharing](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)

---

## 1. OKF 是什么

**OKF（Open Knowledge Format，开放知识格式）** 是 Google Cloud Knowledge Catalog（原 Dataplex）团队提出的一种开放知识表示格式，当前版本 **v0.2**。一句话概括：

**用"一个目录的 Markdown 文件 + YAML frontmatter"来表示知识，让人和 Agent 都能直接读写，不需要任何专用工具或 SDK。**

规范原文的定位：

- 知识的载体是一个 **Knowledge Bundle（知识包）**：一棵 Markdown 文件目录树，就是分发的最小单位；`git clone` 即搬运。
- 每个知识单元是一个 **Concept（概念）**：一个 `.md` 文件 = 一个概念，frontmatter 里唯一必填字段是 `type`。
- 设计四原则：**人可读**（无需工具）、**Agent 可解析**（无需专用 SDK）、**可 diff**（进版本控制）、**可移植**（跨工具、跨组织、跨时间）。
- 刻意极简：没有 schema 注册中心、没有中央权威、没有必需工具链——"能 `cat` 就能读，能 `git clone` 就能分发"。

注意两点出身信息（面试被追问时要如实讲）：

1. 规范由 Google Cloud 官方博客发布，但 GitHub 仓库自带的免责声明写明 "not an official Google product"；它出自 Google Cloud 数据目录团队，**原生场景是数据知识/元数据**（表、指标、看板的语义层），不是对话记忆。
2. 版本很年轻（v0.1 → v0.2），生态刚起步；社区评价是"把 CLAUDE.md / 记忆文件夹的模式正式化成了规范"（Reddit r/ClaudeAI）。

## 2. 规范要点（v0.2）

### 2.1 目录结构

```
bundle/
  index.md          # 可选。目录清单，支持"渐进披露"（先看目录再决定读哪个文件）
  log.md            # 可选。按日期分组的更新历史，新的在前
  <concept>.md      # 概念文档
  <subdir>/...      # 子目录自由组织；references/ 是约定俗成的外部材料镜像目录
```

### 2.2 Concept 文档

frontmatter 唯一必填 `type`；推荐 `title` / `description` / `resource` / `tags`；允许任意扩展字段，消费者**不得**因未知字段拒绝文档。正文用结构化 Markdown，`# Schema` / `# Examples` / `# Computation` 是约定标题。

### 2.3 v0.2 的核心：让"Agent 持续维护的知识库"可信

v0.2 把五件事做成了一等公民——这是 OKF 区别于"随便一个记忆文件夹"的地方：

| 机制 | 字段 | 回答的问题 |
| --- | --- | --- |
| **溯源 Provenance** | `sources[]`（含 `author`/`usage_count`/`last_modified` 可信度信号） | 这条知识从哪来？ |
| **信任 Trust** | `generated.by/at` + `verified[]` | 谁写的、谁核过？ |
| **信任分级** | 由 `verified` 推导：unverified → machine-confirmed → **human-reviewed** | 该信多少？ |
| **生命周期** | `status: draft/stable/deprecated`、`stale_after`（绝对日期，过期即陈旧） | 还有效吗？ |
| **证实 Attestation** | `type: Attested Computation` 概念：声明许可的计算方式 + 确定性 attester 校验运行回执 | 这个数字是按我们说好的方式算出来的吗？ |

关键设计哲学：**OKF 只记录客观信号，不存主观评分**——可信度由消费者从信号推导，而不是存一个会过期的分数。Actor 约定：Agent 写 `<producer>/<version>`，人写 `human:<id>`，自动流程写 `process:<id>`。

### 2.4 合规要求

极低：每个非保留 `.md` 有可解析的 frontmatter 且含非空 `type` 即合规。消费者必须容忍：缺失的可选字段、未知的 type、未知扩展键、坏链接、缺失的 index.md。

## 3. 和常见 Agent 记忆方案的关系：不竞争，互补

| | MemGPT/Letta、Mem0、Zep 等 | OKF |
| --- | --- | --- |
| 本质 | **运行时记忆系统**：向量库/图数据库 + 检索 API，管"对话里记住什么" | **知识表示标准**：一目录 Markdown 文件，管"知识长什么样" |
| 存储 | 数据库（向量/图） | 普通文件，git 可管 |
| 信任/溯源 | 一般不是一等公民 | v0.2 核心（sources/verified/trust tier/stale_after） |
| 人类可读可改 | 弱（在库里） | 强（就是 Markdown） |

结论：OKF 不替代记忆系统，它给记忆系统提供**可移植、可验收、可版本化的落地格式**。检索引擎（向量/关键词）仍然可以加在 bundle 之上，OKF 不管索引——规范明确把存储/检索列为 non-goal。

## 4. 与 Vela 的融合方案

### 4.1 为什么 OKF 和 Vela 是天生一对

Vela 的平台叙事是"核心与宿主解耦、能力可复用"。OKF 恰好是同构的：知识包就是**一目录文件**，天然宿主无关——任何框架的 Agent 只要能读写文件就能生产/消费 Vela 的记忆。选 OKF 作为记忆模块的落地格式，等于给"Vela 能力可跨框架复用"这句话找了个行业标准背书。

更关键的是下面这个融合点，是其他记忆方案给不了的：

### 4.2 核心融合点：Gate 验收闸门 ↔ OKF 信任分级

OKF 的信任分级是 `unverified → machine-confirmed → human-reviewed`，而 Vela 有现成的 Gate——**Agent 有权交付，无权宣布通过**。两者拼起来：

1. Agent 每次 Run 结束，自动把摘要沉淀为 OKF 概念文档，`generated.by: vela/<version>`，此时信任等级 = **unverified**；
2. Operator 在 Gate 验收这张卡片时，**同时验收了它沉淀的记忆**：接受 → 写入 `verified: { by: human:operator }`，记忆升为 **human-reviewed**；退回 → 记忆停留 draft，不进入后续召回；
3. 于是"验收"从只管代码产出，升级为**管知识资产**——人对 Agent 记忆的把关不再是口头约定，而是状态机里的硬节点。这和 Vela"验收做成硬节点而不是流程约定"的设计哲学完全一致。

**这就是 Vela 记忆模块的差异化卖点：带验收闸门的 Agent 记忆。** 业界记忆方案都在卷"怎么记、怎么取"，Vela 回答的是"**Agent 记下的东西凭什么可信**"。

### 4.3 其余映射关系

| OKF 机制 | Vela 里的用途 |
| --- | --- |
| Concept + 目录树 | 记忆单元：Run 摘要、文件摘要、Squad 经验各为一种 `type`，按 workspace/日期组织目录 |
| `index.md` 渐进披露 | 上下文预算控制的天然接口：派活时先注入索引（极小 token），Agent 按需展开读详情——呼应 Harness 侧的分层上下文裁剪 |
| `sources` + `usage_count` | 召回排序信号：被召回次数多、人审过、新鲜的知识优先注入；`usage_count` 在每次召回时自增 |
| `stale_after` / `status` | 记忆保鲜：workspace 漂移或文件变更后把相关记忆标记 stale/deprecated，呼应已有的 workspace 漂移识别 |
| `log.md` | Run 历史的人类可读账本 |
| Actor 约定 | 区分记忆是人写的、Agent 写的还是流程生成的，与 Vela 的 Operator/Agent 术语对齐 |
| Attested Computation | （远期可选）Gate 的确定性验收检查：attester = 不经过模型的验收脚本 |

### 4.4 落地步骤（建议顺序）

1. **`core/okf` 纯逻辑模块**：frontmatter 解析/序列化、信任分级推导、stale 判定、index.md 生成——零依赖、纯函数，和现有领域层一个风格，先 TDD。
2. **Run 摘要沉淀**：Run 结束 → 生成 `type: Run Summary` 概念文件进 bundle（unverified）。
3. **Gate 联动**：验收接受/退回 → 回写 `verified` / `status`。
4. **派活召回**：按 tags/links 选出候选概念，先注入索引、按预算注入正文，`usage_count` 自增。
5. **量化指标**（简历要用，提前埋点）：重复读文件次数、注入 token 占比、召回命中率、human-reviewed 记忆占比。

### 4.5 风险与口径

- OKF 原生为数据目录场景设计，Vela 属于早期把它用到 Agent 任务记忆的场景——**这是亮点也是风险**：面试要能讲清"我们取了它的信任/溯源骨架，type 体系是自己定义的"。
- 规范年轻（v0.2），字段可能再变；`core/okf` 里集中处理解析，外部字段变更只动一处。
- 老规矩：**做多少写多少**。落地到第 2 步，简历才能写"基于 OKF 的记忆沉淀"；落地到第 3 步，才能写"验收闸门与信任分级联动"。
