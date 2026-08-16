---
status: accepted
---

# Vela 是单操作者驾驶舱，不做多用户团队协作

Multica 的价值主张之一是「团队协作与权限：工作区隔离、角色与访问范围控制」，它预设了一个带身份体系的多用户服务端。DSH 与此架构性冲突：全库不存在任何 auth / user / tenant 概念，Web server 默认只绑 `127.0.0.1:3080`，且 CLI 明确拒绝 `--host 0.0.0.0`，理由是「would expose remote code execution to the network」。因此 Vela v1 放弃多用户协作，把产品定义为**单个 Operator 指挥 N 个 Agent 的驾驶舱**。

「最小权限原则」这一实质内核并未丢失，只是主体从「团队成员」换成了「Agent」——由 DSH 现成的 sandbox 三档（read-only / workspace-write / danger-full-access）、landlock/seatbelt/bwrap 原生 runner 与审批机制承担。

## Considered Options

- **给 DSH Web 加认证并对外暴露端口** — 拒绝。为了一个看板把 RCE 面暴露到网络，且与框架显式的安全立场对抗。
- **团队协作放到 DSH 之外的独立服务** — 未拒绝，只是推迟。若日后确实需要多人，正确形态是 DSH 插件继续做个人驾驶舱，另起一个服务承载协作，而不是把多用户塞进插件。

## Consequences

Issue 上不设 assignee-to-human、角色、访问范围等字段；「派活」的对象只可能是 Agent。任何以「多人」为前提的功能请求都应先回到这份 ADR 重新评估边界。

## 后续：Squad 不是对本 ADR 的让步

第二期引入的 **Squad（小队）/ Member（队员）/ 权限**看上去像是把 Multica 的团队协作拾了回来，实际上正是本 ADR 第 9 行那句话的归局：主体从「团队成员」换成了「Agent」。

Squad 里没有人。Member 是一个 **agent 位置**，不是账号；「权限」指的是沙箱档位与工具白名单，不是访问控制。本 ADR 的结论完全成立，且因为有了真正的多 Agent 限权而变得更硬。详见 ADR-0016（Squad 的形态）与 ADR-0017（Member 的两层闸门）。
