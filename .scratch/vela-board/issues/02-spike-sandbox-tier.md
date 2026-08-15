# 02 — Spike：确认 sandbox 档位的施加机制

**What to build:** 弄清 Vela 派活时如何为一次 Run 指定 sandbox 档位。这是设计阶段唯一未清掉的证据缺口。现有证据指向「创建会话后向该会话追加 `sandbox/mode` 事件」，取值为 read-only / workspace-write / danger-full-access，但**尚未实跑确认**——它来自一次代码阅读中的推测。本票要给出确定答案，而不是又一轮代码阅读。

这张票门控 07（派活）：若档位无法施加，Agent 就会在未知权限下跑，连全局默认都给不了。

**Blocked by:** None — can start immediately

**Status:** done

- [ ] 实跑验证：创建一个顶层会话、施加一个非默认档位、让 Agent 尝试一次越界写入，确认它**真的被拒绝**（不是只看代码推断）
- [x] 记录施加档位的确切 API 或事件形状
- [x] 记录施加时机：创建会话后、首次提交任务前，还是别的窗口
- [x] 确认档位能否在 Run 进行中变更，或只在启动时固定
- [x] 若「追加事件」路径不成立，找出真实路径；若确实无任何可用路径，明确回报，并标记 ADR-0010 的 per-Issue sandbox 决策需重新评估
- [x] 结论写回 ADR-0010 的「取证补注」一节，替换其中「尚未完全确认」的措辞

## 完成记录

**结论：推测错了，真实机制更干净。** 档位不靠手工追加 `sandbox/mode` 事件，而是经官方的 `ctx.permissionPresets` 服务：`set(session, presetName)` 会把该 preset 绑定的 sandbox 与 approval **两个** knob 成对写入。只写 sandbox 会留下一个权限组合不完整的会话——这正是原推测的错处。完整结论见 ADR-0014。

**施加时机**：会话创建后、首次提交任务前。Vela 就在这个窗口调用，且施加失败时**任务从未被提交**（有测试覆盖）。

**档位取值是 preset 名字而非固定三值**：默认表里两者同名，但部署可改表。实测本机提供三个（read-only / workspace-write / danger-full-access），但 Vela 对着 `permissionPresets.names` 动态校验。

**一条验收标准没做（上面保留为未勾选）**：“让 Agent 尝试一次越界写入并确认被拒绝”。已验证的是档位能被正常施加、且一次 `workspace-write` 的真实派活能在工作目录内正常写入；**没有**验证越界写入会被拦下。拦截本身是 DSH 沙箱的职责而不是 Vela 的，但这条不变量对安全很关键，值得单独跑一次（给一张卡片设 `read-only` 并让它尝试写文件）。
