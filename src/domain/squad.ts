/**
 * Squad（小队）的领域层：形状、校验，以及与 DSH preset 目录的双向转换。
 *
 * 一支 Squad 就是一份 DSH agent preset 目录（ADR-0016）：
 *
 * ```text
 * <dshHome>/.agent-presets/vela-<slug>/
 *   agent.cordis.yml   ← 基准 preset 的全文 + 每个队员追加一行委派工具
 *   preset.yml         ← 显示名与描述，DSH 的选择器会读
 *   vela.json          ← Vela 自己的策略：沙箱档位、号牌数量、队长职责
 * ```
 *
 * ## 组合文件是「基准全文 + 追加」，不是从零写
 *
 * 一份 preset 是一个 agent 平面的**完整**组合，不是一份补丁：preset 里没写的行
 * 不会从别处继承。一次真实派活证实了这一点的代价——只写「队长人格 + 队员行」的
 * preset 会**取代**基准，于是队长手里连 `read` 都没有，队员白名单里的工具名也
 * 因此全都解不开（dsh 原话：`tools.restrict() names unknown global tools …;
 * known global tools: <只剩队员>`）。
 *
 * 所以组合文件 = 基准 preset 的**原文**，后面追加每个队员一行。追加是纯文本
 * 操作，这很关键：基准文件带注释和 `!!js` 自定义标签，拿 JSON 解析不了，而
 * 「在一个 YAML 顶层序列后面再追加一项」根本不需要理解前面的内容。
 *
 * ## 为什么追加的那几行写成 JSON
 *
 * JSON 是 YAML 的子集，`- {"id": …}` 是一个合法的 YAML 序列项（flow 映射）。
 * 这条不是推理，是拿 dsh 实际使用的那个 schema 实测过的（含中文与内嵌换行）。
 * 好处是 Vela 不必引入 YAML 依赖，也不必自己拼引号和缩进——队员的职责说明是
 * 自由文本，手拼 YAML 字符串是一类必然出错的活。
 *
 * 这一层**不碰文件系统**，好让全部转换与校验都能在内存里测。
 */

/** 队员的执行后端。只有进程内这两个支持自己的职责说明与工具白名单。 */
export type MemberBackend = 'spawn' | 'fork'

/** 全部可选后端。 */
export const MEMBER_BACKENDS: readonly MemberBackend[] = ['spawn', 'fork']

/** 粗粒度能力组。Operator 勾这个，而不是手打工具名。 */
export type Ability = 'read' | 'edit' | 'shell' | 'web' | 'delegate'

/** 全部能力组，按展示顺序。 */
export const ABILITIES: readonly Ability[] = ['read', 'edit', 'shell', 'web', 'delegate']

/** 能力组的中文标签。 */
export const ABILITY_LABELS: Readonly<Record<Ability, string>> = {
  read: '读文件',
  edit: '改文件',
  shell: '跑命令',
  web: '联网',
  delegate: '再派下一级',
}

/**
 * 能力组 → 真实的模型可见工具名。
 *
 * 这张表**必须准确，而且准确的判据是「基准 preset 实际注册了什么」**，不是
 * 「dsh 源码里存在什么」。白名单里出现一个基准没注册的名字，会让委派在
 * `tools.restrict()` 上 fail loud——症状是每次派活都失败，而卡片看起来还是
 * 跑完了（ADR-0017）。
 *
 * 两个已经踩到的坑，留在这里当路标：
 *
 * - **`web_fetch` 不在表里**，尽管 dsh 确实有这个工具。出厂 `standard` 给
 *   `tool-web` 配的是 `fetch: false`，那一行只注册 `web_search`。
 * - **`shell` 按平台分叉**：出厂组合在 Windows 上装 `pwsh`、其余平台装
 *   `bash`，另一个被 `disabled` 掉，所以两个都列会错一半。
 *
 * 换掉基准 preset 就可能需要重新校准这张表。校准手法见 ADR-0017：让一个队员
 * 的白名单里带一个不存在的名字，dsh 报错时会把它认得的全部工具名列出来。
 *
 * `platform` 是**必传参数**而不是读 `process.platform`：这一层也跑在浏览器里
 * （小队编辑器要展示展开后的真实白名单），而浏览器里没有 `process`。平台是
 * 部署的运行时事实，由宿主告知前端。
 */
export function toolsForAbility(ability: Ability, platform: string): readonly string[] {
  switch (ability) {
    case 'read':
      return ['read', 'glob', 'grep']
    case 'edit':
      return ['write', 'edit']
    case 'shell':
      return platform === 'win32' ? ['pwsh'] : ['bash']
    case 'web':
      return ['web_search']
    case 'delegate':
      return ['subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent']
  }
}

/** 一个队员：小队里的一个 agent 位置。 */
export interface SquadMember {
  /**
   * 模型可见的工具名，也就是队长眼里这个队员叫什么。必须是合法标识符，
   * 且不能撞 DSH 自带的 `subagent` / `subagent_fork`。
   */
  readonly name: string
  /** 这个队员的常驻职责说明，作为它的系统设定生效。 */
  readonly instruction: string
  /** 勾选的能力组。 */
  readonly abilities: readonly Ability[]
  /** 高级逃生口：直接追加工具名。填错会让整支队起不来，所以不是默认路径。 */
  readonly extraTools?: readonly string[]
  readonly backend: MemberBackend
  /**
   * 这个队员用的模型，可选。留空 = 沿用队长当前的路由。
   *
   * 两种写法：纯模型名（`deepseek-reasoner`，provider 沿用队长），或
   * `provider/model` 显式换路由。参考 dsh-agent-teams 的 per-member 路由——
   * 但 reasoningEffort 做不了：它不在子代理的 agentOptions 里（那是会话级
   * 配置，得从 request 瀑布注入，一次性队员没有那个挂载点）。
   */
  readonly model?: string
}

/**
 * 把队员的 model 字段解成子代理的 agentOptions。
 *
 * `provider/model` 拆成两个字段；纯模型名只设 model（provider 由 DSH 从父级
 * 继承，见 subagent 的 resolveChildAgentOptions：父级打底、请求级覆盖）。
 * 返回 undefined 表示沿用队长——行里就不写 agentOptions，一个字都不多写。
 */
export function memberAgentOptions(member: SquadMember): { provider?: string; model?: string } | undefined {
  const raw = member.model?.trim() ?? ''
  if (raw.length === 0) return undefined
  const slash = raw.indexOf('/')
  if (slash < 0) return { model: raw }
  const provider = raw.slice(0, slash).trim()
  const model = raw.slice(slash + 1).trim()
  if (provider.length === 0 || model.length === 0) return undefined
  return { provider, model }
}

/** 一支小队。 */
export interface Squad {
  /** 目录名，一律以 `vela-` 开头。 */
  readonly id: string
  /** 显示名。 */
  readonly title: string
  /** 队长的常驻职责说明。队员名册由 Vela 自动追加，不写在这里。 */
  readonly instruction: string
  readonly members: readonly SquadMember[]
  /** 整支队的权限档位；缺省表示沿用全局默认。 */
  readonly sandbox?: string
  /** 号牌数量：同时最多几个队员在跑（ADR-0018）。 */
  readonly maxParallelMembers: number
}

/** Squad 目录名的前缀。既避开与内置 preset 撞名，也让 DSH 的列表里一眼可辨。 */
export const SQUAD_ID_PREFIX = 'vela-'

/** 组合文件名（DSH 读）。 */
export const COMPOSITION_FILE = 'agent.cordis.yml'

/** 显示元数据文件名（DSH 的选择器读）。 */
export const METADATA_FILE = 'preset.yml'

/** Vela 自己的策略文件名。DSH 不认识它，会原样忽略。 */
export const POLICY_FILE = 'vela.json'

/** 号牌数量的默认值。三路同时烧已经够呛。 */
export const DEFAULT_MAX_PARALLEL_MEMBERS = 3

/** DSH 自带的委派工具名——队员不能叫这些，否则撞车。 */
const RESERVED_TOOL_NAMES: readonly string[] = [
  'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code',
  'send_message', 'interrupt_agent', 'list_agents', 'report',
]

/** 合法的队员名/小队 slug：小写字母开头，其后小写字母、数字、下划线。 */
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/

/** 把一个显示名压成合法的 slug，用于拼 Squad id。纯非 ASCII 的名字会压成空串。 */
export function slugify(title: string): string {
  const ascii = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return ascii.length === 0 ? '' : ascii
}

/**
 * 一个短而稳定的散列（FNV-1a），用来给压不出 slug 的名字兜底。
 *
 * 必须是**确定性**的：同一个名字要始终映到同一个 id，否则「已经有一支叫这个
 * 名字的小队了」这条判定会失效，同名小队会被反复建出来。
 */
function stableSuffix(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/**
 * 由显示名推一个 Squad id。
 *
 * 中文名（以及任何纯非 ASCII 的名字）压出来的 slug 是空的——目录名只能是
 * ASCII，而这恰恰是最常见的取名方式，所以必须兜住而不是拒绝。兜底用名字的
 * 稳定散列，因此「后端小队」永远映到同一个 id。
 */
export function squadIdFor(title: string): string {
  const slug = slugify(title)
  if (slug.length > 0) return `${SQUAD_ID_PREFIX}${slug}`
  const trimmed = title.trim()
  return trimmed.length === 0 ? '' : `${SQUAD_ID_PREFIX}s${stableSuffix(trimmed)}`
}

/** 一个队员最终生效的工具白名单；空数组表示这个队员没有任何工具。 */
export function memberTools(member: SquadMember, platform: string): readonly string[] {
  const out = new Set<string>()
  for (const ability of member.abilities) {
    for (const tool of toolsForAbility(ability, platform)) out.add(tool)
  }
  for (const tool of member.extraTools ?? []) {
    const trimmed = tool.trim()
    if (trimmed.length > 0) out.add(trimmed)
  }
  return [...out]
}

/**
 * 校验一支小队。返回一条给人看的错误说明，或 undefined 表示合法。
 *
 * 这里拒绝得比 DSH 严：一份 DSH 认不出的组合文件的症状是「那支队的会话建不
 * 起来」，发生在派活的时候——离出错的原因很远。宁可在保存时就拒绝。
 */
export function validateSquad(squad: Squad, platform: string): string | undefined {
  if (squad.title.trim().length === 0) return '小队要有名字'
  if (!squad.id.startsWith(SQUAD_ID_PREFIX)) {
    return `小队 id 必须以 ${SQUAD_ID_PREFIX} 开头，收到 ${squad.id}`
  }
  const slug = squad.id.slice(SQUAD_ID_PREFIX.length)
  if (slug.length === 0) return '小队名里至少要有一个字母或数字'
  if (!/^[a-z0-9-]+$/.test(slug)) return `小队 id 只能含小写字母、数字与连字符，收到 ${squad.id}`
  if (!Number.isInteger(squad.maxParallelMembers) || squad.maxParallelMembers < 1) {
    return '同时在跑的队员数必须是不小于 1 的整数'
  }

  const seen = new Set<string>()
  for (const member of squad.members) {
    if (!NAME_PATTERN.test(member.name)) {
      return `队员名 "${member.name}" 不合法：要以小写字母开头，其后只能是小写字母、数字或下划线`
    }
    if (RESERVED_TOOL_NAMES.includes(member.name)) {
      return `队员名 "${member.name}" 与 DSH 自带的工具撞名，换一个`
    }
    if (seen.has(member.name)) return `队员名 "${member.name}" 重复了`
    seen.add(member.name)
    if (!MEMBER_BACKENDS.includes(member.backend)) {
      return `队员 "${member.name}" 的执行后端 "${member.backend}" 不支持`
    }
    // 模型字段的格式校验：填了就必须能解出 agentOptions。「/foo」「foo/」这种
    // 半边写法会在 memberAgentOptions 里静默回落成沿用队长——那不是用户要的，
    // 而静默回落恰恰是这类配置最危险的失败方式（以为是强模型，实际跑的是默认）。
    if (member.model !== undefined && member.model.trim().length > 0 && memberAgentOptions(member) === undefined) {
      return `队员 "${member.name}" 的模型 "${member.model}" 不合法：写模型名或 provider/model`
    }
    // 一个没有任何工具的队员什么也做不了。这里刻意报错而不是"没白名单=全放开"
    // ——后者会让"我取消了所有勾选"变成一次静默的权限放大。
    if (memberTools(member, platform).length === 0) {
      return `队员 "${member.name}" 至少要勾一项能力，否则它没有任何工具可用`
    }
  }
  return undefined
}

/**
 * 队长上场时收到的开场说明 = Operator 写的职责 + 自动追加的队员名册。
 *
 * **为什么是开场消息而不是系统设定。** 基准 preset 自己已经有一行
 * `@deepseek-ai/dsh-persona`，而同一作用域里 `deployment:persona` 这个段名只能
 * 注册一次——再加一行不是覆盖，是直接抛错，整支队起不来。而基准那一行又不
 * 能删（追加是纯文本操作，改不了前面的行）。于是职责说明只能前置到任务里。
 *
 * 代价得记住：它不再是系统级设定，模型原则上可以忽略它；也拿不到前缀缓存的
 * 好处（每张卡的开场消息不同）。
 *
 * **为什么必须自动追加名册：**DSH 为每个委派工具生成的说明文字是**固定的通用
 * 话术**，不可配置。于是五个队员在队长眼里就是五个说明一模一样、只有名字不同
 * 的工具，光看名字它不知道该派谁。名册是这个信息的唯一来源。
 */
export function leaderInstruction(squad: Squad, platform: string): string {
  const own = squad.instruction.trim()
  if (squad.members.length === 0) return own
  const roster = squad.members
    .map((member) => {
      const duty = member.instruction.trim()
      const tools = memberTools(member, platform).join('、')
      const duties = duty.length === 0 ? '（未写职责）' : duty.replace(/\s+/g, ' ')
      return `- \`${member.name}\`：${duties}（可用：${tools}）`
    })
    .join('\n')
  const header = [
    '## 你的队员',
    '',
    '你可以把活派给下面这些队员，每个队员是一个同名的委派工具。',
    '派活时请按职责挑人，并给出自成一体的完整任务描述。',
    '',
    // 基准 preset 自带 `subagent` / `subagent_fork` 两个匿名子代理工具，队长手里
    // 会同时看到两种选择。本期不禁用它们（号牌闸门属于 ADR-0018 的边界），只在
    // 这里明说该用哪种——匿名子代理拿的是队长的全部权限，绕过了队员的白名单。
    '除非没有合适的队员，不要用通用的 subagent / subagent_fork：那两个拿的是你自己的',
    '全部权限，绕过了队员各自的工具边界。',
    '',
    roster,
  ].join('\n')
  return own.length === 0 ? header : `${own}\n\n${header}`
}

/** 组合文件里的一行。 */
interface CompositionRow {
  readonly id: string
  readonly name: string
  readonly config?: Record<string, unknown>
}

/**
 * 把一行渲成一个 YAML 顶层序列项。
 *
 * 缩进的细节重要：第一行是 `- {`，于是 `{` 落在第 2 列；后续行缩进 2 个空格
 * 也落在第 2 列，正好满足 flow 映射跳行的缩进要求。写成多行而不是挤在一行，
 * 因为队员的职责说明可能很长，挤成一行就无法 diff 也无法人读了。
 */
function renderRow(row: CompositionRow): string {
  const [first, ...rest] = JSON.stringify(row, undefined, 2).split('\n')
  return [`- ${first}`, ...rest.map(line => `  ${line}`)].join('\n')
}

/**
 * 队员职责说明的结束约定：Vela 自动追加在每个队员的 persona 后面。
 *
 * 为什么由 Vela 包而不是让 Operator 自己写：总结的读者是看板上验收卡片的人。
 * 队员最后一条助手消息的文本会被 Vela 提取出来显示在泳道下方——没有这个约定，
 * 队员最后一句话可能是任何东西（一个文件路径、一句「好了」），验收就得翻整场会话。
 *
 * 注意连锁影响：provider 侧拿 persona 反查队员名时，必须按「全等或前缀」认人，
 * 因为这里的 persona 已经不等于 Operator 写的职责原文了（见 squad-provider 的
 * memberNameOf）。
 */
export const MEMBER_OUTRO =
  '结束时，你的最后一条消息用一两句话说明：做了什么、结果如何。这段话会显示在任务卡片上，给验收的人看。'

/** 队员的 persona = 职责原文 + 结束约定。职责为空时不造 persona（行里不写这个字段）。 */
export function memberPersona(member: SquadMember): string | undefined {
  const own = member.instruction.trim()
  if (own.length === 0) return undefined
  return `${own}\n\n${MEMBER_OUTRO}`
}

/** 追加段的分隔注释。让人手打开文件时一眼看出哪里是 Vela 写的。 */
export const APPENDED_SECTION_HEADER = [
  '# ── Vela 小队队员（以下由 Vela 生成）──────────────────────────',
  '#',
  '# 上面的全部内容是基准 preset 的原文副本，每个队员在下面各占一行。',
  '# 手改这份文件会在下一次保存小队时被整份覆盖。',
].join('\n')

/**
 * 基准组合文本能不能拿来追加。返回一条给人看的说明，或 undefined 表示可以。
 *
 * 只做一件事：确认它真的是一个**顶层序列**。这是追加法唯一的前提——往一份
 * mapping 后面接一个 `- …` 会得到一份语法错误的 YAML，而那份文件的症状是小队在
 * DSH 里显示为 broken，离原因很远。宁可在保存时就拒。
 *
 * 不做完整 YAML 校验：这一层没有也不应该有 YAML 解析器，而且基准本身已经被
 * DSH 自己读过一次（它能被读出来才能被当作基准）。
 */
export function baselineProblem(baseline: string): string | undefined {
  if (baseline.trim().length === 0) return '基准 preset 的组合文件是空的'
  // 顶层序列项：列首一个 `-`，后面跟空白或行尾。缩进过的 `- ` 是嵌套项，不算。
  if (!/^-(\s|$)/m.test(baseline)) {
    return '基准 preset 的组合文件不是一个顶层列表，无法在它后面追加队员'
  }
  return undefined
}

/** 生成组合文件时的可选旋钮。 */
export interface ComposeOptions {
  /**
   * 把队员选的后端映成组合文件里实际写的 provider 名。
   *
   * 缺省写 dsh 原生的名字（`spawn` / `fork`），**没有号牌闸门**。宿主在
   * 号牌层真的挂上了的时候传一个映射进来（ADR-0018）。
   *
   * 为什么不写死：组合文件里填一个没注册的 provider 名，整支队的每次委派都
   * 会失败。号牌层能不能挂上取决于运行时（`subagents` 服务在不在、被包的
   * 原生后端在不在），而这一层是纯函数，看不到运行时。
   */
  readonly providerFor?: (backend: MemberBackend) => string
}

/**
 * 生成组合文件的内容（DSH 读的那份）= 基准全文 + 每个队员一行。
 *
 * 行的顺序固定（按声明顺序），让文件可 diff。队员行放**顶层**而不是塞进基准里
 * 的 delegation 分组：`tool-subagent` 需要的 `subagents` 注册表在宿主平面，顶层拿
 * 得到；而那个分组的 `isolate` 是给 workflow 引擎用的，与队员无关。依靠追加而不
 * 是插入，也是「不用理解基准内容」这个技巧能成立的原因。
 *
 * @param baseline - 基准 preset 组合文件的原文。调用方应先过 {@link baselineProblem}。
 */
export function composeComposition(
  squad: Squad,
  platform: string,
  baseline: string,
  options: ComposeOptions = {},
): string {
  const rows: CompositionRow[] = squad.members.map(member => ({
    id: `vela-member-${member.name}`,
    name: '@deepseek-ai/dsh-tool-subagent',
    config: {
      provider: options.providerFor?.(member.backend) ?? member.backend,
      toolName: member.name,
      // 一次性模式，而不是可继续模式——这是号牌闸门能不能生效的分水岭（ADR-0018）。
      //
      // 可继续模式会把委派的**默认**变成后台，而后台可继续子代理的生命周期归 DSH 的
      // continuation manager，**不经过 provider.start()**。一次真跑里队长的三次委派全
      // 走了那条路（工具结果是秒回的 `started subagent <id>`），号牌一次也没参与。
      //
      // 一次性模式下两条路都过 `start()`：前台直接调，后台经 jobs 也调。因此闸门完整
      // 覆盖。代价：队员的会话跑完就收尾，不能再给它补充指令（但依旧能点进去看，
      // 会话本身是真存在的）。拿不能追加指令换一个真的能拦住的并发上限，这笔账划得来。
      backgroundMode: 'one-shot',
      ...(memberPersona(member) === undefined ? {} : { persona: memberPersona(member) }),
      toolFilter: { allow: [...memberTools(member, platform)] },
      // 队员的模型路由（可空）。schema 原生支持 agentOptions，逐字段覆盖父级继承。
      ...(memberAgentOptions(member) === undefined ? {} : { agentOptions: memberAgentOptions(member) }),
    },
  }))
  // 基准末尾未必有换行。少一个换行会让第一个队员行粘到基准最后一行上，得到一份
  // 语法错误的 YAML，所以这里补齐而不是假设。
  const head = baseline.endsWith('\n') ? baseline : `${baseline}\n`
  if (rows.length === 0) return head
  return `${head}\n${APPENDED_SECTION_HEADER}\n\n${rows.map(renderRow).join('\n\n')}\n`
}

/** 生成显示元数据文件的内容。 */
export function composeMetadata(squad: Squad): string {
  const description = squad.members.length === 0
    ? 'Vela 小队（还没有队员）'
    : `Vela 小队：${squad.members.map(member => member.name).join('、')}`
  return `${JSON.stringify({ name: squad.title, description }, undefined, 2)}\n`
}

/** 生成 Vela 自己的策略文件内容。 */
export function composePolicy(squad: Squad): string {
  return `${JSON.stringify({
    version: 1,
    title: squad.title,
    instruction: squad.instruction,
    members: squad.members,
    ...(squad.sandbox === undefined ? {} : { sandbox: squad.sandbox }),
    maxParallelMembers: squad.maxParallelMembers,
  }, undefined, 2)}\n`
}

/**
 * 从策略文件读回一支小队。
 *
 * **读的是策略文件而不是组合文件**：组合文件是给 DSH 的产物，队员的能力勾选
 * 在那里已经被展开成一串工具名，反推回勾选项会丢信息（比如平台分叉过的 shell、
 * 以及高级口里手填的工具）。策略文件保留 Operator 的原始意图，组合文件则是它的
 * 一次投影。
 *
 * @param id - 目录名。
 * @param policyText - 策略文件内容。
 * @returns 小队，或 undefined 表示这份策略读不出来。
 */
export function parsePolicy(id: string, policyText: string): Squad | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(policyText)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (record.version !== 1) return undefined
  const title = typeof record.title === 'string' && record.title.trim().length > 0
    ? record.title
    : id.slice(SQUAD_ID_PREFIX.length)
  const rawMembers = Array.isArray(record.members) ? record.members : []
  const members: SquadMember[] = []
  for (const candidate of rawMembers) {
    if (typeof candidate !== 'object' || candidate === null) return undefined
    const member = candidate as Record<string, unknown>
    if (typeof member.name !== 'string') return undefined
    const abilities = Array.isArray(member.abilities)
      ? member.abilities.filter((value): value is Ability => ABILITIES.includes(value as Ability))
      : []
    const extraTools = Array.isArray(member.extraTools)
      ? member.extraTools.filter((value): value is string => typeof value === 'string')
      : []
    members.push({
      name: member.name,
      instruction: typeof member.instruction === 'string' ? member.instruction : '',
      abilities,
      ...(extraTools.length === 0 ? {} : { extraTools }),
      backend: MEMBER_BACKENDS.includes(member.backend as MemberBackend)
        ? (member.backend as MemberBackend)
        : 'spawn',
      // model 是可选的；读回时只接受非空字符串，其余形状一律丢掉（与 abilities 同款纪律）。
      ...(typeof member.model === 'string' && member.model.trim().length > 0 ? { model: member.model } : {}),
    })
  }
  const parallel = record.maxParallelMembers
  return {
    id,
    title,
    instruction: typeof record.instruction === 'string' ? record.instruction : '',
    members,
    ...(typeof record.sandbox === 'string' ? { sandbox: record.sandbox } : {}),
    maxParallelMembers: Number.isInteger(parallel) && (parallel as number) >= 1
      ? (parallel as number)
      : DEFAULT_MAX_PARALLEL_MEMBERS,
  }
}
