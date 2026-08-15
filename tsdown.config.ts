/**
 * Vela 构建：host half（Node，拥有 Board 状态机与持久化 + HTTP 路由）
 * + client half（浏览器，sidebar 导航项与 shell.overlay 面板）。
 *
 * 配置刻意不含 import——tsdown 支持裸对象导出，避免仓库外的解析问题。
 * 官方包（@deepseek-ai/*）由 profile 的 pnpm 闭包在挂载时注入，一律
 * external，不打包：本地无公共 npm 可解析，且打包会复制 runtime identity。
 */

export default [
  {
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    outDir: 'lib',
    clean: true,
    dts: false,
    external: [/@deepseek-ai\//],
  },
  {
    name: 'dsh-vela/client',
    entry: { client: 'src/client/index.ts' },
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    outDir: 'lib',
    dts: false,
    clean: false,
    // 官方 client 契约：bundle 自我注册到 window.__ModuleLoader__。
    // 必须是 CJS——ESM 输出与顶层 return 不兼容。module/exports 定义放
    // banner（intro 会被折叠内联），footer 返回 exports。
    external: [/@deepseek-ai\/dsh-client-/, 'react', 'react/jsx-runtime'],
    outputOptions: {
      entryFileNames: 'index.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-vela", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
      footer: 'return exports; } });',
    },
  },
]
