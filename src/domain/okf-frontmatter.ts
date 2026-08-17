/**
 * OKF 概念文档头部（YAML frontmatter）的解析与序列化（ADR-0023）。
 *
 * 这里**不是**一个 YAML 实现，也不打算成为。它只认 Vela 自己写得出来的那个
 * 受控子集：标量、标量数组、一层深的对象、以及一层深对象的数组。理由是范围
 * ——这些文件由 Vela 自己写、自己读，需要的表达力远小于一个 YAML 库能提供
 * 的，而领域层零第三方依赖是 Vela 能脱离宿主单测的原因。
 *
 * 两条硬要求来自 OKF 规范本身：
 *
 * 1. **不认识的键原样保留并回写。** 规范要求消费者容忍未知字段；丢掉它们
 *    等于在别人的知识包上悄悄改坏数据。因此解析结果保留全部键，序列化时
 *    已知键按固定顺序在前、其余按原顺序在后。
 * 2. **读不懂就报错，不猜。** 一篇解析不了的文档要能指出是哪一行、哪个键，
 *    由上层显示成「这篇读不了」，而不是静默丢字段后装作读懂了。
 *
 * 刻意不做的事：锚点、引用、多行折叠、块标量、注释保留、以及 YAML 的隐式
 * 类型（`true` / `null` / 时间戳都按字符串读）。要它们的那天就该换库，
 * 换掉的只有这一个文件。
 */

/** 头部里一个键能取的标量。 */
export type OkfScalar = string | number

/** 一层深的对象，值只能是标量。`generated` 与 `sources[]` 都是这个形状。 */
export interface OkfRecord {
  readonly [key: string]: OkfScalar
}

/** 一个键的值。 */
export type OkfValue = OkfScalar | readonly OkfScalar[] | OkfRecord | readonly OkfRecord[]

/** 一份解析出来的头部。键的顺序即文件里的顺序。 */
export type Frontmatter = ReadonlyMap<string, OkfValue>

/** 头部读不懂。`line` 是 1 起的行号（相对整份文档）。 */
export class OkfParseError extends Error {
  constructor(message: string, readonly line: number, readonly key?: string) {
    super(`第 ${line} 行${key === undefined ? '' : `（${key}）`}：${message}`)
    this.name = 'OkfParseError'
  }
}

/** 头部与正文的分界。 */
const FENCE = '---'

/** 已知键的展示顺序。不在表里的键按原顺序排在后面。 */
const KEY_ORDER: readonly string[] = [
  'type', 'title', 'description', 'okf_version',
  'status', 'tags', 'resource',
  'generated', 'verified', 'sources', 'stale_after',
]

/** 一份文档拆成头部与正文。 */
export interface OkfDocument {
  readonly frontmatter: Frontmatter
  /** 头部之后的全部内容，首尾空行已裁掉。 */
  readonly body: string
}

/**
 * 把一段文本解析成头部 + 正文。
 *
 * 没有头部、或头部没闭合，都是错误而不是「当成没有头部」——OKF 的合规
 * 底线就是「有 frontmatter 且 `type` 非空」，一篇没有头部的文件不是一份
 * 概念文档，把它当空头部处理会让上层以为读到了一篇没有类型的概念。
 *
 * @param text - 整份文档。
 */
export function parseDocument(text: string): OkfDocument {
  const lines = text.split('\n')
  let at = 0
  // 允许文件以 BOM 或空行开头：编辑器与 git 都可能留下它们。
  while (at < lines.length && lines[at]!.replace(/^\uFEFF/, '').trim().length === 0) at += 1
  if (at >= lines.length || lines[at]!.replace(/^\uFEFF/, '').trim() !== FENCE) {
    throw new OkfParseError(`文档要以 ${FENCE} 开头的头部起始`, at + 1)
  }
  const start = at + 1
  let end = -1
  for (let scan = start; scan < lines.length; scan += 1) {
    if (lines[scan]!.trim() === FENCE) { end = scan; break }
  }
  // 行号一律 1 起：`start` 是 0 起的下标，报错时要 +1，否则指到上一行。
  if (end === -1) throw new OkfParseError(`头部没有闭合的 ${FENCE}`, start + 1)
  const frontmatter = parseFrontmatter(lines.slice(start, end), start + 1)
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
  return { frontmatter, body }
}

/**
 * 解析头部的若干行。
 * @param lines - 两道 `---` 之间的行。
 * @param firstLine - 这批行里第一行在整份文档里的行号（1 起），报错要用。
 */
export function parseFrontmatter(lines: readonly string[], firstLine = 1): Frontmatter {
  const entries = new Map<string, OkfValue>()
  let index = 0
  while (index < lines.length) {
    const raw = lines[index]!
    const lineNumber = firstLine + index
    if (raw.trim().length === 0 || raw.trimStart().startsWith('#')) { index += 1; continue }
    if (raw.startsWith(' ') || raw.startsWith('\t')) {
      throw new OkfParseError('意外的缩进——这一行不挂在任何键下面', lineNumber)
    }
    const colon = raw.indexOf(':')
    if (colon === -1) throw new OkfParseError('少了 `键: 值` 里的冒号', lineNumber)
    const key = raw.slice(0, colon).trim()
    if (key.length === 0) throw new OkfParseError('键名为空', lineNumber)
    if (entries.has(key)) throw new OkfParseError('这个键出现了两次', lineNumber, key)
    const inline = raw.slice(colon + 1).trim()
    if (inline.length > 0) {
      entries.set(key, inline.startsWith('[')
        ? parseFlowSequence(inline, lineNumber, key)
        : parseScalar(inline, lineNumber, key))
      index += 1
      continue
    }
    // 值在后续的缩进块里。先收集属于这个键的行，再判断它是数组还是对象。
    const block: { readonly text: string; readonly line: number }[] = []
    index += 1
    while (index < lines.length) {
      const next = lines[index]!
      if (next.trim().length === 0) { index += 1; continue }
      if (!next.startsWith(' ') && !next.startsWith('\t')) break
      block.push({ text: next, line: firstLine + index })
      index += 1
    }
    if (block.length === 0) {
      // `key:` 后面什么都没有。空字符串是唯一诚实的读法——不猜 null。
      entries.set(key, '')
      continue
    }
    entries.set(key, parseBlock(block, key))
  }
  return entries
}

/** 缩进块：`- ` 开头是数组，否则是一层对象。 */
function parseBlock(
  block: readonly { readonly text: string; readonly line: number }[],
  key: string,
): OkfValue {
  const first = block[0]!
  const isSequence = first.text.trimStart().startsWith('- ')
  if (!isSequence) {
    const record: Record<string, OkfScalar> = {}
    for (const { text, line } of block) {
      const [name, value] = splitPair(text, line, key)
      if (value.length === 0) throw new OkfParseError('嵌套只支持一层，这里的值不能再展开', line, `${key}.${name}`)
      record[name] = parseScalar(value, line, `${key}.${name}`)
    }
    return record
  }
  // 数组：每个 `- ` 起一项。项里带冒号的是对象项，否则是标量项。
  const scalars: OkfScalar[] = []
  const records: Record<string, OkfScalar>[] = []
  let current: Record<string, OkfScalar> | undefined
  for (const { text, line } of block) {
    const trimmed = text.trimStart()
    if (trimmed.startsWith('- ')) {
      const item = trimmed.slice(2).trim()
      if (looksLikePair(item)) {
        const [name, value] = splitPair(item, line, key)
        current = { [name]: parseScalar(value, line, `${key}[].${name}`) }
        records.push(current)
      } else {
        current = undefined
        scalars.push(parseScalar(item, line, `${key}[]`))
      }
      continue
    }
    // 续行：同一个对象项的其余字段。
    if (current === undefined) throw new OkfParseError('这一行不属于任何数组项', line, key)
    const [name, value] = splitPair(trimmed, line, key)
    current[name] = parseScalar(value, line, `${key}[].${name}`)
  }
  if (scalars.length > 0 && records.length > 0) {
    throw new OkfParseError('数组里混了标量项与对象项', first.line, key)
  }
  return records.length > 0 ? records : scalars
}

/** `a: b` 形状的判定。冒号后必须跟空白或到行尾，否则 `http://x` 会被当成键。 */
function looksLikePair(text: string): boolean {
  return /^[^:\s][^:]*:(\s|$)/.test(text)
}

function splitPair(text: string, line: number, key: string): readonly [string, string] {
  const trimmed = text.trim()
  const colon = trimmed.indexOf(':')
  if (colon === -1) throw new OkfParseError('少了 `键: 值` 里的冒号', line, key)
  const name = trimmed.slice(0, colon).trim()
  if (name.length === 0) throw new OkfParseError('键名为空', line, key)
  return [name, trimmed.slice(colon + 1).trim()]
}

/** `[a, b, c]` 这种行内数组。 */
function parseFlowSequence(text: string, line: number, key: string): readonly OkfScalar[] {
  if (!text.endsWith(']')) throw new OkfParseError('行内数组没有闭合的 `]`', line, key)
  const inner = text.slice(1, -1).trim()
  if (inner.length === 0) return []
  return splitFlowItems(inner, line, key).map(item => parseScalar(item, line, `${key}[]`))
}

/** 按逗号切开行内数组，但不切引号里的逗号。 */
function splitFlowItems(inner: string, line: number, key: string): readonly string[] {
  const items: string[] = []
  let current = ''
  let quote: string | undefined
  for (const char of inner) {
    if (quote !== undefined) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue }
    if (char === ',') { items.push(current.trim()); current = ''; continue }
    current += char
  }
  if (quote !== undefined) throw new OkfParseError('行内数组里的引号没有闭合', line, key)
  items.push(current.trim())
  return items.filter(item => item.length > 0)
}

/**
 * 一个标量。
 *
 * 只在**没有引号**且整体形如数字时才读成数字：`usage_count: 3` 是计数，
 * 而 `title: "3"` 必须留成字符串，否则往返会把它变成数字。
 */
function parseScalar(text: string, line: number, key: string): OkfScalar {
  if (text.length === 0) return ''
  const quote = text[0]
  if (quote === '"' || quote === "'") {
    if (text.length < 2 || !text.endsWith(quote)) {
      throw new OkfParseError('引号没有闭合', line, key)
    }
    const inner = text.slice(1, -1)
    return quote === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\') : inner
  }
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  return text
}

/** 序列化一份文档：头部 + 空行 + 正文，末尾一个换行。 */
export function serializeDocument(document: OkfDocument): string {
  const body = document.body.replace(/\s+$/, '')
  const head = serializeFrontmatter(document.frontmatter)
  return body.length === 0 ? head : `${head}\n${body}\n`
}

/** 序列化头部，含两道 `---`。已知键在前，未知键按原顺序在后。 */
export function serializeFrontmatter(frontmatter: Frontmatter): string {
  const keys = [...frontmatter.keys()]
  const known = KEY_ORDER.filter(key => frontmatter.has(key))
  const rest = keys.filter(key => !known.includes(key))
  const lines = [FENCE]
  for (const key of [...known, ...rest]) {
    lines.push(...serializeEntry(key, frontmatter.get(key)!))
  }
  lines.push(FENCE)
  return `${lines.join('\n')}\n`
}

function serializeEntry(key: string, value: OkfValue): readonly string[] {
  if (Array.isArray(value)) {
    const items = value as readonly (OkfScalar | OkfRecord)[]
    if (items.length === 0) return [`${key}: []`]
    if (items.every(item => typeof item !== 'object')) {
      return [`${key}: [${(items as readonly OkfScalar[]).map(formatScalar).join(', ')}]`]
    }
    const lines = [`${key}:`]
    for (const item of items as readonly OkfRecord[]) {
      const pairs = Object.entries(item)
      if (pairs.length === 0) continue
      lines.push(`  - ${pairs[0]![0]}: ${formatScalar(pairs[0]![1])}`)
      for (const [name, inner] of pairs.slice(1)) lines.push(`    ${name}: ${formatScalar(inner)}`)
    }
    return lines
  }
  if (typeof value === 'object') {
    const pairs = Object.entries(value)
    if (pairs.length === 0) return [`${key}: {}`]
    return [`${key}:`, ...pairs.map(([name, inner]) => `  ${name}: ${formatScalar(inner)}`)]
  }
  return [`${key}: ${formatScalar(value)}`]
}

/**
 * 一个标量的字面量。
 *
 * 要加引号的三种情况：空串、形如数字的字符串（否则读回来变数字）、以及
 * 会破坏这个子集语法的字符（冒号后跟空白、行首的列表标记、井号、引号、
 * 换行、首尾空白）。其余原样写出，让文件保持好读。
 */
function formatScalar(value: OkfScalar): string {
  if (typeof value === 'number') return String(value)
  const needsQuote = value.length === 0
    || /^-?\d+(?:\.\d+)?$/.test(value)
    || /: |:$|^[-?*&!|>%@`#[{]|["'\n]|^\s|\s$/.test(value)
  if (!needsQuote) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/** 读一个键的字符串值；不存在或不是字符串时给 undefined。 */
export function readString(frontmatter: Frontmatter, key: string): string | undefined {
  const value = frontmatter.get(key)
  return typeof value === 'string' ? value : undefined
}

/** 读一个键的数字值；不存在或不是数字时给 undefined。 */
export function readNumber(frontmatter: Frontmatter, key: string): number | undefined {
  const value = frontmatter.get(key)
  return typeof value === 'number' ? value : undefined
}

/** 读一个键的字符串数组；缺失时给空数组。数字项按字符串给出。 */
export function readList(frontmatter: Frontmatter, key: string): readonly string[] {
  const value = frontmatter.get(key)
  if (!Array.isArray(value)) return []
  return (value as readonly unknown[])
    .filter(item => typeof item !== 'object')
    .map(item => String(item))
}

/** 读一个键的对象数组；缺失时给空数组。 */
export function readRecords(frontmatter: Frontmatter, key: string): readonly OkfRecord[] {
  const value = frontmatter.get(key)
  if (!Array.isArray(value)) return []
  return (value as readonly unknown[]).filter(
    (item): item is OkfRecord => typeof item === 'object' && item !== null,
  )
}

/**
 * 读一个键的单个对象；不是对象时给 undefined。
 *
 * 用一个类型谓词而不是直接 `Array.isArray`：后者把参数收窄成 `any[]`，
 * 对 `readonly` 数组的否定分支不会被排除。
 */
export function readRecord(frontmatter: Frontmatter, key: string): OkfRecord | undefined {
  const value = frontmatter.get(key)
  if (typeof value !== 'object' || value === null) return undefined
  if (isArray(value)) return undefined
  return value
}

function isArray(value: object): value is readonly unknown[] {
  return Array.isArray(value)
}
