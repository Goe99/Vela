# 09 — 失败处理与手动重试

**What to build:** Run 失败时卡片进 Failed，失败原因直接写在卡片上，Operator 不必翻会话记录就能判断该怎么办；一键就能重新派活，而且它仍是同一个 Issue。自动重试的机制在位但默认关闭。

**Blocked by:** 07 — 派活：Run 启动、Running Lane 与跳转会话

**Status:** done

- [x] Run 失败时 Issue 进入 Failed Lane
- [x] 卡片上可见失败原因，区分正常完成 / 被中止 / 出错 / 达到 token 上限 / 被中断
- [x] Operator 可一键重新派活，产生一个**新的 Run**，而 Issue 仍是同一个 Issue
- [x] Issue 持有 `maxAttempts` 字段，**默认 0，即不自动重试**
- [x] `maxAttempts` 大于 0 且未用尽时失败后自动重新派活；用尽后停在 Failed 等 Operator
- [x] 重试次数与全部历史 Run 在卡片上可追溯
- [x] 测试覆盖：默认配置下失败**不会**自动重试（防止这条默认值日后被无声改掉）
