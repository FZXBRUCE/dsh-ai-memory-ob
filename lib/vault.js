/**
 * dsh-ai-memory-ob — 记忆库的磁盘层。
 *
 * 设计要点(原创):
 * - 库根目录由用户在设置里指定,默认 `$DSH_HOME/ai-memory`。
 * - 一切以 Obsidian vault 的方式落盘:纯 Markdown + YAML frontmatter,
 *   链接用 `[[文件名]]`,因此 Obsidian 打开即得关系图谱,不需要导出。
 * - 目录约定:
 *     memories/   记忆条目(每次 /write 一批)
 *     sessions/   每个对话窗口一页,串起它的全部条目
 *     profile/    用户画像(常驻单文件)
 *     graph/      图谱索引(每日一个 MOC + /update 的全局索引)
 *     zips/       /zip 生成的压缩记忆(源文件不动)
 *     daily/      每日时间线
 *     .dsh/       插件自己的状态(不进图谱)
 * - 索引文件 `.dsh/index.json` 是派生缓存,可随时从 Markdown 重建。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { dateStamp, isoNow, oneLine, safeSeg, slug, timeStamp, truncate, unique, yamlList, yamlString } from './util.js'

const LAYOUT = {
  memories: 'memories',
  sessions: 'sessions',
  profile: 'profile',
  graph: 'graph',
  zips: 'zips',
  daily: 'daily',
  state: '.dsh',
}

/** 每批记忆最多写多少条,防止一次 /write 把库冲爆。 */
const MAX_ENTRIES_PER_BATCH = 40
/** 单条记忆正文上限(字符)。 */
const MAX_ENTRY_CHARS = 12_000

/** 读文本,失败返回 undefined。 */
function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 确保目录存在。 */
function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}

/** 列出目录里的文件(不存在则空数组)。 */
function listFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile())
  } catch {
    return []
  }
}

/** 把 frontmatter + 正文拼成 Markdown。 */
export function composeMarkdown(fields, body) {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) lines.push(`${key}: ${yamlList(value)}`)
    else if (typeof value === 'number' || typeof value === 'boolean') lines.push(`${key}: ${String(value)}`)
    else lines.push(`${key}: ${yamlString(value)}`)
  }
  lines.push('---', '')
  return `${lines.join('\n')}${String(body ?? '').trim()}\n`
}

/** 只解析插件自己写出的那部分 frontmatter(标量/数组),够用且不引依赖。 */
export function parseFrontmatter(text) {
  const source = String(text ?? '')
  if (!source.startsWith('---\n')) return { fields: {}, body: source }
  const end = source.indexOf('\n---', 4)
  if (end < 0) return { fields: {}, body: source }
  const header = source.slice(4, end)
  const body = source.slice(source.indexOf('\n', end + 4) + 1)
  const fields = {}
  for (const line of header.split('\n')) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    const raw = line.slice(colon + 1).trim()
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1).trim()
      fields[key] = inner === ''
        ? []
        : inner.split(',').map((item) => {
          const value = item.trim()
          if (value.startsWith('"') && value.endsWith('"')) {
            try {
              return JSON.parse(value)
            } catch {
              return value.slice(1, -1)
            }
          }
          return value
        })
      continue
    }
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        fields[key] = JSON.parse(raw)
        continue
      } catch {
        fields[key] = raw.slice(1, -1)
        continue
      }
    }
    if (raw === 'true' || raw === 'false') {
      fields[key] = raw === 'true'
      continue
    }
    if (raw !== '' && Number.isFinite(Number(raw))) {
      fields[key] = Number(raw)
      continue
    }
    fields[key] = raw
  }
  return { fields, body }
}

/** 记忆库句柄。 */
export class MemoryVault {
  /**
   * @param {string} root 库根目录(绝对路径)。
   * @param {(line: string) => void} log 诊断日志。
   */
  constructor(root, log = () => {}) {
    this.root = resolve(root)
    this.log = log
    this.indexPath = join(this.root, LAYOUT.state, 'index.json')
    this.index = this.#loadIndex()
  }

  /** 库目录结构(供 UI 展示)。 */
  layout() {
    return { ...LAYOUT }
  }

  /** 绝对路径 → 库内相对路径(统一用 `/`,方便 Obsidian 与 URL)。 */
  relativeOf(path) {
    return relative(this.root, path).split(sep).join('/')
  }

  /** 库内相对路径 → 绝对路径,并拦住 `..` 越界。 */
  resolveInside(relPath) {
    const target = resolve(this.root, relPath)
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error(`path escapes the memory vault: ${relPath}`)
    }
    return target
  }

  /** 建好全部目录。 */
  ensureLayout() {
    ensureDir(this.root)
    for (const dir of Object.values(LAYOUT)) ensureDir(join(this.root, dir))
    return this
  }

  /** 观测:条目数、最近写入、库体积。 */
  stats() {
    const entries = this.#entryFiles()
    let bytes = 0
    for (const path of entries) {
      try {
        bytes += statSync(path).size
      } catch {
        // 文件消失不计入。
      }
    }
    return {
      root: this.root,
      entries: entries.length,
      bytes,
      profile: existsSync(join(this.root, LAYOUT.profile, 'user-profile.md')),
      lastWrite: this.index.lastWrite,
      writes: this.index.writes,
      turnsSinceWrite: this.index.turnsSinceWrite ?? 0,
      zips: listFiles(join(this.root, LAYOUT.zips)).filter((name) => name.endsWith('.md')).length,
      graphNotes: listFiles(join(this.root, LAYOUT.graph)).filter((name) => name.endsWith('.md')).length,
    }
  }

  /** 会话游标(增量写入时判断"这次写了多少")。 */
  cursorOf(sessionId) {
    return this.index.cursors?.[sessionId] ?? 0
  }

  /** 记录会话游标与轮次计数。 */
  commitCursor(sessionId, seq, turns) {
    this.index.cursors = this.index.cursors ?? {}
    this.index.cursors[sessionId] = seq
    this.index.turnsSinceWrite = turns
    this.index.lastWrite = isoNow()
    this.index.writes = (this.index.writes ?? 0) + 1
    this.#saveIndex()
  }

  /** 只累加"自上次写入以来的轮数",用于按轮自动写入。 */
  bumpTurns(sessionId) {
    this.index.turns = this.index.turns ?? {}
    this.index.turns[sessionId] = (this.index.turns[sessionId] ?? 0) + 1
    this.index.turnsSinceWrite = (this.index.turns[sessionId] ?? 0)
    this.#saveIndex()
    return this.index.turns[sessionId]
  }

  /** 复位某会话的轮次计数(写入后调用)。 */
  resetTurns(sessionId) {
    this.index.turns = this.index.turns ?? {}
    this.index.turns[sessionId] = 0
    this.index.turnsSinceWrite = 0
    this.#saveIndex()
  }

  /**
   * 写入一批记忆条目。
   * @param {object} input 会话 id/标题、条目数组、画像补丁、是否整窗重写。
   */
  writeEntries(input) {
    this.ensureLayout()
    const now = new Date()
    const day = dateStamp(now)
    const sessionSeg = canonicalSessionSeg(input.sessionId ?? 'session')
    const written = []

    const entries = (Array.isArray(input.entries) ? input.entries : [])
      .filter((entry) => entry && typeof entry.text === 'string' && entry.text.trim() !== '')
      .slice(0, MAX_ENTRIES_PER_BATCH)

    // 整窗重写:先清掉这个窗口的旧条目。模型每次归纳的标题不一定稳定,
    // 只按标题复用会留下"同义不同名"的重复,所以重写要以窗口为单位替换。
    // 其它窗口的条目一律不动。
    const retired = input.replaceSession === true ? this.#removeSessionEntries(sessionSeg) : []

    // 增量写入时,同会话同标题视为同一条记忆:覆盖原文件而不是再写一份。
    const reusable = this.#entriesByTitle(sessionSeg)

    // 链接只保留库里真实存在的条目名 + 本批新条目名,免得 Obsidian 里出现
    // 一堆指向不存在文件的死链(模型引用的旧标题在整窗重写后可能已消失)。
    const knownTitles = new Set([...this.#allTitles(), ...entries.map((entry) => oneLine(entry.title ?? entry.text, 60))])

    entries.forEach((entry, index) => {
      const title = oneLine(entry.title ?? entry.text, 60) || `记忆 ${index + 1}`
      const kind = safeSeg(entry.kind ?? 'note', 'note').toLowerCase()
      const existing = reusable.get(title)
      const fileName = existing !== undefined
        ? existing
        : `${day} ${pad2(index + 1)} ${slug(title, 'memory')}.md`
      const path = join(this.root, LAYOUT.memories, fileName)
      const links = unique(
        (entry.links ?? [])
          .map((link) => String(link).trim())
          .filter((link) => link !== '' && link !== title && knownTitles.has(link)),
      ).slice(0, 24)
      const tags = unique(['记忆', kind, ...(entry.tags ?? []).map((tag) => String(tag).trim())].filter(Boolean)).slice(0, 24)
      const body = [
        `# ${title}`,
        '',
        `> 采集于 ${timeStamp(now)} · 会话 [[${sessionLinkName(sessionSeg)}|${oneLine(input.sessionTitle ?? sessionSeg, 40)}]]`,
        '',
        truncate(entry.text.trim(), MAX_ENTRY_CHARS),
        '',
        links.length > 0 ? '## 关联' : '',
        ...links.map((link) => `- [[${link}]]`),
        '',
      ].filter((line) => line !== '' || true).join('\n')
      const markdown = composeMarkdown({
        type: 'ai-memory',
        kind,
        title,
        session: sessionSeg,
        session_title: oneLine(input.sessionTitle ?? '', 120),
        created: timeStamp(now),
        date: day,
        tags,
        links,
        source_seq: typeof entry.sourceSeq === 'number' ? entry.sourceSeq : undefined,
      }, body)
      writeFileSync(path, markdown, 'utf8')
      written.push({ path: this.relativeOf(path), title, kind, links, updated: existing !== undefined })
    })

    const sessionNote = this.#writeSessionNote({
      now, day, sessionSeg, title: input.sessionTitle, entries, written,
    })
    const dailyNote = this.#appendDaily(day, now, input, written)
    const profileNote = input.profile ? this.#mergeProfile(input.profile, now) : undefined
    this.#writeGraphDay(day, now)

    this.index.entries = (this.index.entries ?? 0) + written.length
    this.index.lastWrite = isoNow(now)
    this.#saveIndex()

    return {
      root: this.root,
      written,
      retired,
      sessionNote,
      dailyNote,
      profileNote,
      skipped: (Array.isArray(input.entries) ? input.entries.length : 0) - written.length,
    }
  }

  /**
   * 全量重建索引:扫描 memories/,从 frontmatter 复原条目元数据。
   * Obsidian 里手改过的文件也会被认领。
   */
  rebuildIndex() {
    this.ensureLayout()
    const entries = []
    for (const name of listFiles(join(this.root, LAYOUT.memories))) {
      if (!name.endsWith('.md')) continue
      const text = readIfExists(join(this.root, LAYOUT.memories, name))
      if (text === undefined) continue
      const { fields } = parseFrontmatter(text)
      entries.push({
        file: `${LAYOUT.memories}/${name}`,
        title: fields.title ?? name.replace(/\.md$/, ''),
        kind: fields.kind ?? 'note',
        session: fields.session ?? '',
        date: fields.date ?? '',
        links: Array.isArray(fields.links) ? fields.links : [],
        tags: Array.isArray(fields.tags) ? fields.tags : [],
      })
    }
    entries.sort((left, right) => String(right.date).localeCompare(String(left.date)))
    this.index = {
      ...this.index,
      version: 1,
      rebuiltAt: isoNow(),
      entries: entries.length,
      catalog: entries,
      lastWrite: this.index.lastWrite,
      writes: this.index.writes ?? 0,
    }
    this.#saveIndex()
    return { entries: entries.length, root: this.root }
  }

  /**
   * 按条件挑选记忆文件。
   * @param {{from?: string, to?: string, session?: string, kinds?: string[], tags?: string[], limit?: number}} query
   */
  selectFiles(query = {}) {
    const from = query.from ?? ''
    const to = query.to ?? ''
    const kinds = new Set((query.kinds ?? []).map((kind) => kind.toLowerCase()))
    const tags = new Set((query.tags ?? []).map((tag) => tag.toLowerCase()))
    const session = query.session ?? ''
    const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(5000, Number(query.limit))) : 60

    const files = []
    for (const name of listFiles(join(this.root, LAYOUT.memories))) {
      if (!name.endsWith('.md')) continue
      const path = join(this.root, LAYOUT.memories, name)
      const text = readIfExists(path)
      if (text === undefined) continue
      const { fields, body } = parseFrontmatter(text)
      const date = String(fields.date ?? name.slice(0, 10))
      if (from !== '' && date < from) continue
      if (to !== '' && date > to) continue
      if (session !== '' && canonicalSessionSeg(fields.session ?? '') !== canonicalSessionSeg(session)) continue
      if (kinds.size > 0 && !kinds.has(String(fields.kind ?? '').toLowerCase())) continue
      if (tags.size > 0) {
        const own = new Set((Array.isArray(fields.tags) ? fields.tags : []).map((tag) => String(tag).toLowerCase()))
        let hit = false
        for (const tag of tags) {
          if (own.has(tag)) {
            hit = true
            break
          }
        }
        if (!hit) continue
      }
      files.push({
        file: this.relativeOf(path),
        title: fields.title ?? name.replace(/\.md$/, ''),
        kind: fields.kind ?? 'note',
        date,
        session: fields.session ?? '',
        sessionTitle: fields.session_title ?? '',
        links: Array.isArray(fields.links) ? fields.links : [],
        body,
        text,
      })
    }
    files.sort((left, right) => String(right.date).localeCompare(String(left.date)) || left.title.localeCompare(right.title))
    return { total: files.length, files: files.slice(0, limit) }
  }

  /** 压缩后的记忆(可选多窗口共享)。 */
  selectZips(query = {}) {
    const session = query.session ?? ''
    const shareAll = query.shareAll === true
    const out = []
    for (const name of listFiles(join(this.root, LAYOUT.zips))) {
      if (!name.endsWith('.md')) continue
      const text = readIfExists(join(this.root, LAYOUT.zips, name))
      if (text === undefined) continue
      const { fields, body } = parseFrontmatter(text)
      // 两侧都做归一:老文件里存的可能带 `session-` 前缀,新文件存裸片段。
      if (!shareAll && session !== '' && canonicalSessionSeg(fields.session ?? '') !== canonicalSessionSeg(session)) continue
      out.push({
        file: `${LAYOUT.zips}/${name}`,
        title: fields.title ?? name.replace(/\.md$/, ''),
        session: fields.session ?? '',
        date: String(fields.date ?? name.slice(0, 10)),
        body,
      })
    }
    return out
  }

  /** 用户画像正文(注入上下文时用)。 */
  readProfile() {
    return readIfExists(join(this.root, LAYOUT.profile, 'user-profile.md'))
  }

  /**
   * 给上下文注入用的摘要块。控制体积:画像 + 最近 N 条标题 + 图谱索引。
   */
  composeContextDigest(options = {}) {
    const recent = Number.isFinite(options.recent) ? Math.max(0, Math.min(40, Number(options.recent))) : 12
    const includeProfile = options.profile !== false
    const includeZips = options.zips === true
    const session = options.session ?? ''
    const parts = []

    if (includeProfile) {
      const profile = this.readProfile()
      if (profile !== undefined && profile.trim() !== '') {
        parts.push('## 用户画像', '', truncate(extractBody(profile), 2600).trim(), '')
      }
    }

    const recentFiles = this.selectFiles({ limit: recent })
    if (recentFiles.files.length > 0) {
      parts.push('## 近期记忆')
      for (const file of recentFiles.files) {
        parts.push(`- ${file.date} · ${file.title} — ${oneLine(summaryOf(file.text), 150)}`)
      }
      parts.push('')
    }

    if (includeZips) {
      const zips = this.selectZips({ session, shareAll: options.zipShareAll === true })
      if (zips.length > 0) {
        parts.push('## 压缩记忆')
        for (const zip of zips) {
          // 压缩件的价值在正文:带一小段回顾,而不是只报文件名。
          parts.push(`### ${zip.title}(${zip.date})`, '', truncate(summaryOf(zip.body), 1200), '')
        }
      }
    }

    const graph = this.#graphIndexText()
    if (graph !== '') parts.push('## 图谱索引', '', graph, '')
    return parts.join('\n').trim()
  }

  /** 每日图谱 MOC 的绝对路径(UI 里点开用)。 */
  graphNotePath(day = dateStamp()) {
    return join(this.root, LAYOUT.graph, `${day}.md`)
  }

  // ---------------------------------------------------------------- 内部

  #loadIndex() {
    const text = readIfExists(this.indexPath)
    if (text === undefined) return { version: 1, writes: 0, entries: 0, cursors: {}, turns: {} }
    try {
      const parsed = JSON.parse(text)
      return typeof parsed === 'object' && parsed !== null
        ? { version: 1, writes: 0, entries: 0, cursors: {}, turns: {}, ...parsed }
        : { version: 1, writes: 0, entries: 0, cursors: {}, turns: {} }
    } catch {
      return { version: 1, writes: 0, entries: 0, cursors: {}, turns: {} }
    }
  }

  #saveIndex() {
    try {
      ensureDir(dirname(this.indexPath))
      writeFileSync(this.indexPath, `${JSON.stringify(this.index, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.log(`index write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #entryFiles() {
    return listFiles(join(this.root, LAYOUT.memories))
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(this.root, LAYOUT.memories, name))
  }

  /**
   * 删掉某个窗口的全部条目,返回删掉的文件相对路径。
   * 只动 `memories/` 下 frontmatter 里 session 匹配的文件。
   */
  #removeSessionEntries(sessionSeg) {
    const removed = []
    for (const name of listFiles(join(this.root, LAYOUT.memories))) {
      if (!name.endsWith('.md')) continue
      const path = join(this.root, LAYOUT.memories, name)
      const text = readIfExists(path)
      if (text === undefined) continue
      const { fields } = parseFrontmatter(text)
      if (canonicalSessionSeg(fields.session ?? '') !== sessionSeg) continue
      try {
        rmSync(path)
        removed.push(this.relativeOf(path))
      } catch {
        // 删不掉就留着,下一次重写还会再试。
      }
    }
    return removed
  }

  /**
   * 库里现有全部条目的标题(链接校验用)。
   */
  #allTitles() {
    const titles = new Set()
    for (const name of listFiles(join(this.root, LAYOUT.memories))) {
      if (!name.endsWith('.md')) continue
      const text = readIfExists(join(this.root, LAYOUT.memories, name))
      if (text === undefined) continue
      const { fields } = parseFrontmatter(text)
      const title = String(fields.title ?? '')
      if (title !== '') titles.add(title)
    }
    return titles
  }

  /**
   * 某会话已有的条目:标题 → 文件名。
   * 增量写入时靠它复用文件,避免同一事实在库里出现两份。
   */
  #entriesByTitle(sessionSeg) {
    const map = new Map()
    for (const name of listFiles(join(this.root, LAYOUT.memories))) {
      if (!name.endsWith('.md')) continue
      const text = readIfExists(join(this.root, LAYOUT.memories, name))
      if (text === undefined) continue
      const { fields } = parseFrontmatter(text)
      if (canonicalSessionSeg(fields.session ?? '') !== sessionSeg) continue
      const title = String(fields.title ?? '')
      if (title !== '') map.set(title, name)
    }
    return map
  }

  /** 每个会话一页,列出它的全部记忆(Obsidian 里顺着看)。 */
  #writeSessionNote(input) {
    const dir = ensureDir(join(this.root, LAYOUT.sessions))
    const name = `session-${input.sessionSeg}.md`
    const path = join(dir, name)
    const existing = readIfExists(path)
    const previous = existing === undefined ? [] : parseBulletLinks(extractBody(existing))
    const fresh = input.written.map((entry) => ({ date: input.day, title: entry.title, file: entry.path }))
    const merged = dedupeByFile([...fresh, ...previous])
    const body = [
      `# 会话记忆 · ${oneLine(input.title ?? input.sessionSeg, 60)}`,
      '',
      `- 会话 id: \`${input.sessionSeg}\``,
      `- 最近更新: ${timeStamp(input.now)}`,
      '',
      '## 记忆条目',
      ...merged.map((entry) => `- ${entry.date} · [[${entry.title}]] (${entry.file})`),
      '',
      '## 返回',
      '- [[用户画像]]',
      `- [[${input.day}]]`,
      '',
    ].join('\n')
    writeFileSync(path, composeMarkdown({
      type: 'ai-memory-session',
      session: input.sessionSeg,
      session_title: oneLine(input.title ?? '', 120),
      updated: timeStamp(input.now),
      date: input.day,
      tags: ['记忆', '会话'],
    }, body), 'utf8')
    // 早期版本对 `session-` 前缀没做归一,可能留下 `session-session-xxx.md`;
    // 写入正确文件后顺手清掉那份旧页,免得 Obsidian 图谱里出现重复节点。
    const legacy = join(dir, `session-${name}`)
    if (existsSync(legacy)) {
      try {
        rmSync(legacy)
      } catch {
        // 删不掉不影响新页。
      }
    }
    return this.relativeOf(path)
  }

  /** 每日时间线:按天聚合当天所有写入,Obsidian 日记视图友好。 */
  #appendDaily(day, now, input, written) {
    const path = join(this.root, LAYOUT.daily, `${day}.md`)
    const existing = readIfExists(path)
    const head = existing === undefined
      ? composeMarkdown({ type: 'ai-memory-daily', date: day, tags: ['记忆', '时间线'] }, `# ${day}\n\n`)
      : existing
    const block = [
      `## ${timeStamp(now)} · ${oneLine(input.sessionTitle ?? input.sessionId ?? '会话', 40)}`,
      '',
      ...written.map((entry) => `- [[${entry.title}]] — ${entry.kind}`),
      '',
    ].join('\n')
    writeFileSync(path, `${head.trimEnd()}\n\n${block}`, 'utf8')
    return this.relativeOf(path)
  }

  /**
   * 画像增量合并。
   *
   * 语义是"刷新",不是"追加":
   * - 模型给出同名分节时,**替换**旧内容(它看到的是全窗信息,比旧的更准),
   *   否则每次写入都会在同一分节下堆一段话,画像会越来越长越来越乱。
   * - 模型没提到的分节保留原样(那是用户手写或更早积累的内容)。
   * - `相关` 这类插件自己维护的分节每次重建,不参与合并。
   */
  #mergeProfile(profile, now) {
    const path = join(this.root, LAYOUT.profile, 'user-profile.md')
    const existing = readIfExists(path)
    const incoming = normaliseSections(profile)
    const current = existing === undefined ? new Map() : new Map(sectionMap(extractBody(existing)))
    current.delete('相关')
    for (const [name, text] of incoming) {
      const clean = text.trim()
      if (clean === '') continue
      current.set(name, clean)
    }
    const body = [
      '# 用户画像',
      '',
      `> 由 dsh-ai-memory-ob 增量维护,最近更新 ${timeStamp(now)}。可以直接在 Obsidian 里改写,下次写入会在此基础上合并。`,
      '',
      ...[...current.entries()].flatMap(([name, text]) => [`## ${name}`, '', text.trim(), '']),
      '## 相关',
      `- [[${dateStamp(now)}]]`,
      '',
    ].join('\n')
    writeFileSync(path, composeMarkdown({
      type: 'ai-memory-profile',
      updated: timeStamp(now),
      date: dateStamp(now),
      tags: ['记忆', '画像'],
    }, body), 'utf8')
    return this.relativeOf(path)
  }

  /** 当日图谱 MOC:列出当天条目并连到会话页与画像页。 */
  #writeGraphDay(day, now) {
    const dir = join(this.root, LAYOUT.graph)
    const files = listFiles(join(this.root, LAYOUT.memories)).filter((name) => name.startsWith(day))
    const sessions = new Set()
    const kinds = new Map()
    const rows = []
    for (const name of files) {
      const text = readIfExists(join(this.root, LAYOUT.memories, name))
      if (text === undefined) continue
      const { fields } = parseFrontmatter(text)
      const title = fields.title ?? name.replace(/\.md$/, '')
      const kind = String(fields.kind ?? 'note')
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
      if (fields.session) sessions.add(String(fields.session))
      rows.push(`- [[${title}]] · ${kind} · ${fields.session ? `[[session-${fields.session}\\|会话]]` : '—'}`)
    }
    const body = [
      `# ${day} · 记忆图谱`,
      '',
      '## 今日条目',
      ...(rows.length > 0 ? rows : ['- 今天还没有写入。']),
      '',
      '## 会话',
      ...[...sessions].map((session) => `- [[session-${session}]]`),
      '',
      '## 分类',
      ...[...kinds.entries()].map(([kind, count]) => `- ${kind}: ${count}`),
      '',
      '## 关联',
      '- [[用户画像]]',
      `- [[${day}]]`,
      '',
    ].join('\n')
    writeFileSync(join(dir, `${day}.md`), composeMarkdown({
      type: 'ai-memory-graph',
      date: day,
      updated: timeStamp(now),
      tags: ['记忆', '图谱'],
    }, body), 'utf8')
  }

  /** 库级图谱索引文本(注入上下文用的极小摘要)。 */
  #graphIndexText() {
    const dir = join(this.root, LAYOUT.graph)
    const names = listFiles(dir).filter((name) => name.endsWith('.md')).sort().reverse().slice(0, 3)
    if (names.length === 0) return ''
    return names.map((name) => `- ${name.replace(/\.md$/, '')} → graph/${name}`).join('\n')
  }
}

/** 从 Markdown 里去掉 frontmatter,取正文。 */
export function extractBody(text) {
  return parseFrontmatter(text).body
}

/**
 * 取一段"摘要级"正文:去掉标题、引用行(采集时间那种噪声)、空行和纯链接行,
 * 返回第一段有信息量的文字。注入摘要靠它,避免把噪声也塞进上下文。
 */
export function summaryOf(text) {
  const body = extractBody(text)
  const lines = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line === '') {
      if (lines.length > 0) break
      continue
    }
    if (line.startsWith('#') || line.startsWith('>') || line.startsWith('- [[') || line.startsWith('|')) continue
    if (line.startsWith('- 采集于') || line.startsWith('- 会话 id') || line.startsWith('- 最近更新')) continue
    lines.push(line)
  }
  const joined = lines.join(' ').replace(/\s+/g, ' ').trim()
  return joined !== '' ? joined : oneLine(body.replace(/[#>\-|]/g, ' '), 160)
}

/** 会话页链接名(文件名去 .md)。 */
export function sessionLinkName(sessionSeg) {
  return `session-${sessionSeg}`
}

/**
 * 会话 id → 库内使用的稳定片段。
 *
 * 调用方有的传 `session-<uuid>`,有的传裸 `<uuid>`;这里统一剥掉前缀,
 * 存进库里的永远是裸片段,页面文件名再统一加回 `session-`。
 * 这样无论入口怎么传,同一个会话都只会有**一个**会话页。
 */
export function canonicalSessionSeg(sessionId) {
  const raw = safeSeg(sessionId ?? 'session', 'session')
  return raw.startsWith('session-') ? safeSeg(raw.slice('session-'.length), 'session') : raw
}

/** 两位数字。 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 解析 `- 2026-10-26 · [[标题]] (memories/x.md)` 这种行。 */
function parseBulletLinks(body) {
  const out = []
  for (const line of String(body ?? '').split('\n')) {
    const match = /^-\s+(\d{4}-\d{2}-\d{2})\s+·\s+\[\[([^\]]+)\]\](?:\s+\(([^)]+)\))?/.exec(line.trim())
    if (match === null) continue
    out.push({ date: match[1], title: match[2], file: match[3] ?? '' })
  }
  return out
}

/** 按文件去重。 */
function dedupeByFile(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = item.file !== '' ? item.file : item.title
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** 把画像补丁归一成 `[名字, 文本]`。 */
function normaliseSections(profile) {
  const out = []
  if (typeof profile === 'string') {
    if (profile.trim() !== '') out.push(['概览', profile])
    return out
  }
  if (Array.isArray(profile)) {
    for (const section of profile) {
      if (section && typeof section.name === 'string' && typeof section.text === 'string') {
        out.push([section.name.trim(), section.text])
      }
    }
    return out
  }
  if (profile && typeof profile === 'object') {
    for (const [name, value] of Object.entries(profile)) {
      if (typeof value === 'string') out.push([String(name).trim(), value])
      else if (Array.isArray(value)) out.push([String(name).trim(), value.map((item) => `- ${String(item)}`).join('\n')])
    }
  }
  return out
}

/** 拆出 `## 分节` → 文本。 */
function sectionMap(body) {
  const map = new Map()
  let current = null
  let buffer = []
  const flush = () => {
    if (current !== null) map.set(current, buffer.join('\n').trim())
    buffer = []
  }
  for (const line of String(body ?? '').split('\n')) {
    if (line.startsWith('## ')) {
      flush()
      current = line.slice(3).trim()
      continue
    }
    if (line.startsWith('# ')) continue
    buffer.push(line)
  }
  flush()
  return map
}
