# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

Vela 是 **single-context** 仓库：一份根 `CONTEXT.md` + 一个 `docs/adr/`。

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── AGENTS.md
├── docs/
│   ├── adr/                 ← 架构决策记录，0001 起顺序编号
│   └── agents/              ← 本目录：skill 的仓库级配置
└── .scratch/                ← issue tracker（spec + issues）
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

Vela 的核心术语是 Operator、Board、Lane、Workspace、Issue、Run、Agent、Gate。注意几个易错点：**Issue 不叫 Task**、**Run 不叫 Task/Job**、**Gate 不叫 Approval**（`user-approval` 是 DSH 自己的另一套机制，见 ADR-0008）、**Run 不是 subagent**（见 ADR-0013）。

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (Agent 有权交付、无权宣布通过) — but worth reopening because…_
