# 02 — Spike：确认 sandbox 档位的施加机制

**What to build:** 弄清 Vela 派活时如何为一次 Run 指定 sandbox 档位。这是设计阶段唯一未清掉的证据缺口。现有证据指向「创建会话后向该会话追加 `sandbox/mode` 事件」，取值为 read-only / workspace-write / danger-full-access，但**尚未实跑确认**——它来自一次代码阅读中的推测。本票要给出确定答案，而不是又一轮代码阅读。

这张票门控 07（派活）：若档位无法施加，Agent 就会在未知权限下跑，连全局默认都给不了。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 实跑验证：创建一个顶层会话、施加一个非默认档位、让 Agent 尝试一次越界写入，确认它**真的被拒绝**（不是只看代码推断）
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

## 补：越界写入真的被拒绝了

第一轮留下的那条验收现在有真跑证据。一张卡把档位设成 `read-only`，任务是
「在工作目录下创建一个文件」。

**完整证据链**（554 个会话事件）：

```text
seq 1  sandbox/mode        workspace-write     ← 会话默认
seq 3  permission/preset   read-only           ← Vela 施加
seq 4  sandbox/mode        read-only           ← 成对联动生效
…
tool/call    write   {"file_path": "…/sandbox-denial-….txt", "content": "hello\n"}
tool/result  FsError / FS_SANDBOX_DENIED
             Error: [sandbox: file access denied under read-only mode]
```

文件系统里那个文件**不存在**。

三件事同时成立才算这条通过，缺一件都不算：Agent 真的**尝试**了（有 `tool/call`）、
权限层真的**拒绝**了（`FS_SANDBOX_DENIED`）、文件真的**没有**被写出来。只看最后一条
是不够的——Agent 也可能自己决定不写，那种情况下沙箱压根没被考验。

seq 3 → seq 4 那两行还顺带印证了 ADR-0014 的结论：`permissionPresets.set()` 把
sandbox 与 approval 两个旋钮**成对**写入，不是只改一个。

### 判定脚本自己错了两轮，都是同一类错

第一轮报「Agent 一次工具都没调」，听起来像结论，其实是**零样本**：我把响应形状读错了
（结果包在 `result.value` 里，我读的是 `payload`），拿到 0 个事件，于是任何否定判断
都必然为真。第二轮之前还猜错过两个字段名（卡在 `board.issues` 里不在顶层；执行配置
字段叫 `exec` 不叫 `execConfig`），导致等待循环第一圈就跳出，报出一个空的「跑完了」。

修法是给结论**带上样本数**，并把「零样本」单列成一种结局，措辞是「没验到」而不是
「没有发生」。脚本留在 `.dsh-scratch/verify-sandbox-denial.mjs`。
