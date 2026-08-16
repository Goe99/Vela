---
status: accepted
---

# 一个 Squad 持久化为一份 DSH agent preset 目录

Vela 的 Squad 不存在 Vela 自己的 JSON 快照里，而是**一份 DSH agent preset 目录**：`<dshHome>/.agent-presets/vela-<slug>/agent.cordis.yml`。

那份组合文件是**一份基准 preset 的全文副本，后面追加每个 Member 一行**：

- 开头是基准（默认 `standard`）的逐字节副本——文件工具、shell、skills、压缩、计划模式那些行全部在内
- 其后每个 Member 一行 `@deepseek-ai/dsh-tool-subagent`，其中 `toolName` 是 Member 的名字、`persona` 是它的 Instruction、`toolFilter` 是它的工具白名单、`provider` 是它的执行后端

**Leader 的 Instruction 不在这份文件里。** 它作为队长会话的**开场消息**前置到任务前面，原因见下文「为什么必须建在基准之上」。

派活即 `apiProxy.sessions.create({ agentPreset: 'vela-<slug>' })`：Leader 带着全队上场，每个 Member 以一个具名工具的形态出现在 Leader 眼前。

## 为什么必须建在基准之上

**一份 preset 是一个 agent 平面的完整组合，不是一份补丁。** preset 里没写的行不会从别处继承。官方 `standard` 里那句注释已经预告了后果：“Every model-facing row lives on the agent plane… a child that joins nothing reaches the model with no tools at all”。

这不是推理。第一版就是从零写的（一行队长 persona + N 行队员），一次真实派活下去，三次委派全部失败，错误一字不改：

```text
tools.restrict() names unknown global tools "read", "glob", "grep", "write", "edit";
known global tools: writer
```

机理：子代理创建时先 `composeFrom()` 加入父 agent 的 preset，再对继承到的工具集调 `restrict()`。那份 preset 取代了 `standard`，于是队长可继承的工具只剩我们自己注册的 `writer`，白名单里的名字全部解不开。**最阴的一点：卡片看起来跑完了**（进 review、token 也烧了），但一件事也没做成。

### 三个形状上的约束

**追加而不是改写。** 基准文件带注释和 `!!js` 自定义标签，拿 JSON 解析不了；而「在一个 YAML 顶层序列后面再接一项」根本不需要理解前面的内容。追加的行写成 JSON flow 形式（`- {"id": …}`）——那是合法的 YAML 序列项，且免了手拼引号与缩进（队员职责是自由文本）。

**Leader 的 Instruction 只能走开场消息。** 基准自己已经有一行 `dsh-persona`，而同一作用域里 `deployment:persona` 这个段名只能注册一次——再加一行**不是覆盖，是直接抛错**，整支队起不来（dsh 自己的测试 `rejects an unscoped mount…` 钉的就是这个）。而基准那一行又删不掉。代价：职责不再是系统级设定（模型原则上可以忽略它），也失去了前缀缓存的好处。这直接推翻了本 ADR 早期那句「队长的 instruction 是真的系统设定」——那与「小队必须继承基准工具」不能兼得。

**能力→工具名的映射跟着基准走。** 准确的判据是「基准实际注册了什么」，不是「dsh 源码里存在什么」。具体踩到的：出厂 `standard` 给 `tool-web` 配的是 `fetch: false`，所以「联网」能力里**不能有 `web_fetch`**，尽管 dsh 确实有这个工具。这一致性现在由一条直接读真基准文件的测试钉住。

## 实跑证据

两次真实派活（一支叫 `hello squad` 的队，一个叫 `writer` 的队员）。

**第一次（从零写的组合）对三项、错一项，而错的那项致命。** 对的：① dsh 的 preset 列表认出了 `vela-hello-squad`，`trust: user`，无 broken —— JSON 写进 `.yml` 这条路子成立。② 会话日志里有 `permission/preset: danger-full-access`，档位真的在提交任务前施加上了。③ 队长真的调了 `writer`，名册进了提示。错的：三次委派全部失败（上面那段错误），目标文件根本没建出来。

**第二次（基准全文 + 追加）全绿。** 组合文件 277 行、以基准的注释开头、persona 行恰好一行、队长职责一个字也不在里面。会话里：无任何 `tools.restrict()` 报错；队长既调了 `writer`（派活）又调了 `read`（自己回读验收）——后者正是基准恢复后才有的能力；档位在 seq 3/4 从默认 `workspace-write` 被覆写为 `danger-full-access`；dsh 眼里挂着一个子代理；目标文件真的写出来了，内容一字不差。

## 为什么 preset 是唯一正解

**这是 DSH 唯一支持「按会话组合」的接缝。** Member 需要各自的 Instruction 与工具白名单，而这两样都必须注册在 **agent 作用域**上（`systemPrompt.section()` 与 `tools.restrict()`）。Vela 活在 host 面，拿不到 agent 作用域的这些服务——preset 挂载时由 DSH 提供该作用域，这正是 preset 存在的理由。

**官方把这条路写进了注释。** 内置 `standard` preset 里，两个外部产品后端的行以 `disabled: true` 躺着，旁边写着「Copy this preset, then remove `disabled` from either ordinary tool row to expose that product only to agents composed from the copy」。复制 preset 再改行，就是官方设计的扩展方式。

**多实例是显式支持的。** `dsh-tool-subagent` 的配置注释写明「Each loaded instance must use a distinct name」——装多份、各配一个 `toolName`，是这个插件的预期用法，不是我们在钻空子。

**写进 DSH 家目录，而不是 Vela 自己的目录。** `<dshHome>/.agent-presets` 是 DSH 默认唯一可写的 preset 根（`includeUserRoot` 默认为 true）。写在那里的副作用是好的：**DSH 原生的会话入口也能直接选到 Squad**，Operator 不必非从 Board 走。

## Considered Options

- **Vela 自存 JSON，派活时用 `ctx.plugin()` 运行时挂载队员行** — 拒绝。需要 agent 作用域的 `tools` / `systemPrompt`，host 面拿不到；且绕开 DSH 的组合审计，一行没起来也不会有人报错。
- **把队员行直接写进 profile 的 `cordis.patch.yml`** — 拒绝。那是全局的：每个会话都会看到所有 Squad 的所有 Member 工具，Squad 之间没有边界。
- **只用 DSH 自带的那个通用委派工具，靠 Leader 的 Instruction 描述角色** — 拒绝。Member 就拿不到各自的工具白名单，ADR-0001 里「最小权限的主体从人换成 Agent」这一内核随之落空。

## Consequences

**真相分两处，必须清楚各管什么。** Squad 的**结构**（Leader/Member、Instruction、白名单、后端）在 preset 文件里；Squad 的**默认沙箱档位**在 Vela 自己的快照里——因为沙箱是会话的运行时旋钮，不是组合行，只能在建会话之后施加（见 ADR-0014）。这是接缝形状决定的，不是疏忽。

**Squad 定义不受 Vela 的原子写保护。** preset 文件由 DSH 的目录扫描发现，Vela 只是写文件的人。写坏一份 YAML 的后果是那个 Squad 在 DSH 的健康检查里显示为 broken，而不是 Board 崩掉。

**反复编辑会累积内存，直到进程结束。** DSH 为每个组合文件的新版本另起一代挂载，且**旧代永不回收**（官方已知限制）。本地自用可接受；一晚上改几十次 Squad 后重启一次 dsh 即可。

**运行中的 Run 不受编辑影响。** 已经产出内容的会话不能换 preset，且每次派活都新建会话——所以编辑 Squad 只影响之后派的活，正在跑的那次保持它上场时的阵容。

**Squad 的 id 不能撞内置名。** 内置根优先级高于家目录，`standard` / `minimal` / `code` / `cordis` 这些名字会把家目录里的同名 preset 遮掉。统一加 `vela-` 前缀既避开这个坑，也让 DSH 的 preset 列表里一眼分得出哪些是 Vela 造的。

**一个填错的工具名会让整个 Squad 起不来。** 白名单里的未知工具名在挂载时 fail loud，后果是这个 Squad 的会话建不起来。因此白名单不能是自由文本输入的默认路径——必须给受控选项（见 ADR-0017）。

**基准拿不到就不建队。** 写小队时现取基准（`agentPresets.read(id)`，它返回原始 YAML 文本，正好是追加需要的形式）；服务没挂载或基准不是一个顶层序列时，保存直接失败且不留目录。不缓存基准：它本身也只是一份文件，拿一份过期基准造出的小队会与 Operator 看到的 dsh 行为不一致。

**没用官方的 `agentPresets.copy()`。** 它确实存在且复制整个目录，但两条不合：我们本就要覆盖 `preset.yml`（小队自己的显示名），而且它遇到已存在会抛 `PresetExistsError`——而编辑小队是常态，每次保存都要重写。读文本 + 自己写三个文件少一个副作用面。

## 队员是一次性模式，不是可继续模式

本 ADR 早期给队员配的是 `backgroundMode: continuable`，理由是「队员会话持久化，Operator 能点进去看，队长也能给它补充指令」。**那个选择被实跑推翻了**：可继续模式把委派的默认变成后台，而后台可继续子代理不经过 `provider.start()`，于是 ADR-0018 的号牌闸门完全失效。详细证据在 ADR-0018。

代价：队员跑完就收尾，不能再给它补充指令。保留的：会话仍然真存在且能点进去看（dsh 的子代理清单里能查到它们）。拿不能追加指令换一个真的能拦住的并发上限，这笔账划得来。

## 一条留给 ADR-0018 的边界

基准 preset 自带 `subagent` / `subagent_fork` 两个通用委派工具。复制它之后，队长手里会同时有「具名队员」和「匿名子代理」两种选择，而后者拿的是队长自己的全部权限，绕过了队员的白名单。本期不禁用它们，只在队长的开场名册里明说优先用具名队员。是否要硬禁（以保证所有委派都走号牌闸门）属于 ADR-0018 的边界，待定。
