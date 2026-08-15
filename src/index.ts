/**
 * Vela host half。拥有 Board 状态机与持久化，经宿主 webServer 暴露一条 prefix
 * 路由，并拥有派活执行器。**不注册任何工具**（ADR-0012：Agent 不能写
 * Board），这把运行面缩到最小。
 *
 * client half 经 package.json 的 dsh.client 声明被发现，不在这里引用。
 */

import { handleApi, API_PREFIX } from './http/routes.ts'
import type { ApiDeps, ApiRequest, ApiResponse } from './http/routes.ts'
import { BoardStore } from './domain/store.ts'
import { Runner, observeSessions } from './runner.ts'
import type { ExecDefaults } from './domain/exec.ts'
import type { HttpRequest, HttpResponse, VelaContext } from './dsh.ts'

/** Cordis 插件名。 */
export const name = 'vela'

/**
 * 需要宿主 web server（web 组合提供）。
 *
 * `apiProxy` 与 `permissionPresets` 刻意不列为必需：看看看板、建卡、排序在
 * 没有它们时仍然成立，而一个 pending fiber 对 Operator 是完全隐形的（路由不
 * 挂、UI 不现身）。改为惰性取服务，派活时才报一条能读的错。
 */
export const inject = ['webServer']

/** 插件配置。 */
export interface Config {
  /** Board 快照文件的绝对路径。无默认值——见 cordis.patch.yml 与 ADR-0006。 */
  boardPath: string
  /**
   * 派活的全局默认值（ADR-0010）。单张卡片可以覆盖它们；任何部署可能需要
   * 调整的值都属于这里而不是源码常量。
   */
  exec?: ExecDefaults
}

/** 请求体上限：Board 的写入都是小 JSON，1MB 足够且能挡住失控的 body。 */
const MAX_BODY_BYTES = 1024 * 1024

/** 读取并 JSON 解析请求体；空体给 undefined，超限或非法 JSON 抛错。 */
async function readJsonBody(req: HttpRequest): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

/** 把一次 ApiResponse 写回 node 响应，快照接口一律 no-store。 */
function send(res: HttpResponse, response: ApiResponse): void {
  res.statusCode = response.status
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(response.body))
}

/** 应用插件。 */
export function apply(ctx: VelaContext, config: Config): void {
  ctx.effect(() => {
    // store 的打开是异步的，但 effect setup 必须同步返回 disposer。用一个
    // pending promise 承接：路由在 store 就绪前进来就等它。
    let disposed = false
    let runner: Runner | undefined
    const timers = new Set<ReturnType<typeof setTimeout>>()

    const ready = BoardStore.open(config.boardPath).then(async (store) => {
      if (disposed) return undefined
      const created = new Runner({
        store,
        now: () => Date.now(),
        newId: () => newId('run'),
        defaults: config.exec ?? {},
        apiProxy: () => ctx.get('apiProxy'),
        permissionPresets: () => ctx.get('permissionPresets'),
        sessions: () => ctx.get('sessions'),
        setTimer: (fn, ms) => {
          const handle = setTimeout(() => { timers.delete(handle); fn() }, ms)
          timers.add(handle)
          return handle
        },
        clearTimer: (handle) => {
          clearTimeout(handle as ReturnType<typeof setTimeout>)
          timers.delete(handle as ReturnType<typeof setTimeout>)
        },
        ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
      })
      runner = created
      // 上次进程被杀时停在 running 的 Run 不会自己结束；没有这一步那些卡片
      // 会永远停在 Running。
      await created.reconcile().catch((error: unknown) => {
        ctx.logger?.warn(`[vela] reconcile failed: ${describe(error)}`)
      })
      return { store, runner: created }
    }).catch((error: unknown) => {
      ctx.logger?.warn(`[vela] cannot open board at ${config.boardPath}: ${describe(error)}`)
      return undefined
    })

    const webServer = ctx.webServer
    if (webServer === undefined) {
      ctx.logger?.warn('[vela] no webServer available; Board API not mounted')
      return () => { disposed = true }
    }

    // 宿主的全局会话事件流：执行器据此累计用量并在 turn/end 时结算。与 Vela
    // 无关的会话在执行器里被原样忽略。
    const disposeEvents = observeSessions(
      listener => ctx.on('session/event', listener),
      { observe: (sessionId, event) => runner?.observe(sessionId, event) },
    )

    const disposeRoute = webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req: HttpRequest, res: HttpResponse) => {
        const context = await ready
        if (context === undefined || disposed) {
          send(res, { status: 503, body: { ok: false, code: 'unavailable', message: 'board store is not ready' } })
          return
        }
        const url = new URL(req.url ?? '/', 'http://x')
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          send(res, { status: 400, body: { ok: false, code: 'invalid', message: 'malformed request body' } })
          return
        }
        const request: ApiRequest = {
          method: req.method ?? 'GET',
          path: url.pathname,
          ...(body === undefined ? {} : { body }),
        }
        const deps: ApiDeps = {
          now: () => Date.now(),
          newId: () => newId('iss'),
          sandboxPresets: () => ctx.get('permissionPresets')?.names ?? [],
          // 未挂载 apiProxy 时不暴露派活能力，好让 UI 直接隐去按钮而不是给出
          // 一个点了就报错的入口。
          ...(ctx.get('apiProxy') === undefined ? {} : { dispatcher: context.runner }),
        }
        const response = await handleApi(context.store, deps, request)
        send(res, response)
      },
    })

    return () => {
      disposed = true
      disposeRoute()
      disposeEvents()
      runner?.dispose()
      for (const handle of timers) clearTimeout(handle)
      timers.clear()
    }
  }, 'vela: board API route + run dispatcher')
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
