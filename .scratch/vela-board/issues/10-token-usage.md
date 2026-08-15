# 10 — Token 用量展示

**What to build:** Operator 能看到每次 Run 烧了多少 token，以及一个 Issue 累计烧了多少，从而判断把活交给 Agent 到底值不值。进行中的 Run 显示实时进度，好让明显失控的执行能被及时叫停。

**Blocked by:** 07 — 派活：Run 启动、Running Lane 与跳转会话

**Status:** done

- [x] Run 到达终态时从其会话聚合一次用量并写入 Run 记录，此后**不再改写**
- [x] 聚合覆盖 uncached input、output、cache read、cache write、reasoning 五类计数，并正确处理它们互斥（计费输入是三者之和）
- [x] 卡片显示单次 Run 用量与该 Issue 的累计用量
- [x] 进行中的 Run 显示实时用量，该实时计数**不落盘**
- [x] Run 异常终止导致用量缺失时显示为「未知」，既不显示 0 也不回退到实时计数
- [x] Board 渲染时**不**回溯会话日志——几十张卡片不应触发几十次日志读取
- [x] 聚合逻辑是纯函数并被单独测试：给定一个事件序列产出确定的用量总计，缺失 usage 的事件被跳过而非计为 0
