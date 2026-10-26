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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foldConversation, renderConversationDigest } from './digest.js'
import { KIND_LABEL, normaliseEntry, RELATION_LABEL } from './entry.js'
import { loadSettings, saveSettings, vaultRoot } from './settings.js'
import { summarizeConversation, summarizeGraph, summarizeVault, parseJsonLoose } from './summarize.js'
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
    /**
     * 会话级开关覆盖表:sessionId → boolean。
     * 没有条目时跟随 settings.defaultSessionEnabled。
     * 用户点输入框下方那个小按钮就是在改这里,不写盘(重启后回到默认),
     * 因为"这个会话要不要记"是一次性决定,不该污染全局设置。
     */
    this.sessionOverrides = new Map()
  }

  // ---------------------------------------------------------------- 会话开关

  /** 这个会话当前是否启用了记忆功能。 */
  isSessionEnabled(sessionId) {
    const id = String(sessionId ?? '')
    if (id === '') return this.cachedSettings.defaultSessionEnabled === true
    if (this.sessionOverrides.has(id)) return this.sessionOverrides.get(id) === true
    return this.cachedSettings.defaultSessionEnabled === true
  }

  /** 该会话的开关是否被用户手动覆盖过。 */
  isSessionOverridden(sessionId) {
    return this.sessionOverrides.has(String(sessionId ?? ''))
  }

  /**
   * 设置会话开关。关闭时立刻丢掉该会话的记忆快照,
   * 让下一次组装提示时不再带记忆(立即生效,不用等重启)。
   */
  setSessionEnabled(sessionId, enabled) {
    const id = String(sessionId ?? '')
    if (id === '') return false
    this.sessionOverrides.set(id, enabled === true)
    if (enabled !== true) this.snapshots.delete(id)
    return true
  }

  /** 清掉手动覆盖,回到默认值。 */
  clearSessionOverride(sessionId) {
    const id = String(sessionId ?? '')
    const had = this.sessionOverrides.delete(id)
    if (had) this.snapshots.delete(id)
    return had
  }

  /** 该会话的开关状态摘要(前端按钮 + 设置页共用)。 */
  sessionState(sessionId) {
    const id = String(sessionId ?? '')
    return {
      sessionId: id,
      enabled: this.isSessionEnabled(id),
      overridden: this.isSessionOverridden(id),
      hasSnapshot: this.hasSnapshot(id),
    }
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
      version: this.#currentVersion(),
      repo: this.#repoSlug(),
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
   * @param {{recent?: number, from?: string, to?: string, force?: boolean}} options
   *   force = 用户显式执行 /load,即使会话开关关着也照做。
   */
  async load(agent, options = {}) {
    const sessionId = String(agent?.id ?? '')
    const session = sessionOf(agent)
    const settings = this.settings
    // 关掉的会话不自动注入;但用户手打 /load 是明确意图,force 时照做。
    if (options.force !== true && !this.isSessionEnabled(sessionId)) {
      return { text: '', delivered: false, skipped: 'disabled', vault: this.vault.stats(), entries: this.vault.stats().entries }
    }
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
      grounding: settings.injectGroundingHint === true,
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

  /** 会话结束:丢掉上下文快照(库里已经落盘了)。 */
  dropSnapshot(sessionId) {
    this.snapshots.delete(String(sessionId ?? ''))
  }

  /**
   * 现有条目目录(给模型判断重复/推翻用)。
   * 只给标题、主张、实体,不给正文 —— 够判断,又不撑爆提示词。
   */
  #existingCatalog(limit) {
    const selected = this.vault.selectFiles({ limit })
    if (selected.files.length === 0) return ''
    return selected.files
      .map((file) => {
        const fields = parseFrontmatter(file.text).fields
        const claim = typeof fields.claim === 'string' ? fields.claim : ''
        const entities = Array.isArray(fields.entities) ? fields.entities : []
        const head = `- ${file.title}`
        const parts = [head]
        if (claim !== '') parts.push(`  主张:${oneLine(claim, 120)}`)
        if (entities.length > 0) parts.push(`  实体:${entities.slice(0, 6).join(', ')}`)
        return parts.join('\n')
      })
      .join('\n')
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
      // 把库里的条目(标题 + 主张 + 实体)交给模型,让它能判断"这条是新的还是推翻旧的"。
      const catalog = this.#existingCatalog(60)
      const summary = await summarizeConversation(this.ctx, {
        provider: model.provider,
        model: model.model,
        digest,
        sessionId,
        sessionTitle: title,
        existingCatalog: catalog,
      })
      const entries = (Array.isArray(summary.entries) ? summary.entries : [])
        .slice(0, settings.writeMaxEntries)
        .map((entry) => normaliseEntry(entry))
        .filter((entry) => entry !== undefined)
        .map((entry) => ({
          ...entry,
          sourceSeq: typeof entry.sourceSeq === 'number' ? entry.sourceSeq : undefined,
        }))
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
        ...(written.entityNotes.length > 0 ? [`- 实体页:更新 ${written.entityNotes.length} 个`] : []),
        `- 会话页:${written.sessionNote}`,
        ...(written.profileNote !== undefined ? [`- 画像:${written.profileNote}`] : []),
        '',
        ...written.written.map((entry) => {
          const relations = entry.relates.length > 0
            ? ` ← ${entry.relates.map((relation) => `${RELATION_LABEL[relation.how] ?? relation.how}:${relation.to}`).join(', ')}`
            : ''
          return `- [${KIND_LABEL[entry.kind] ?? entry.kind}] ${entry.title}${relations}`
        }),
      ]
      if (summary.degraded === true) {
        lines.push('', '注意:模型输出不是结构化 JSON,本批未写入(避免污染库)。')
      }
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
    // 关掉的会话完全不计数、不写入 —— 这就是"不吞 token"的实现点。
    if (!this.isSessionEnabled(sessionId)) return
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

  /** /update:读全库 + 重建索引 + 让模型连关系图谱 + 合并同义重复。 */
  async updateGraph() {
    const stats = this.vault.stats()
    const rebuilt = this.vault.rebuildIndex()
    const catalog = (this.vault.index.catalog ?? []).slice(0, 400)
    if (catalog.length === 0) {
      return { ok: true, text: `记忆库还是空的(${this.vault.root})。先用 /write 写一次,再 /update 连图谱。`, rebuilt }
    }
    const model = resolveModel(this.ctx, this.settings)
    let graph = { themes: [], edges: [], hub: [], merges: [], degraded: true }
    if (model !== undefined) {
      try {
        graph = await summarizeGraph(this.ctx, {
          provider: model.provider,
          model: model.model,
          entryCount: catalog.length,
          // 给主张和实体,而不是只给标题 —— 只有标题判断不了"是不是同一件事"。
          catalog: catalog
            .map((entry) => {
              const lines = [`- ${entry.title} [${entry.kind}] ${entry.date}`]
              if (entry.claim) lines.push(`  主张:${oneLine(entry.claim, 140)}`)
              if (Array.isArray(entry.entities) && entry.entities.length > 0) {
                lines.push(`  实体:${entry.entities.slice(0, 6).join(', ')}`)
              }
              return lines.join('\n')
            })
            .join('\n'),
        })
      } catch (error) {
        this.log(`graph summary failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // 合并同义重复:模型判定是同一件事的,保留一条,其余标为被取代并删除。
    const merged = this.#applyMerges(graph.merges ?? [])

    const note = this.#writeGraphIndex(graph, catalog, merged)
    const lines = [
      `记忆库已全量读取:${stats.entries} 条 / ${(stats.bytes / 1024).toFixed(1)} KB`,
      `图谱索引:${note}`,
      graph.themes.length > 0 ? `主题:${graph.themes.length} 个` : '主题:未生成(模型不可用或为空)',
      graph.edges.length > 0 ? `连边:${graph.edges.length} 条` : '连边:未生成',
      graph.hub.length > 0 ? `入口:${graph.hub.slice(0, 5).join('、')}` : '',
      merged.length > 0 ? `合并同义条目:${merged.length} 组` : '',
      '',
      '在 Obsidian 里打开库根目录即可看到关系图谱。',
    ]
    return {
      ok: true,
      rebuilt,
      graph,
      merged,
      note,
      text: lines.filter((line) => line !== '').join('\n'),
    }
  }

  /**
   * 按模型判断合并同义条目:保留 keep,删掉同组的其它条目。
   * 被删的条目前会先记一条"已被合并"的说明,避免信息直接消失。
   */
  #applyMerges(merges) {
    const applied = []
    for (const merge of merges) {
      if (merge === null || typeof merge !== 'object') continue
      const dupes = Array.isArray(merge.dupes) ? merge.dupes.map(String) : []
      const keep = String(merge.keep ?? '')
      if (dupes.length < 2 || keep === '' || !dupes.includes(keep)) continue
      const removed = []
      for (const title of dupes) {
        if (title === keep) continue
        const victim = this.vault.findByTitle(title)
        if (victim === undefined) continue
        try {
          rmSync(this.vault.resolveInside(victim.file))
          removed.push(title)
        } catch {
          // 删不掉就跳过,不阻断其它合并。
        }
      }
      if (removed.length > 0) {
        applied.push({ keep, removed, why: String(merge.why ?? '') })
      }
    }
    if (applied.length > 0) this.vault.rebuildIndex()
    return applied
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
          existingCatalog: this.#existingCatalog(60),
        })
        const entries = (Array.isArray(summary.entries) ? summary.entries : [])
          .slice(0, settings.writeMaxEntries)
          .map((entry) => normaliseEntry(entry))
          .filter((entry) => entry !== undefined)
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

  /**
   * 记忆时间线:按天把条目串起来,给设置页和 /recall 命令用。
   * 只读,不调模型,不花 token。
   */
  timeline(options = {}) {
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(200, options.limit)) : 40
    const selected = this.vault.selectFiles({ limit: 4000 })
    const byDay = new Map()
    for (const file of selected.files) {
      const day = String(file.date ?? '未知')
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push({
        title: file.title,
        kind: file.kind,
        file: file.file,
        hook: oneLine(summaryOf(file.text), 120),
      })
    }
    const days = [...byDay.entries()]
      .sort((left, right) => String(right[0]).localeCompare(String(left[0])))
      .slice(0, limit)
      .map(([day, entries]) => ({ day, entries: entries.slice(0, 40), count: entries.length }))
    return { total: selected.total, days }
  }

  /**
   * 删掉一条记忆(用户明确要求"忘掉这个")。
   * 只删条目文件本身,不动会话页与时间线 —— 它们下次写入时自然收敛。
   */
  forget(relPath) {
    const path = String(relPath ?? '').trim()
    if (path === '') return { ok: false, text: '需要指定要删除的记忆文件。' }
    // 显式拒绝任何 `..` 片段:即便 resolveInside 也会拦,这一层让意图更清楚,
    // 也避免"先 startsWith 通过、再靠下一层兜"的脆弱写法。
    if (path.includes('..')) return { ok: false, text: '路径不能包含 ..' }
    if (!path.startsWith('memories/')) {
      return { ok: false, text: '只允许删除 memories/ 下的条目,其它文件请手动处理。' }
    }
    try {
      const full = this.vault.resolveInside(path)
      if (!existsSync(full)) return { ok: false, text: `找不到 ${path}` }
      // 只删 .md,避免误删目录或非条目文件。
      if (!full.endsWith('.md')) return { ok: false, text: '只允许删除 .md 记忆条目。' }
      rmSync(full)
      this.vault.rebuildIndex()
      return { ok: true, text: `已删除 ${path},索引已重建。` }
    } catch (error) {
      return { ok: false, text: `删除失败:${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * 检查更新。
   *
   * 只读:从 GitHub 拉 package.json 比对版本,不装东西、不改文件。
   * 不依赖 pluginManager,没装插件管理器的部署也能检查。
   */
  async checkUpdate(options = {}) {
    const current = this.#currentVersion()
    const repo = this.#repoSlug()
    if (repo === undefined) {
      return { ok: false, reason: 'no-repo', text: '插件清单里没有 repository 字段,无法检查更新。', current }
    }
    const url = `https://raw.githubusercontent.com/${repo}/main/package.json`
    try {
      const latest = await this.#fetchRemoteVersion(url, options.signal)
      if (latest === undefined) {
        return { ok: false, reason: 'bad-manifest', text: '远端 package.json 里没有 version 字段。', current, repo }
      }
      const comparison = compareVersions(latest, current)
      return {
        ok: true,
        current,
        latest,
        repo,
        hasUpdate: comparison > 0,
        sameVersion: comparison === 0,
        text: comparison > 0
          ? `发现新版本:${current} → ${latest}`
          : comparison === 0
            ? `已是最新版本(${current})`
            : `本地版本(${current})比远端(${latest})还新`,
      }
    } catch (error) {
      return {
        ok: false,
        reason: 'network',
        text: `检查更新失败:${describeFetchError(error)}`,
        current,
        repo,
      }
    }
  }

  /**
   * 取远端 package.json 的 version。
   *
   * 按可靠性排序尝试三条路,任一成功即返回:
   *   1. `git ls-remote` + `git show` —— 本机 git 通常已配好证书/代理,
   *      是最稳的一条(很多公司网络只给 git 开了白名单)。
   *   2. 宿主的 `web` 服务 —— 由宿主管理 TLS,但会拒绝解析到内网 IP 的域名。
   *   3. 原生 fetch —— 最后兜底;本地证书链不完整时会失败。
   */
  async #fetchRemoteVersion(url, signal) {
    const errors = []

    // 1) git
    try {
      const version = await this.#versionFromGit()
      if (version !== undefined) return version
    } catch (error) {
      errors.push(`git: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 2) 宿主 web 服务
    try {
      const web = this.ctx.get('web')
      if (web !== undefined && typeof web.fetch === 'function') {
        const result = await web.fetch({ url }, signal)
        if (result?.statusCode !== undefined && (result.statusCode < 200 || result.statusCode >= 300)) {
          throw new Error(`HTTP ${result.statusCode}`)
        }
        const body = typeof result?.body?.content === 'string' ? result.body.content : ''
        const parsed = parseJsonLoose(body)
        if (typeof parsed?.version === 'string' && parsed.version !== '') return parsed.version
        throw new Error('响应里没有 version 字段')
      }
    } catch (error) {
      errors.push(`web: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 3) 原生 fetch
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
        ...(signal !== undefined ? { signal } : {}),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const remote = await response.json()
      if (typeof remote?.version === 'string' && remote.version !== '') return remote.version
      throw new Error('响应里没有 version 字段')
    } catch (error) {
      errors.push(`fetch: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 三条都失败:抛出汇总信息,让上层翻译成给用户看的话。
    throw new Error(errors.join(' / '))
  }

  /**
   * 用本机 git 读远端版本。
   *
   * `git show <remote>/main:package.json` 需要本地有对应的远端跟踪分支,
   * 所以先 `git fetch --depth=1` 一次(很轻),再读文件。
   * 只在插件目录确实是 git 仓库时才尝试。
   */
  async #versionFromGit() {
    const here = dirname(fileURLToPath(import.meta.url))
    const repoDir = join(here, '..')
    if (!existsSync(join(repoDir, '.git'))) {
      throw new Error('插件目录不是 git 仓库(通过 npm/链接安装时常见)')
    }
    const { execFile } = await import('node:child_process')
    const run = (args, timeout = 20_000) => new Promise((resolve, reject) => {
      execFile('git', args, {
        cwd: repoDir,
        timeout,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message).trim().slice(0, 200)))
          return
        }
        resolve(String(stdout))
      })
    })
    await run(['fetch', '--depth=1', 'origin', 'main'])
    const text = await run(['show', 'origin/main:package.json'])
    const parsed = parseJsonLoose(text)
    if (typeof parsed?.version !== 'string' || parsed.version === '') {
      throw new Error('远端 package.json 里没有 version')
    }
    return parsed.version
  }

  /**
   * 执行更新:让宿主的插件管理器从 GitHub 重新安装。
   *
   * 只在用户明确点按钮时调用 —— 它会跑 pnpm,耗时且改文件。
   * 装完通常需要重启插件行才能加载新代码,这一点要如实告诉用户。
   */
  async applyUpdate(options = {}) {
    const repo = this.#repoSlug()
    if (repo === undefined) {
      return { ok: false, reason: 'no-repo', text: '插件清单里没有 repository 字段,无法自动更新。' }
    }
    const manager = this.ctx.get('pluginManager')
    if (manager === undefined || typeof manager.installBundle !== 'function') {
      return {
        ok: false,
        reason: 'no-manager',
        text: '这个部署没有插件管理器,无法自动更新。请手动 git pull 后重新安装。',
        repo,
      }
    }
    const spec = `github:${repo}`
    try {
      const installOptions = Array.isArray(options.approvedBuilds) && options.approvedBuilds.length > 0
        ? { approvedBuilds: options.approvedBuilds }
        : {}
      const result = await manager.installBundle(spec, installOptions)
      const application = String(result?.application ?? 'unknown')
      const version = typeof result?.version === 'string' ? result.version : ''
      const suffix = version !== '' ? `(v${version})` : ''
      if (application === 'applied') {
        return {
          ok: true,
          application,
          version,
          text: `更新完成${suffix}。如果界面没变化,停用再启用插件行即可加载新代码。`,
        }
      }
      if (application === 'restart-required') {
        return {
          ok: true,
          application,
          version,
          needsRestart: true,
          text: `新版本已下载${suffix},需要重启 DSH 才会生效。`,
        }
      }
      if (application === 'cancelled') {
        return { ok: false, reason: 'cancelled', application, text: '更新已取消。' }
      }
      const error = result?.error
      const detail = typeof error?.diagnostic === 'string'
        ? error.diagnostic
        : typeof error?.code === 'string'
          ? error.code
          : '未知错误'
      return { ok: false, reason: 'failed', application, text: `更新失败:${detail}` }
    } catch (error) {
      return {
        ok: false,
        reason: 'error',
        text: `更新失败:${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /** 当前插件版本(读自己的 package.json)。 */
  #currentVersion() {
    const parsed = this.#manifest()
    return typeof parsed?.version === 'string' ? parsed.version : '0.0.0'
  }

  /** 读插件自己的 package.json。 */
  #manifest() {
    try {
      const here = dirname(fileURLToPath(import.meta.url))
      return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    } catch {
      return undefined
    }
  }

  /** 从 package.json 的 repository 字段取 `owner/repo`。 */
  #repoSlug() {
    const parsed = this.#manifest()
    const raw = typeof parsed?.repository === 'string'
      ? parsed.repository
      : typeof parsed?.repository?.url === 'string'
        ? parsed.repository.url
        : ''
    const match = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:#.*)?$/.exec(String(raw))
    return match === null ? undefined : `${match[1]}/${match[2]}`
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
    const files = this.vault.selectFiles({ limit: 4000 }).files
    const nodes = files.map((file) => ({
      id: String(file.title),
      kind: String(file.kind ?? 'note'),
      claim: String(file.claim ?? ''),
      date: String(file.date ?? ''),
      file: String(file.file ?? ''),
      entities: Array.isArray(file.entities) ? file.entities : [],
    }))
    const known = new Set(nodes.map((node) => node.id))
    // 实体节点也进图:它们是真正的枢纽,能被多条记忆共用。
    const entitySet = new Set()
    for (const node of nodes) {
      for (const entity of node.entities) entitySet.add(entity)
    }
    for (const entity of entitySet) {
      nodes.push({ id: entity, kind: 'entity', claim: '', date: '', file: '', entities: [] })
    }

    const edges = []
    // 1) 条目之间的真实关系(带语义)。
    for (const file of files) {
      for (const relation of file.relates ?? []) {
        const [how, to] = String(relation).split(':')
        if (!to || !known.has(to)) continue
        edges.push({ from: String(file.title), to, kind: how || 'relates' })
      }
      // 2) 条目 → 实体(这两条记忆指向同一个实体,边才有语义)。
      for (const entity of file.entities ?? []) {
        edges.push({ from: String(file.title), to: entity, kind: 'mentions' })
      }
    }

    const path = join(this.vault.root, 'graph', 'graph-export.json')
    mkdirSync(join(this.vault.root, 'graph'), { recursive: true })
    writeFileSync(path, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      nodes,
      edges,
      stats: { entries: known.size, entities: entitySet.size },
    }, null, 2)}\n`, 'utf8')
    return { path, nodes: known.size, entities: entitySet.size, edges: edges.length }
  }

  // ---------------------------------------------------------------- 内部

  /** 渲染注入块。 */
  #renderInjection(input) {
    const lines = [
      '<ai-memory>',
      `记忆库:${this.vault.root}(${input.stats.entries} 条)`,
      '这是用户长期记忆库的摘录,用于延续前几轮对话的上下文;当它和用户当前的话冲突时,以用户当前的话为准。',
    ]
    if (input.grounding === true) {
      lines.push(
        '记忆里没写的事情不要当成已知事实来回答;需要时用 memory_search 查,查不到就直接问用户。',
      )
    }
    lines.push('')
    if (input.ranged !== undefined) {
      lines.push(`## 指定区间记忆(${input.ranged.total} 条)`, '')
      for (const file of input.ranged.files) {
        const claim = typeof file.claim === 'string' && file.claim !== '' ? oneLine(file.claim, 160) : oneLine(summaryOf(file.text), 160)
        const label = KIND_LABEL[file.kind] ?? file.kind
        lines.push(`- [${label}] ${file.title} — ${claim}`)
      }
      lines.push('')
    }
    if (input.digest !== '') lines.push(input.digest, '')
    lines.push('命令:/load 重新读取 · /write 立刻归档本窗 · /update 重建图谱 · /zip 压缩 · /new 重建整库', '</ai-memory>')
    return truncate(lines.join('\n'), input.budget)
  }

  /**
   * 写图谱索引页。
   *
   * 分三层,由粗到细:
   *   实体枢纽   哪些具体东西被反复提到(这是真正的骨架)
   *   关系边     谁推翻谁、谁依赖谁(有语义的边)
   *   主题       模型归的类(给人看的概览)
   */
  #writeGraphIndex(graph, catalog, merged = []) {
    const day = dateStamp()
    const path = join(this.vault.root, 'graph', 'graph-index.md')

    // 实体枢纽:统计每个实体被多少条记忆提到,取前 20。
    const entityCount = new Map()
    for (const entry of catalog) {
      for (const entity of entry.entities ?? []) {
        entityCount.set(entity, (entityCount.get(entity) ?? 0) + 1)
      }
    }
    const hubs = [...entityCount.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 20)

    const themeBlocks = (graph.themes ?? []).map((theme) => {
      const name = String(theme?.name ?? '主题')
      const members = Array.isArray(theme?.entries) ? theme.entries.map(String) : []
      return [`### ${name}`, '', String(theme?.text ?? ''), '', ...members.map((title) => `- [[${title}]]`), ''].join('\n')
    })

    // 关系边带上语义标签,而不是一律用 ↔。
    const edgeLines = (graph.edges ?? [])
      .filter((edge) => edge && typeof edge.from === 'string' && typeof edge.to === 'string')
      .map((edge) => {
        const label = RELATION_LABEL[String(edge.how ?? '')] ?? '关联'
        return `- [[${edge.from}]] --${label}--> [[${edge.to}]] — ${oneLine(edge.why ?? '', 80)}`
      })

    // 条目自己声明的关系(写入时就有了,不依赖 /update)。
    const declaredEdges = []
    for (const entry of catalog) {
      for (const relation of entry.relates ?? []) {
        const [how, to] = String(relation).split(':')
        if (!to) continue
        const label = RELATION_LABEL[how] ?? how
        declaredEdges.push(`- [[${entry.title}]] --${label}--> [[${to}]]`)
      }
    }

    const body = [
      '# 记忆图谱索引',
      '',
      `> 由 /update 生成于 ${day} · 条目 ${catalog.length} 个 · 实体 ${entityCount.size} 个`,
      '',
      '## 实体枢纽',
      '',
      '被最多记忆提到的具体东西。它们是图谱里真正的连接点 ——',
      '两条记忆指向同一个实体,才有理由被连起来。',
      '',
      ...(hubs.length > 0
        ? hubs.map(([entity, count]) => `- [[${entity}]] · ${count} 条记忆`)
        : ['(还没有实体)']),
      '',
      '## 关系边',
      '',
      ...(declaredEdges.length > 0 ? declaredEdges : []),
      ...(edgeLines.length > 0 ? edgeLines : []),
      ...(declaredEdges.length === 0 && edgeLines.length === 0
        ? ['(还没有真实关系。关系需要"推翻/依赖/冲突/细化",不是"都提到同一个项目"。)']
        : []),
      '',
      '## 主题',
      ...(themeBlocks.length > 0 ? themeBlocks : ['(未生成)']),
      '',
      '## 入口',
      ...((graph.hub ?? []).length > 0 ? graph.hub.map((title) => `- [[${title}]]`) : ['(未生成)']),
      '',
      ...(merged.length > 0
        ? ['## 本次合并', '', ...merged.map((item) => `- 保留 [[${item.keep}]],合并掉:${item.removed.map((title) => `[[${title}]]`).join('、')}${item.why ? ` — ${oneLine(item.why, 60)}` : ''}`), '']
        : []),
      '## 全部条目',
      ...catalog.map((entry) => {
        const claim = entry.claim ? ` — ${oneLine(entry.claim, 90)}` : ''
        return `- [[${entry.title}]] · ${KIND_LABEL[entry.kind] ?? entry.kind} · ${entry.date}${claim}`
      }),
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
      `entities: ${entityCount.size}`,
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

/**
 * 把网络错误翻译成一句人能看懂的话。
 *
 * 现在拿到的是三条路都失败后的汇总信息(git / web / fetch 各一段),
 * 所以按关键词判断主要症结,并把"可以手动更新"这个出路告诉用户。
 */
function describeFetchError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const cause = error?.cause?.message ?? error?.cause?.code ?? ''
  const combined = `${message} ${cause}`.toLowerCase()
  if (combined.includes('unable to verify') || combined.includes('certificate')) {
    return 'TLS 证书校验失败(本机证书链不完整)。已依次尝试 git / 宿主 web 服务 / 原生请求;'
      + '三条都不通时可以手动更新:在插件目录执行 git pull,再停用启用插件行。'
  }
  if (combined.includes('non-public ip')) {
    return '域名被解析到内网地址,宿主的安全策略拒绝了这次请求。'
      + '如果你在用代理,请把 raw.githubusercontent.com 设为直连;或手动 git pull 更新。'
  }
  if (combined.includes('enotfound') || combined.includes('getaddrinfo')) {
    return '域名解析失败,检查网络或代理设置。'
  }
  if (combined.includes('etimedout') || combined.includes('timeout')) {
    return '连接超时,检查网络后重试。'
  }
  if (combined.includes('不是 git 仓库')) {
    return `当前安装方式不支持自动检查更新(${message})。手动更新:重新安装新版本,或改用 git clone 安装。`
  }
  return message
}

/**
 * 比较两个语义化版本号。返回 1 / 0 / -1。
 *
 * 只处理 `1.2.3` 和带预发布后缀的 `1.2.3-beta.1`:
 * 数字段逐位比,预发布后缀视为**低于**同号正式版(npm 的约定)。
 * 解析不出来的段当 0 处理,不让一次格式异常把更新检查搞挂。
 */
export function compareVersions(left, right) {
  const parse = (input) => {
    const text = String(input ?? '').trim().replace(/^v/i, '')
    const [core, ...pre] = text.split('-')
    const numbers = core.split('.').map((part) => {
      const value = Number.parseInt(part, 10)
      return Number.isFinite(value) ? value : 0
    })
    while (numbers.length < 3) numbers.push(0)
    return { numbers, prerelease: pre.join('-') }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] > b.numbers[index]) return 1
    if (a.numbers[index] < b.numbers[index]) return -1
  }
  // 同号:有预发布后缀的那个更旧。
  if (a.prerelease === '' && b.prerelease !== '') return 1
  if (a.prerelease !== '' && b.prerelease === '') return -1
  if (a.prerelease === b.prerelease) return 0
  return a.prerelease > b.prerelease ? 1 : -1
}

/** 记忆库的 Obsidian 打开路径(状态里展示)。 */
export function vaultOpenHint(root) {
  return `用 Obsidian 打开文件夹:${root}`
}

export { SECTION_NAME, SECTION_ORDER }
