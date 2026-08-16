# 06 — 一支 Squad 落成 DSH 认得的 preset 文件

**What to build:** Vela 能列出、新建、修改、删除 Squad，每支 Squad 真的变成 `<dshHome>/.agent-presets/vela-<slug>/agent.cordis.yml` 这样一份文件——而且 **DSH 自己认得它**：在 DSH 原生的 agent 配置列表里能看到，健康检查通过。

这一票不做界面，只把地基打通并用 DSH 自己的眼睛验证。按 ADR-0016 的形状：一行承载队长的职责说明，每个队员一行。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 能创建一支 Squad：给名字、队长职责说明、零到多个队员（名字 / 职责说明 / 能力勾选 / 执行后端）
- [x] 写出的文件被 DSH 认出来：出现在 DSH 的 agent 配置列表里，且没有 broken 标记（用 DSH 自己的接口验证，不是我们自己解析一遍）
- [x] Squad 的 id 一律带 `vela-` 前缀，且拒绝与 DSH 内置名冲突的名字
- [x] 能读回一支已存在的 Squad 并还原成结构化数据（队长职责、队员清单），改完再写回不丢信息
- [x] 队员的能力勾选映射到一份**硬编码**的工具名清单，映射关系被测试锁住（按 ADR-0017：填错工具名会让整个 Squad 起不来）
- [x] 能删除 Squad，且只删得掉 Vela 自己创建的那些
- [x] 队长的职责说明里自动追加队员名册（谁、擅长什么），因为 DSH 生成的队员工具说明文字一模一样，队长光看名字分不出谁是谁
- [x] Squad 的默认沙箱档位存在 Vela 自己的存档里，不在 preset 文件里（ADR-0016 里说明了为什么真相分两处）
- [x] 写坏一份 YAML 不会让 Board 崩掉
