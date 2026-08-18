/**
 * Vela host half。拥有 Board 状态机与持久化，经宿主 webServer 暴露一条 prefix
 * 路由，并拥有派活执行器。**不注册任何工具**（ADR-0012：Agent 不能写
 * Board），这把运行面缩到最小。
 *
 * client half 经 package.json 的 dsh.client 声明被发现，不在这里引用。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { handleApi, API_PREFIX } from './http/routes.ts'
import type { ApiDeps, ApiRequest, ApiResponse } from './http/routes.ts'
import { BoardStore } from './domain/store.ts'
import { SquadStore } from './domain/squad-store.ts'
import { SlotPool } from './domain/slots.ts'
import { TimelineRecorder } from './domain/timeline.ts'
import { SQUAD_ID_PREFIX } from './domain/squad.ts'
import { VELA_PROVIDER_PREFIX, installSlottedProviders } from './squad-provider.ts'
import type { SubagentsServiceLike } from './squad-provider.ts'
import { Runner, observeSessions } from './runner.ts'
import { MemoryStore } from './memory.ts'
import { ModelCatalog } from './model-catalog.ts'
import { SkillCatalog } from './skills.ts'
import type { ExecDefaults } from './domain/exec.ts'
import type { DocumentTarget } from './domain/nav.ts'
import type { HttpRequest, HttpResponse, LlmServiceLike, VelaContext } from './dsh.ts'

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
  /**
   * 记忆库目录的绝对路径（ADR-0022）。
   *
   * **缺省时记忆功能整体不启用**：不建目录、不写文件，派活文本也与从前
   * 一字不差。一个会自己建目录、自己往里写文件的功能，必须由 Operator 明确开启。
   * 与 `boardPath` 同款：不回落 `process.cwd()`，也不去猜 DSH 的家目录。
   */
  memoryPath?: string
  /**
   * 同时在跑的 Run 上限（ADR-0018）。跑满时派活被**拒绝**并告知原因，
   * 而不是排队——排队会造出一个 Board 上看不见的第七种状态。
   *
   * 默认 3：三路同时烧已经能把一台开发机的注意力吃满，再多 Operator 也
   * 看不过来。设 0 = 全面暂停派活（看板仍完全可用）。
   */
  maxConcurrentRuns?: number
  /**
   * 小队落成 DSH agent preset 目录的根（ADR-0016）。指向 DSH 默认的可写
   * preset 根时，DSH 原生的会话入口也能直接选到小队。
   *
   * 缺省时小队功能**整体不现身**，而不是给一个点了就报错的入口——与
   * apiProxy 缺失时隐去派活按钮同一套做法。
   */
  squadRoot?: string
  /**
   * 技能广场扫的 DSH 技能根。默认 `<dshHome>/skills`——由 cordis.patch.yml
   * 用 `dshHomePath` 注入，而不是在这里猜 `~/.dsh`：部署把 dshHome 挪到别处
   * 时注入值仍然是对的。缺省时的回落（DSH_HOME 环境变量、再退 `~/.dsh`）
   * 与 DSH 自己的解析规则一致。
   */
  skillsDshRoot?: string
  /**
   * 小队组合所基于的基准 preset（ADR-0016）。
   *
   * 一份 preset 是 agent 平面的**完整**组合，不是补丁：小队的组合文件必须以
   * 这份基准的全文开头，否则队长手里连 `read` 都没有。
   *
   * 默认 `standard`（出厂的完整编码 agent）。换成其他基准可能需要重新校准
   * 能力→工具名的映射表，因为白名单里只能出现基准真的注册了的工具名。
   */
  squadBaseline?: string
  /**
   * 一张号牌最长可以被持有多久（毫秒），超过就强制回收（ADR-0018）。
   *
   * 这不是给队员的执行超时——那是 DSH 的事。这是**对账**：漏还一张号牌会永久
   * 缩小那支队的并发能力，症状是「越用越慢」且没有任何报错指向原因。
   *
   * 默认两小时：比任何正常的队员任务都长得多，因此不会误伤真在干活的队员。
   * 设 0 关掉对账。
   */
  slotMaxHoldMs?: number
}

/** 并发上限的默认值。 */
const DEFAULT_MAX_CONCURRENT_RUNS = 3

/** 小队组合默认基于的 preset。 */
const DEFAULT_SQUAD_BASELINE = 'standard'

/** 号牌对账的默认阈值：两小时。 */
const DEFAULT_SLOT_MAX_HOLD_MS = 2 * 60 * 60 * 1000

/**
 * 把号牌层挂到 DSH 的子代理注册表上（ADR-0018）。
 *
 * 返回是否真的挂上了——这个答案直接决定队员行里写哪个 provider 名。
 *
 * `subagents` 服务不在时**不报错只记一句**：那意味着这个部署根本没装子代理
 * 能力，小队依旧能建只是没有闸门，看板其余部分照常。
 */
function installSlots(
  ctx: VelaContext,
  slots: SlotPool,
  squads: SquadStore,
  timeline: TimelineRecorder,
): boolean {
  const subagents = ctx.get('subagents')
  if (subagents === undefined) {
    ctx.logger?.warn('[vela] 没有 subagents 服务，小队的队员并发不设闸门')
    return false
  }
  // 这一次 cast 是诚实的：dsh.ts 只说「有这个服务」，具体形状是 Vela 对它的
  // 建模，住在 provider 层。形状对不上的后果是号牌层挂不上（下面那个 try
  // 会记下来），而不是看板崩掉。
  const dispose = installSlottedProviders(subagents as SubagentsServiceLike, {
    slots,
    // 时间轴的记录与号牌同处挂载，那就满足了 ADR-0019 的「订阅必须在进程
    // 启动时就装好」：两者都在 store 就绪后立即装上，比任何一次派活都早。
    timeline,
    now: () => Date.now(),
    quotaFor: async (parentCtx) => {
      // 反查「发起这次派生的 agent 属于哪份 preset」。读的是它**活的**作用域链
      // 而不是会话头：一个中途换过 preset 的会话，它的头里还写着旧名字。
      const presets = ctx.get('agentPresets')
      const id = presets?.composedPreset?.(parentCtx)
      // 不是一支 Vela 小队（Operator 可能手改过某份 preset）就不设闸门。
      if (typeof id !== 'string' || !id.startsWith(SQUAD_ID_PREFIX)) return undefined
      const squad = await squads.read(id)
      if (!squad.ok) return undefined
      return {
        key: id,
        limit: squad.value.maxParallelMembers,
        members: squad.value.members,
      }
    },
    ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
  })
  ctx.effect(() => dispose)
  return true
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
    // 号牌层到底挂上了没有。它决定队员行里写哪个 provider 名，而那个判断必须
    // 在每次写小队时重新取（挂载发生得比这里晚）。
    let slotted = false
    const timers = new Set<ReturnType<typeof setTimeout>>()
    // 小队并行时间轴的记录（ADR-0019）。存内存而不落盘：它是一次观察的产物，
    // 而 ADR-0019 已经承认漏掉的起跑事件无法追补——把一份残缺的观察持久化
    // 下来只会让人以为它是完整的。
    const timeline = new TimelineRecorder()

    // 模型清单：队员的「模型」字段是下拉而不是手输，清单来自宿主的 llm 服务。
    // listModels 是异步的而看板视图是同步拼的，所以清单在后台定时刷进缓存，
    // 接口永远只读缓存（见 ModelCatalog）。宿主没有这个服务就不装，前端退化为手输。
    const llm = ctx.get('llm')
    let modelCatalog: ModelCatalog | undefined
    if (llm !== undefined) {
      modelCatalog = new ModelCatalog(llm, message => ctx.logger?.warn(message))
      void modelCatalog.refresh()
      const timer = setInterval(() => { void modelCatalog?.refresh() }, 5 * 60_000)
      timers.add(timer)
    }

    // 记忆库：没配路径就根本不建这个对象，于是整条落盘路径一行也不跑（ADR-0022）。
    // 路径不合法时只记一句并关掉记忆功能，而不是让整个插件起不来——看看看板、
    // 建卡、派活在没有记忆时仍然完全成立。
    let memory: MemoryStore | undefined
    if (config.memoryPath !== undefined) {
      try {
        memory = MemoryStore.open(config.memoryPath)
      } catch (error) {
        ctx.logger?.warn(`[vela] 记忆库没启用：${describe(error)}`)
      }
    }

    // 号牌池：每支队同时在跑的队员数的硬上限（ADR-0018）。建在这里而不是
    // squads 里面：它要给 provider 层用，而那一层与看板持久化无关。
    const slots = new SlotPool({
      setTimer: (fn, ms) => {
        const handle = setTimeout(() => { timers.delete(handle); fn() }, ms)
        timers.add(handle)
        return handle
      },
      clearTimer: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
        timers.delete(handle as ReturnType<typeof setTimeout>)
      },
      maxHoldMs: config.slotMaxHoldMs ?? DEFAULT_SLOT_MAX_HOLD_MS,
      ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
    })

    // 技能广场：扫 DSH 的技能目录。根的位置与 DSH 自己的解析规则对齐
    // （dsh-skill-filesystem 的 resolveDshHome / DSH_AGENTS_HOME / DSH_BUNDLED_SKILL_DIR），
    // 优先级从高到低排——靠前的来源盖住同名技能（DSH 的 rank 规则：dsh < agents < bundled，
    // 数值小者胜）。
    const home = homedir()
    const dshHome = process.env.DSH_HOME ?? join(home, '.dsh')
    const agentsHome = process.env.DSH_AGENTS_HOME ?? join(home, '.agents')
    const skillsCatalog = new SkillCatalog([
      { path: config.skillsDshRoot ?? join(dshHome, 'skills'), source: 'dsh' },
      { path: join(agentsHome, 'skills'), source: 'agents' },
      ...(process.env.DSH_BUNDLED_SKILL_DIR === undefined
        ? []
        : [{ path: process.env.DSH_BUNDLED_SKILL_DIR, source: 'bundled' as const }]),
    ])

    const ready = BoardStore.open(config.boardPath).then(async (store) => {
      if (disposed) return undefined
      // 小队目录不预先创建：第一支小队落盘时自然会建。一个空目录对 DSH
      // 的 preset 扫盘是噪声。
      const squads = config.squadRoot === undefined
        ? undefined
        : new SquadStore(
          config.squadRoot,
          process.platform,
          async () => {
            // 每次写小队都重新问一次基准。服务可能在 Vela 之后才挂载，所以
            // 不能在这里把它捕获成一个常量。
            const presets = ctx.get('agentPresets')
            if (presets === undefined) {
              throw new Error('agentPresets 服务没挂载，拿不到基准 preset')
            }
            return presets.read(config.squadBaseline ?? DEFAULT_SQUAD_BASELINE)
          },
          // 号牌层真的挂上了，队员行才填我们的后端名。挂不上时写原生名：没有
          // 闸门好于一支每次委派都报「unknown provider」的队。
          () => (slotted ? { providerFor: backend => `${VELA_PROVIDER_PREFIX}${backend}` } : {}),
        )
      const created = new Runner({
        store,
        now: () => Date.now(),
        newId: () => newId('run'),
        defaults: config.exec ?? {},
        maxConcurrentRuns: () => config.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
        apiProxy: () => ctx.get('apiProxy'),
        permissionPresets: () => ctx.get('permissionPresets'),
        sessions: () => ctx.get('sessions'),
        squads: () => squads,
        slots: () => slots,
        memory: () => memory,
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
      // 号牌层在 store 就绪后才挂：配额反查要读小队，而那需要 squads。
      if (squads !== undefined) slotted = installSlots(ctx, slots, squads, timeline)
      // 上次进程被杀时停在 running 的 Run 不会自己结束；没有这一步那些卡片
      // 会永远停在 Running。
      await created.reconcile().catch((error: unknown) => {
        ctx.logger?.warn(`[vela] reconcile failed: ${describe(error)}`)
      })
      // 记忆侧的对账（ADR-0025）：上次验收时改了快照却没写成文件的，在这里补上。
      // 待补的事实不需要新字段：「卡在 Done 且那篇仍是草稿」本身就是信号。
      if (memory !== undefined) {
        const pending = store.snapshot().issues
          .filter(issue => issue.lane === 'done' && issue.runs.length > 0)
          .map(issue => ({
            workspace: issue.workspace,
            issueNumber: issue.number,
            runSeq: issue.runs.length,
          }))
        await memory.backfillVerified(pending, Date.now()).then((repaired) => {
          if (repaired > 0) ctx.logger?.info(`[vela] 补写了 ${repaired} 篇复盘的人审记录`)
        }).catch((error: unknown) => {
          ctx.logger?.warn(`[vela] 记忆对账失败：${describe(error)}`)
        })
      }
      return { store, runner: created, squads }
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
          // 平台是部署的运行时事实，浏览器自己看不到（那里没有 process）。
          platform: () => process.platform,
          // 未挂载 apiProxy 时不暴露派活能力，好让 UI 直接隐去按钮而不是给出
          // 一个点了就报错的入口。
          ...(ctx.get('apiProxy') === undefined ? {} : { dispatcher: context.runner }),
          ...(context.squads === undefined ? {} : { squads: context.squads }),
          timeline,
          skills: skillsCatalog,
          ...(modelCatalog === undefined ? {} : { modelCatalog: () => modelCatalog.options }),
          ...(ctx.get('apiProxy') === undefined ? {} : { documents: openDocuments(ctx) }),
          ...(memory === undefined ? {} : { memory }),
          ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
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

/**
 * 把导航里的「打开配置文件」接到 DSH 自己的 openDocument 上（ADR-0020）。
 *
 * 宿主没提供对应的面时返回 `opened: false` 而不报错——这与“宿主有这个面但
 * 当前环境打不开”对 Operator 而言是同一回事：都是“没帮你打开”，而不是“出错了”。
 */
function openDocuments(ctx: VelaContext): {
  open(target: DocumentTarget): Promise<{ opened: boolean; path?: string }>
} {
  return {
    open: async (target) => {
      const api = ctx.get('apiProxy')
      const rpcId = newId('doc')
      if (target === 'agent-presets') {
        const presets = api?.agentPresets
        if (presets === undefined) return { opened: false }
        const response = await presets.openDocument({ rpcId, payload: {} })
        return response.result.ok ? response.result.value : { opened: false }
      }
      const settings = api?.settings
      if (settings === undefined) return { opened: false }
      const response = await settings.openDocument({ rpcId, payload: {} })
      return response.result.ok ? response.result.value : { opened: false }
    },
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
