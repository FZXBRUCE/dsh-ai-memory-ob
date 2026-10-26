/**
 * dsh-ai-memory-ob — 宿主侧记忆服务。
 *
 * 一个服务对象承载全部操作,命令、工具、设置页、注入都走同一条实现,
 * 保证"UI 做的"和"模型做的"是同一件事。
 *
 * 只依赖宿主已注册的服务,全部按可选方式取用:
 *   sessionQuery  读会话日志(现场/冷存都能读)
 *   llm           归纳
 *   agentDefaultModel  没显式配置模型时取默认
 *   webServer     给前端提供只读的库浏览接口
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { foldConversation, renderConversationDigest } from './digest.js'
import { loadSettings, saveSettings, vaultRoot } from './settings.js'
import { summarizeConversation, summarizeGraph, summarizeVault } from './summarize.js'
import { canonicalSessionSeg, extractBody, MemoryVault, parseFrontmatter, summaryOf } from './vault.js'
import { dateStamp, oneLine, truncate } from './util.js'

/** 注入块的名字(系统提示里显示的标题)。 */
const SECTION_NAME = 'plugin:dsh-ai-memory-ob'
/** 注入块的位置:排在插件提示带里,靠前但不抢人格与工具说明。 */
const SECTION_ORDER = 120
/** 单次会话摘要最多看多少条事件。 */
const MAX_EVENTS = 6000

/** 从 agent 上尽量安全地取会话对象。 */
function sessionOf(agent) {
  try {
    return agent?.session
  } catch {
    return undefined
  }
}

/** 会话标题(读不到就退化成 id)。 */
async function titleOf(ctx, sessionId, agent) {
  const query = ctx.get('sessionQuery')
  if (query !== undefined && typeof query.readTitleSnapshot === 'function') {
    try {
      const snapshot = await query.readTitleSnapshot(sessionId)
      const title = snapshot?.title?.title ?? snapshot?.titleSnapshot?.title
      if (typeof title === 'string' && title.trim() !== '') return title.trim()
    } catch {
      // 落回下面的兜底。
    }
  }
  if (query !== undefined && typeof query.readTitle === 'function') {
    try {
      const snapshot = await query.readTitle(sessionId)
      const title = snapshot?.title?.title ?? snapshot?.title
      if (typeof title === 'string' && title.trim() !== '') return title.trim()
    } catch {
      // 落回下面的兜底。
    }
  }
  // 兜底 1:会话目录里的标题投影(不需要激活 agent)。
  const sessions = ctx.get('sessions')
  try {
    const snapshot = sessions?.list?.getSnapshot?.()
    const row = snapshot?.byId?.[sessionId]
    const projected = row?.title ?? row?.projections?.title?.title
    if (typeof projected === 'string' && projected.trim() !== '') return projected.trim()
  } catch {
    // 继续兜底。
  }
  const live = sessionOf(agent)
  const fromHeader = live?.header?.title
  return typeof fromHeader === 'string' && fromHeader.trim() !== '' ? fromHeader.trim() : String(sessionId)
}

/** 读会话事件(sessionQuery 优先,退到活的 session 对象)。 */
async function eventsOf(ctx, sessionId, agent) {
  const query = ctx.get('sessionQuery')
  if (query !== undefined && typeof query.readSession === 'function') {
    try {
      const snapshot = await query.readSession(sessionId)
      if (Array.isArray(snapshot?.events)) return snapshot.events.slice(-MAX_EVENTS)
    } catch {
      // 落回活会话。
    }
  }
  const live = sessionOf(agent)
  if (live !== undefined && typeof live.ownEvents === 'function') {
    try {
      return live.ownEvents().slice(-MAX_EVENTS)
    } catch {
      return []
    }
  }
  return []
}

/** 解析归纳用的模型:`设置 > 会话请求头 > 默认选择`。 */
function resolveModel(ctx, settings, agent) {
  const explicit = settings.model
  if (explicit !== '') {
    const slash = explicit.indexOf('/')
    if (slash > 0) return { provider: explicit.slice(0, slash), model: explicit.slice(slash + 1) }
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection !== undefined) return { provider: selection.provider, model: explicit }
  }
  const live = sessionOf(agent)
  try {
    const header = live?.requestHeader?.()
    const config = header?.config
    if (config !== undefined && typeof config.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  } catch {
    // 继续用默认。
  }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
    return { provider: selection.provider, model: selection.model }
  }
  return undefined
}

/** 记忆服务。 */
export class MemoryService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {() => void} log
   */
  constructor(ctx, log = () => {}) {
    this.ctx = ctx
    this.log = log
    this.cachedSettings = loadSettings()
    this.vault = new MemoryVault(vaultRoot(this.cachedSettings), log)
    /** 自动写入的进行中标记,避免同一会话并发两次归纳。 */
    this.busy = new Set()
    /** 每个会话当前的记忆上下文文本(提示上下文提供者读这里)。 */
    this.snapshots = new Map()
  }

  /** 设置(内存里带缓存,写盘后刷新)。 */
  get settings() {
    return this.cachedSettings
  }

  /** 重新读盘(设置页保存后调用)。 */
  reload() {
    this.cachedSettings = loadSettings()
    this.vault = new MemoryVault(vaultRoot(this.cachedSettings), this.log)
    return this.cachedSettings
  }

  /** 保存设置。 */
  update(patch) {
    this.cachedSettings = saveSettings(patch)
    this.vault = new MemoryVault(vaultRoot(this.cachedSettings), this.log)
    return this.cachedSettings
  }

  /** 状态(设置页 / 命令回显)。 */
  status() {
    this.vault.ensureLayout()
    return {
      settings: this.cachedSettings,
      vault: this.vault.stats(),
      model: this.#modelLabel(),
    }
  }

  #modelLabel() {
    const model = resolveModel(this.ctx, this.settings)
    return model === undefined ? '(跟随会话)' : `${model.provider}/${model.model}`
  }

  /**
   * 读取记忆并把它变成"这个会话的常驻上下文"。
   *
   * 不构造消息、不写 inbox:记忆作为该 agent 作用域的提示上下文注册,
   * 框架在每一步组装时自己带上。这样既不会打断会话流,也不会因为
   * 手工构造消息而和宿主的消息模型对不上。
   *
   * @param {object} agent 目标 agent
   * @param {{recent?: number, from?: string, to?: string}} options
   */
  async load(agent, options = {}) {
    const sessionId = String(agent?.id ?? '')
    const session = sessionOf(agent)
    const settings = this.settings
    this.vault.ensureLayout()
    const title = await titleOf(this.ctx, sessionId, agent)
    const recent = Number.isFinite(options.recent) ? options.recent : settings.injectRecent
    const digest = this.vault.composeContextDigest({
      recent,
      profile: settings.injectProfile,
      zips: settings.injectZips,
      zipShareAll: settings.zipShareAll,
      session: sessionKey(sessionId, session),
    })
    const ranged = options.from !== undefined || options.to !== undefined
      ? this.vault.selectFiles({ from: options.from, to: options.to, limit: Math.max(recent, 20) })
      : undefined
    const text = this.#renderInjection({
      title,
      sessionId,
      digest,
      ranged,
      budget: settings.injectBudgetChars,
      stats: this.vault.stats(),
    })
    this.snapshots.set(sessionId, { text, at: Date.now() })
    const delivered = this.hasSnapshot(sessionId)
    return { text, delivered, vault: this.vault.stats(), entries: this.vault.stats().entries }
  }

  /** 该会话当前是否有可用的记忆上下文。 */
  hasSnapshot(sessionId) {
    const snapshot = this.snapshots.get(sessionId)
    return snapshot !== undefined && snapshot.text.trim() !== ''
  }

  /** 该会话的记忆上下文文本(提示上下文提供者调用)。 */
  snapshotText(sessionId) {
    return this.snapshots.get(sessionId)?.text ?? ''
  }

  /** 把一段提示追加进该会话的记忆上下文(自动归档通知用)。 */
  appendSnapshot(sessionId, text) {
    if (text.trim() === '') return
    const current = this.snapshots.get(sessionId)
    this.snapshots.set(sessionId, {
      text: current === undefined ? text : `${current.text}\n\n${text}`,
      at: Date.now(),
    })
  }

  /** 会话结束:丢掉上下文(库里已经落盘了)。 */
  forget(sessionId) {
    this.snapshots.delete(sessionId)
  }

  /**
   * 把当前会话写进记忆库。
   * @param {object} agent
   * @param {{trigger?: 'command'|'auto'|'new', all?: boolean}} options
   */
  async write(agent, options = {}) {
    const sessionId = String(agent?.id ?? '')
    const session = sessionOf(agent)
    if (this.busy.has(sessionId)) {
      return { ok: false, reason: 'busy', text: '这个会话正在写入记忆,请稍候再试。' }
    }
    this.busy.add(sessionId)
    try {
      const settings = this.settings
      const title = await titleOf(this.ctx, sessionId, agent)
      const events = await eventsOf(this.ctx, sessionId, agent)
      const fromSeq = options.all === true ? 0 : this.vault.cursorOf(sessionId)
      const folded = foldConversation(events, { fromSeq })
      if (folded.isEmpty) {
        return {
          ok: false,
          reason: 'empty',
          text: fromSeq > 0
            ? '自上次写入以来没有新的对话内容,记忆库未改动。'
            : '这个会话还没有可写入的内容。',
        }
      }
      const digest = renderConversationDigest(folded, { maxTurns: 60, includeTools: settings.includeToolDigest === true })
      const model = resolveModel(this.ctx, settings, agent)
      if (model === undefined) {
        return { ok: false, reason: 'no-model', text: '找不到可用的模型来归纳这次对话,请先在设置里指定模型。' }
      }
      const summary = await summarizeConversation(this.ctx, {
        provider: model.provider,
        model: model.model,
        digest,
        sessionId,
        sessionTitle: title,
        existingEntries: this.vault.stats().entries,
      })
      const entries = (Array.isArray(summary.entries) ? summary.entries : [])
        .slice(0, settings.writeMaxEntries)
        .map((entry) => ({
          title: oneLine(entry?.title ?? '', 60),
          kind: typeof entry?.kind === 'string' ? entry.kind : 'note',
          text: typeof entry?.text === 'string' ? entry.text : '',
          tags: Array.isArray(entry?.tags) ? entry.tags.slice(0, 6) : [],
          links: Array.isArray(entry?.links) ? entry.links.slice(0, 8) : [],
          sourceSeq: typeof entry?.sourceSeq === 'number' ? entry.sourceSeq : undefined,
        }))
        .filter((entry) => entry.text.trim() !== '')
      if (entries.length === 0) {
        return { ok: false, reason: 'no-entries', text: '模型没有归纳出值得长期保留的内容,记忆库未改动。' }
      }
      const written = this.vault.writeEntries({
        sessionId: sessionKey(sessionId, session),
        sessionTitle: title,
        entries,
        profile: summary.profile,
        // 整窗重写:以窗口为单位替换旧条目,避免模型换标题后留下同义重复。
        replaceSession: options.all === true,
      })
      this.vault.commitCursor(sessionId, folded.lastSeq ?? fromSeq, 0)
      this.vault.resetTurns(sessionId)
      const lines = [
        `已写入记忆库:${written.written.length} 条`,
        ...(written.retired.length > 0 ? [`- 替换了该窗口的旧条目 ${written.retired.length} 条`] : []),
        `- 库:${written.root}`,
        `- 会话页:${written.sessionNote}`,
        `- 时间线:${written.dailyNote}`,
        ...(written.profileNote !== undefined ? [`- 画像:${written.profileNote}`] : []),
        '',
        ...written.written.map((entry) => `- ${entry.title} (${entry.kind})`),
      ]
      if (summary.summary !== '') lines.splice(1, 0, `摘要:${summary.summary}`)
      return { ok: true, written, text: lines.join('\n') }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(`write failed: ${message}`)
      return { ok: false, reason: 'error', text: `写入失败:${message}` }
    } finally {
      this.busy.delete(sessionId)
    }
  }

  /** 计一轮,达到阈值时自动写入(由 turn 结束事件驱动)。 */
  async tick(agent) {
    const settings = this.settings
    if (settings.autoWriteMode !== 'turns') return
    const sessionId = String(agent?.id ?? '')
    const turns = this.vault.bumpTurns(sessionId)
    if (turns < settings.autoWriteTurns) return
    if (this.busy.has(sessionId)) return
    const result = await this.write(agent, { trigger: 'auto' })
    if (result.ok !== true) {
      this.log(`auto write skipped: ${result.reason ?? 'unknown'}`)
      return
    }
    // 写入完成后把"已归档"提示挂进该会话的记忆上下文,下一次组装自动带上。
    this.appendSnapshot(sessionId, `<ai-memory>本轮对话已自动归档:${result.written.written.length} 条 → ${result.written.sessionNote}</ai-memory>`)
  }

  /** /update:读全库 + 重建索引 + 让模型连关系图谱。 */
  async updateGraph() {
    const stats = this.vault.stats()
    const rebuilt = this.vault.rebuildIndex()
    const catalog = (this.vault.index.catalog ?? []).slice(0, 400)
    if (catalog.length === 0) {
      return { ok: true, text: `记忆库还是空的(${this.vault.root})。先用 /write 写一次,再 /update 连图谱。`, rebuilt }
    }
    const model = resolveModel(this.ctx, this.settings)
    let graph = { themes: [], edges: [], hub: [], degraded: true }
    if (model !== undefined) {
      try {
        graph = await summarizeGraph(this.ctx, {
          provider: model.provider,
          model: model.model,
          entryCount: catalog.length,
          catalog: catalog
            .map((entry) => `- ${entry.title} | ${entry.kind} | ${entry.date} | 链接:${(entry.links ?? []).join(',') || '无'}`)
            .join('\n'),
        })
      } catch (error) {
        this.log(`graph summary failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const note = this.#writeGraphIndex(graph, catalog)
    return {
      ok: true,
      rebuilt,
      graph,
      note,
      text: [
        `记忆库已全量读取:${stats.entries} 条 / ${(stats.bytes / 1024).toFixed(1)} KB`,
        `图谱索引:${note}`,
        graph.themes.length > 0 ? `主题:${graph.themes.length} 个` : '主题:未生成(模型不可用或为空)',
        graph.edges.length > 0 ? `连边:${graph.edges.length} 条` : '连边:未生成',
        graph.hub.length > 0 ? `入口:${graph.hub.slice(0, 5).join('、')}` : '',
        '',
        '在 Obsidian 里打开库根目录即可看到关系图谱。',
      ].filter((line) => line !== '').join('\n'),
    }
  }

  /** /zip:把一段记忆压成新文件(源文件不动)。 */
  async zip(agent, options = {}) {
    const sessionId = String(agent?.id ?? '')
    const session = sessionOf(agent)
    const settings = this.settings
    const scope = options.scope === 'vault' ? 'vault' : options.scope === 'range' ? 'range' : 'session'
    const query = scope === 'session'
      ? { session: sessionKey(sessionId, session), limit: 200 }
      : { from: options.from, to: options.to, limit: 200 }
    const selected = this.vault.selectFiles(query)
    if (selected.files.length === 0) {
      return { ok: false, reason: 'empty', text: '没有可压缩的记忆条目。先用 /write 写一次。' }
    }
    const material = selected.files
      .map((file) => `--- 文件: ${file.file}\n${truncate(extractBody(file.text), 6000)}`)
      .join('\n\n')
    const model = resolveModel(this.ctx, settings)
    if (model === undefined) {
      return { ok: false, reason: 'no-model', text: '找不到可用模型来做压缩,请先在设置里指定模型。' }
    }
    const scopeLabel = scope === 'session'
      ? `会话 ${sessionId}`
      : scope === 'range'
        ? `${options.from ?? '最早'} ~ ${options.to ?? '现在'}`
        : '整个记忆库'
    const compressed = await summarizeVault(this.ctx, {
      provider: model.provider,
      model: model.model,
      material,
      scopeLabel,
      entryCount: selected.files.length,
      fileCount: selected.files.length,
    })
    const result = this.#writeZip({
      sessionId: sessionKey(sessionId, session),
      scope,
      scopeLabel,
      compressed,
      sources: selected.files.map((file) => file.file),
    })
    return {
      ok: true,
      ...result,
      text: [
        `已生成压缩记忆:${result.file}`,
        `覆盖 ${selected.files.length} 条原始记忆(源文件未改动)`,
        compressed.degraded ? '注意:模型输出不是结构化 JSON,已按原文保存。' : '',
        `跨窗口共享:${settings.zipShareAll ? '开' : '关(仅本窗口可见)'}`,
      ].filter((line) => line !== '').join('\n'),
    }
  }

  /** /new:扫描历史会话,重建整库。 */
  async rebuild(options = {}) {
    const settings = this.settings
    const model = resolveModel(this.ctx, settings)
    if (model === undefined) {
      return { ok: false, reason: 'no-model', text: '找不到可用模型,无法重建记忆库。' }
    }
    const query = this.ctx.get('sessionQuery')
    if (query === undefined || typeof query.listSessions !== 'function') {
      return { ok: false, reason: 'no-service', text: '宿主没有提供会话查询服务,无法读取历史窗口。' }
    }
    const records = await query.listSessions()
    const candidates = (Array.isArray(records) ? records : [])
      .filter((record) => record?.header?.origin !== 'subagent')
      .sort((left, right) => Number(right.header?.createdAt ?? 0) - Number(left.header?.createdAt ?? 0))
      .slice(0, settings.newMaxSessions)
    const report = []
    for (const record of candidates) {
      const sessionId = String(record.header?.id ?? '')
      if (sessionId === '') continue
      const events = await eventsOf(this.ctx, sessionId, undefined)
      const folded = foldConversation(events, { fromSeq: 0 })
      if (folded.isEmpty) continue
      const title = await titleOf(this.ctx, sessionId, undefined)
      try {
        const summary = await summarizeConversation(this.ctx, {
          provider: model.provider,
          model: model.model,
          digest: renderConversationDigest(folded, { maxTurns: 80 }),
          sessionId,
          sessionTitle: title,
          existingEntries: this.vault.stats().entries,
        })
        const entries = (Array.isArray(summary.entries) ? summary.entries : [])
          .slice(0, settings.writeMaxEntries)
          .map((entry) => ({
            title: oneLine(entry?.title ?? '', 60),
            kind: typeof entry?.kind === 'string' ? entry.kind : 'note',
            text: typeof entry?.text === 'string' ? entry.text : '',
            tags: Array.isArray(entry?.tags) ? entry.tags.slice(0, 6) : [],
            links: Array.isArray(entry?.links) ? entry.links.slice(0, 8) : [],
          }))
          .filter((entry) => entry.text.trim() !== '')
        if (entries.length === 0) continue
        this.vault.writeEntries({
          sessionId,
          sessionTitle: title,
          entries,
          profile: summary.profile,
        })
        this.vault.commitCursor(sessionId, folded.lastSeq ?? 0, 0)
        report.push({ sessionId, title, entries: entries.length })
      } catch (error) {
        report.push({ sessionId, title, error: error instanceof Error ? error.message : String(error) })
      }
    }
    const graph = await this.updateGraph()
    return {
      ok: true,
      sessions: report,
      graph,
      text: [
        `重建完成:处理 ${report.length} 个会话`,
        ...report.map((item) => `- ${item.title ?? item.sessionId}: ${item.error ?? `${item.entries} 条`}`),
        '',
        graph.text,
      ].join('\n'),
    }
  }

  /** 只读文件树(设置页浏览用)。 */
  tree(relPath = '') {
    const target = relPath === '' ? this.vault.root : this.vault.resolveInside(relPath)
    const entries = []
    let names = []
    try {
      names = readdirSync(target)
    } catch {
      return { path: relPath, entries }
    }
    for (const name of names) {
      if (name.startsWith('.') && relPath === '') continue
      const full = join(target, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      entries.push({
        name,
        path: this.vault.relativeOf(full),
        dir: stat.isDirectory(),
        size: stat.isDirectory() ? 0 : stat.size,
      })
    }
    entries.sort((left, right) => Number(right.dir) - Number(left.dir) || left.name.localeCompare(right.name))
    return { path: relPath, entries }
  }

  /** 读一个文件(设置页预览 / 导出前确认)。 */
  read(relPath) {
    const full = this.vault.resolveInside(relPath)
    if (!existsSync(full)) return { ok: false, error: 'not-found' }
    const text = readFileSync(full, 'utf8')
    return { ok: true, path: relPath, text: truncate(text, 200_000) }
  }

  /**
   * 导出一份单文件图谱(Obsidian 之外也能看)。
   *
   * 直接扫 `memories/` 而不是读索引缓存:缓存可能还没重建,而导出的东西
   * 是给用户拿走的,不能因为缓存状态就导出一份空图。
   */
  exportGraph() {
    this.vault.ensureLayout()
    const entries = this.vault.selectFiles({ limit: 4000 }).files.map((file) => ({
      title: file.title, kind: file.kind, date: file.date, links: file.links, file: file.file,
    }))
    const nodes = entries.map((entry) => ({
      id: String(entry.title),
      kind: String(entry.kind ?? 'note'),
      date: String(entry.date ?? ''),
      file: String(entry.file ?? ''),
    }))
    const edges = []
    const known = new Set(nodes.map((node) => node.id))
    for (const entry of entries) {
      for (const link of entry.links ?? []) {
        if (!known.has(String(link))) continue
        edges.push({ from: String(entry.title), to: String(link), kind: 'link' })
      }
    }
    const path = join(this.vault.root, 'graph', 'graph-export.json')
    mkdirSync(join(this.vault.root, 'graph'), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ generatedAt: new Date().toISOString(), nodes, edges }, null, 2)}\n`, 'utf8')
    return { path, nodes: nodes.length, edges: edges.length }
  }

  // ---------------------------------------------------------------- 内部

  /** 渲染注入块。 */
  #renderInjection(input) {
    const lines = [
      '<ai-memory>',
      `记忆库:${this.vault.root}(${input.stats.entries} 条)`,
      '这是用户长期记忆库的摘录,用于延续前几轮对话的上下文;当它和用户当前的话冲突时,以用户当前的话为准。',
      '',
    ]
    if (input.ranged !== undefined) {
      lines.push(`## 指定区间记忆(${input.ranged.total} 条)`, '')
      for (const file of input.ranged.files) {
        lines.push(`- ${file.date} · ${file.title} — ${oneLine(summaryOf(file.text), 160)}`)
      }
      lines.push('')
    }
    if (input.digest !== '') lines.push(input.digest, '')
    lines.push('命令:/load 重新读取 · /write 立刻归档本窗 · /update 重建图谱 · /zip 压缩 · /new 重建整库', '</ai-memory>')
    return truncate(lines.join('\n'), input.budget)
  }

  /** 写图谱索引页(主题 + 连边 + 入口)。 */
  #writeGraphIndex(graph, catalog) {
    const day = dateStamp()
    const path = join(this.vault.root, 'graph', 'graph-index.md')
    const themeBlocks = (graph.themes ?? []).map((theme) => {
      const name = String(theme?.name ?? '主题')
      const members = Array.isArray(theme?.entries) ? theme.entries.map(String) : []
      return [`### ${name}`, '', String(theme?.text ?? ''), '', ...members.map((title) => `- [[${title}]]`), ''].join('\n')
    })
    const edgeLines = (graph.edges ?? [])
      .filter((edge) => edge && typeof edge.from === 'string' && typeof edge.to === 'string')
      .map((edge) => `- [[${edge.from}]] ↔ [[${edge.to}]] — ${oneLine(edge.why ?? '', 80)}`)
    const body = [
      '# 记忆图谱索引',
      '',
      `> 由 /update 生成于 ${day} · 条目 ${catalog.length} 个`,
      '',
      '## 入口',
      ...((graph.hub ?? []).length > 0 ? graph.hub.map((title) => `- [[${title}]]`) : ['- (未生成)']),
      '',
      '## 主题',
      ...(themeBlocks.length > 0 ? themeBlocks : ['(未生成)']),
      '',
      '## 连边',
      ...(edgeLines.length > 0 ? edgeLines : ['(未生成)']),
      '',
      '## 全部条目',
      ...catalog.map((entry) => `- [[${entry.title}]] · ${entry.kind} · ${entry.date}`),
      '',
      '## 关联',
      `- [[${day}]]`,
      '- [[用户画像]]',
      '',
    ].join('\n')
    writeFileSync(path, [
      '---',
      'type: "ai-memory-graph-index"',
      `date: "${day}"`,
      `entries: ${catalog.length}`,
      'tags: ["记忆", "图谱"]',
      '---',
      '',
      body,
    ].join('\n'), 'utf8')
    return this.vault.relativeOf(path)
  }

  /** 写压缩记忆文件。 */
  #writeZip(input) {
    const now = new Date()
    const day = dateStamp(now)
    const base = `${day} ${input.scope === 'session' ? '会话压缩' : input.scope === 'range' ? '区间压缩' : '全库压缩'}`
    const fileName = `${base}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}.md`
    const path = join(this.vault.root, 'zips', fileName)
    mkdirSync(join(this.vault.root, 'zips'), { recursive: true })
    const compressed = input.compressed
    const body = [
      `# ${compressed.title || base}`,
      '',
      `> 压缩范围:${input.scopeLabel} · 覆盖 ${input.sources.length} 个源文件(源文件保持不动)`,
      '',
      '## 回顾',
      '',
      compressed.overview || '(无)',
      '',
      '## 线索',
      ...((compressed.threads ?? []).length > 0
        ? compressed.threads.flatMap((thread) => [`### ${thread?.name ?? '线索'}`, '', String(thread?.text ?? ''), ''])
        : ['(无)', '']),
      '## 关键决定',
      ...((compressed.decisions ?? []).length > 0 ? compressed.decisions.map((line) => `- ${line}`) : ['- (无)']),
      '',
      '## 未解决',
      ...((compressed.open ?? []).length > 0 ? compressed.open.map((line) => `- ${line}`) : ['- (无)']),
      '',
      '## 关联',
      ...((compressed.links ?? []).length > 0 ? compressed.links.map((title) => `- [[${title}]]`) : []),
      `- [[用户画像]]`,
      '',
      '## 源文件',
      ...input.sources.map((file) => `- ${file}`),
      '',
    ].join('\n')
    writeFileSync(path, [
      '---',
      'type: "ai-memory-zip"',
      `title: ${JSON.stringify(String(compressed.title ?? base))}`,
      `session: ${JSON.stringify(input.sessionId)}`,
      `scope: ${JSON.stringify(input.scope)}`,
      `date: "${day}"`,
      `created: ${JSON.stringify(now.toISOString())}`,
      `sources: ${JSON.stringify(input.sources.length)}`,
      'tags: ["记忆", "压缩"]',
      '---',
      '',
      body,
    ].join('\n'), 'utf8')
    return { file: this.vault.relativeOf(path), title: compressed.title || base }
  }
}

/** 会话在库里的稳定 key(裸片段,和落盘一致)。 */
export function sessionKey(sessionId, session) {
  const fromHeader = (() => {
    try {
      const id = session?.header?.id
      return typeof id === 'string' ? id : undefined
    } catch {
      return undefined
    }
  })()
  return canonicalSessionSeg(fromHeader ?? sessionId ?? 'session')
}

/** 记忆库的 Obsidian 打开路径(状态里展示)。 */
export function vaultOpenHint(root) {
  return `用 Obsidian 打开文件夹:${root}`
}

export { SECTION_NAME, SECTION_ORDER }
