---
status: accepted
---

# 直接移植 Multica 的 Board UI 代码

Vela 的 Board UI 从 Multica 的 `packages/views/issues/` 与 `packages/ui/` 移植，而非净室重写。决策依据是当前用途为**本地个人开发**：Multica License 条件 (a) 明文豁免「内部单组织使用」与「公开 fork 源码本身不算 hosted service」，因此商业/托管限制不构成障碍。Operator 承担合规责任。

## 随附义务（无非商业豁免，自今日起生效）

- **条件 (b) 品牌与署名**：移植后的 Board 仍属 "Multica user interface"——许可明确写道 UI 代码 "remains covered when it is modified, moved, renamed, or extracted into another package or repository"。因此 Board 界面**必须保留 Multica 的 logo、产品名与版权署名**，除非取得书面 branding waiver。
- **条件 3.d 再分发**：任何形式的再分发（公开 GitHub 仓库、`dsh plugin add github:...`）都必须**完整交付整个 LICENSE 文件**；单独交付 Apache-2.0 部分不满足要求。同时保留 NOTICE 并声明修改。
- **可追溯性**：每个派生文件应在头部注释标注 Multica 来源路径，使日后替换或合规审查有据可依。

## 触发重做的条件

以下任一发生时，这层 UI 必须重写或取得商业许可：**(1)** Vela 商业化或被嵌入对外分发的产品；**(2)** 对组织外用户提供可访问实例——**即使完全免费、无广告、无付费档**；**(3)** 需要移除 Multica 品牌以自有品牌发布。

## Consequences

技术上并非「拷贝即用」。Multica 的 Board UI 深度依赖 `@tanstack/react-query`、`@multica/core/{api,types,hooks,paths,issues}`、shadcn/ui + Tailwind、`lucide-react`、`sonner`，而 DSH 客户端的平台模块表仅 8 项、且为纯 CSS Modules（`packages/client` 全域无 tailwind/shadcn）。移植需逐文件替换取数层、模型层、组件层与样式体系，可原样保留的主要是 JSX 结构与交互逻辑。

被拒绝的替代方案是净室重写（只取交互设计、代码从零写），其编码量与本方案相当但无任何许可义务；若上述任一触发条件出现，它就是回退路径。
