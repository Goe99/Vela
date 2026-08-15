# 01 — 插件骨架与从零安装验证

**What to build:** 一个 DSH 插件能被装进一个全新的 profile 并在配置树中现身，host 面提供一条只读的 Board 快照接口，此刻返回一个空 Board。这一票不含任何业务逻辑——它的价值是把包契约、配置分层、双面构建与安装这条路一次打通，并留下可重复的验证方式。后面每一票都站在它上面。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 包声明 host 面入口与 `dsh.bundle.patch`；此票为 host-only，**不**声明 `dsh.client`
- [x] `cordis.patch.yml` 是顶层数组、单个 insert 行、行 id 稳定
- [x] host 与 client 分属两个 tsc program（client program 此票内容为空但已就位）
- [x] Board 快照接口经 `ctx.effect` 注册，随 fiber 清理；响应显式设 `Cache-Control: no-store`
- [x] 畸形请求与 handler rejection 转成明确 4xx/5xx，不产生未处理 rejection
- [x] 快照存储路径来自插件配置，**不回落 `process.cwd()`**
- [x] DSH / Cordis 声明为 peer 依赖，避免复制 runtime identity
- [x] `exports`、`files` 与构建产物一致，任何入口都不指向不存在的文件
- [x] 在全新临时 `DSH_HOME` 与 scratch profile 上验证：`dsh plugin add` 成功、profile 的 `dsh.profile.bundles` 出现包名、`--dump-config` 出现插件层且行 id / name / config 正确
- [x] 至少一条测试经真实 Loader/patch 组合启动并断言接口可用，而非只手搓 `ctx.plugin()`
