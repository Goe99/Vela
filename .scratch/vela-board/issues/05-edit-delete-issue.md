# 05 — 编辑与删除 Issue

**What to build:** Operator 能修改已建 Issue 的内容，也能把它删掉。04 让 Issue 能诞生并存活，这一票让它能被修正与淘汰。

**Blocked by:** 04 — 创建 Issue 并在 Board 上展示

**Status:** done

- [x] 可修改已有 Issue 的标题、描述、Workspace 与优先级
- [x] 可删除 Issue，删除后不再出现在 Board 上
- [x] 编辑与删除同样经原子发布落盘，重启后生效
- [x] 删除一个持有 Run 的 Issue 时行为明确（连带删除 Run 记录还是拒绝删除），该行为在测试中被固定下来
- [x] 删除**不**触及 Run 对应的 DSH 会话——会话是 DSH 的资产，不是 Vela 的
- [x] 对不存在的 Issue 做编辑或删除返回明确的 4xx
