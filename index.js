/**
 * dsh-ai-memory-ob — 宿主半边。
 *
 * 提供四类东西:
 *   1. 记忆服务(读写库、注入上下文、归纳)
 *   2. 五个命令:/load /write /update /zip /new
 *   3. 四个模型工具(检索/读取/写入/状态)
 *   4. 一组只读 HTTP 路由,给设置页浏览记忆库用
 *
 * 没有配置 schema:设置存在 `$DSH_HOME/.dsh-ai-memory-ob.json`,由设置页写入,
 * 这样换库路径时设置不会跟着库一起搬走。
 */

import { MemoryService } from './lib/service.js'
import { loadSettings, vaultRoot } from './lib/settings.js'

/** 设置页调用的路由前缀。 */
const API = '/api/dsh-ai-memory-ob'

/** 注入提示块的名字与位置。 */
const SECTION_NAME = 'plugin:dsh-ai-memory-ob'
const SECTION_ORDER = 120
/** 构建标记:状态接口带上它,便于确认热更新是否生效。 */
const BUILD = '2026-10-26.13'

/** 插件行需要的服务:全部按可选取用,缺一个就少一块能力,不会整行挂掉。 */
export const inject = []

/** 从 agent 上安全取会话对象。 */
function sessionOf(agent) {
  try {
    return agent?.session
  } catch {
    return undefined
  }
}

/** 安全取服务。 */
function svc(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** 只认本机直连(不转发、同源)。 */
function isLocal(req) {
  const address = req.socket?.remoteAddress ?? ''
  const loopback = address === '::1'
    || address === '::ffff:127.0.0.1'
    || /^127\./.test(address)
  if (!loopback) return false
  if (req.headers['x-forwarded-for'] !== undefined || req.headers['cf-connecting-ip'] !== undefined) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  if (!/^(?:localhost|127\.|\[::1\])/i.test(host)) return false
  return req.headers['sec-fetch-site'] !== 'cross-site'
}

/** 写 JSON。 */
function sendJson(res, code, value) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

/** 读 JSON body(有上限)。 */
async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/** 解析 /load 的日期参数:`2026-10-01` 或 `2026-10-01..2026-10-20`。 */
function parseRange(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return {}
  const match = /^(\d{4}-\d{2}-\d{2})?(?:\.\.(\d{4}-\d{2}-\d{2})?)?$/.exec(text)
  if (match === null) return {}
  const from = match[1]
  const to = match[2]
  return {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  }
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const log = (line) => {
    try {
      ctx.logger?.('dsh-ai-memory-ob')?.info?.(line)
    } catch {
      // 没有 logger 就静默。
    }
  }
  const service = new MemoryService(ctx, log)
  service.vault.ensureLayout()

  /** 找活着的 agent(设置页按钮与自动写入用)。 */
  const liveAgent = (sessionId) => {
    const agents = svc(ctx, 'agents')
    if (agents === undefined || typeof agents.get !== 'function') return undefined
    try {
      return agents.get(sessionId)
    } catch {
      return undefined
    }
  }

  // ---------------------------------------------------------------- 命令

  const disposers = []

  // 注意:这里必须用 ctx.inject 而不是 ctx.effect + ctx.get。
  // 插件行可能在 commands 服务注册之前就激活,那时 get 拿到 undefined,
  // effect 里会静默返回、之后再也不会重试 —— 命令就永远不存在了。
  // inject 会等服务出现再执行回调,并在服务消失时自动清理。
  ctx.inject(['commands'], (commandCtx) => {
    const commands = commandCtx.commands
    if (commands === undefined || typeof commands.register !== 'function') return
    const registrations = [
      {
        name: 'load',
        description: '从长期记忆库读取并注入上下文。可带日期区间,如 `/load 2026-10-01..2026-10-20`。',
        input: { hint: '留空 = 画像 + 近期记忆;或写 2026-10-01..2026-10-20 只读这段时间' },
        handler: async (invocation) => {
          const range = parseRange(invocation.rawInput)
          // 用户手打 /load 是明确意图:即使会话开关关着也照做。
          const result = await service.load(invocation.agent, { ...range, force: true })
          if (result.delivered !== true) {
            return { kind: 'error', text: `记忆读取成功,但没能挂进上下文:${result.text.slice(0, 200)}` }
          }
          return {
            kind: 'success',
            text: [
              `已挂上记忆上下文:库内 ${result.entries} 条,本次带入 ${result.text.length} 字符。`,
              `- 库:${service.vault.root}`,
              `- 模型从下一步起能看到:用户画像 + 近期记忆 + 图谱索引`,
            ].join('\n'),
          }
        },
      },
      {
        name: 'write',
        description: '把本次对话窗口总结后写进记忆库(只写自上次写入以来的新内容)。',
        input: { hint: '留空即可;写 all 则把整个窗口从头重写一遍' },
        handler: async (invocation) => {
          const all = String(invocation.rawInput ?? '').trim().toLowerCase() === 'all'
          const result = await service.write(invocation.agent, { trigger: 'command', all })
          return { kind: result.ok === true ? 'success' : 'error', text: result.text }
        },
      },
      {
        name: 'update',
        description: '全量读取记忆库,重建索引,并让模型把条目之间的关系统连成图谱。',
        handler: async () => {
          const result = await service.updateGraph()
          return { kind: result.ok === true ? 'success' : 'error', text: result.text }
        },
      },
      {
        name: 'zip',
        description: '把记忆压缩成一份新文件(源文件不动)。默认只压本窗口,写 vault 压全库,写日期区间压那段。',
        input: { hint: '留空 = 本窗口;vault = 全库;2026-10-01..2026-10-20 = 区间' },
        handler: async (invocation) => {
          const raw = String(invocation.rawInput ?? '').trim()
          const scope = raw === 'vault' ? 'vault' : raw === '' ? 'session' : 'range'
          const range = scope === 'range' ? parseRange(raw) : {}
          const result = await service.zip(invocation.agent, { scope, ...range })
          return { kind: result.ok === true ? 'success' : 'error', text: result.text }
        },
      },
      {
        name: 'new',
        description: '新装用户用:扫描历史对话窗口,重建整个记忆库并连好图谱。耗时较长,可在设置里限制处理数量。',
        handler: async () => {
          const result = await service.rebuild()
          return { kind: result.ok === true ? 'success' : 'error', text: result.text }
        },
      },
      {
        name: 'recall',
        description: '按时间线回顾记忆,不调模型、不花 token。可带天数,如 `/recall 7` 只看最近 7 天。',
        input: { hint: '留空 = 最近 40 天;写数字 = 最近 N 天' },
        handler: async (invocation) => {
          const raw = String(invocation.rawInput ?? '').trim()
          const days = /^\d+$/.test(raw) ? Math.max(1, Number(raw)) : undefined
          const timeline = service.timeline({ limit: days ?? 40 })
          if (timeline.days.length === 0) {
            return { kind: 'success', text: `记忆库还是空的(${service.vault.root})。先用 /write 写一次。` }
          }
          const lines = [`记忆时间线(${timeline.total} 条):`, '']
          for (const day of timeline.days) {
            lines.push(`## ${day.day} · ${day.count} 条`)
            for (const entry of day.entries.slice(0, 12)) {
              lines.push(`- [${entry.kind}] ${entry.title} — ${entry.hook}`)
            }
            lines.push('')
          }
          return { kind: 'success', text: lines.join('\n') }
        },
      },
      {
        name: 'memory',
        description: '查看或切换本会话的记忆开关。`/memory` 看状态,`/memory on` 开,`/memory off` 关,`/memory reset` 回到默认。',
        input: { hint: '留空 = 看状态;on / off / reset' },
        handler: async (invocation) => {
          const sessionId = String(invocation.agent?.id ?? '')
          const raw = String(invocation.rawInput ?? '').trim().toLowerCase()
          if (raw === 'on' || raw === 'off') {
            service.setSessionEnabled(sessionId, raw === 'on')
            const state = service.sessionState(sessionId)
            return {
              kind: 'success',
              text: raw === 'on'
                ? '本会话记忆已开启:会自动注入、按设置自动归档。'
                : '本会话记忆已关闭:不再自动注入、不再自动归档,也不会消耗 token。命令与工具仍可手动用。',
            }
          }
          if (raw === 'reset') {
            service.clearSessionOverride(sessionId)
            return { kind: 'success', text: `已恢复默认(${service.settings.defaultSessionEnabled ? '开' : '关'})。` }
          }
          const state = service.sessionState(sessionId)
          return {
            kind: 'success',
            text: [
              `本会话记忆:${state.enabled ? '开' : '关'}${state.overridden ? '(手动覆盖)' : '(跟随默认)'}`,
              `已注入上下文:${state.hasSnapshot ? '是' : '否'}`,
              '',
              '用 /memory on 或 /memory off 切换;输入框下方的小按钮效果一样。',
            ].join('\n'),
          }
        },
      },
    ]
    const registered = []
    for (const definition of registrations) {
      try {
        registered.push(commands.register(definition))
      } catch (error) {
        log(`command /${definition.name} registration failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    commandCtx.effect(() => () => {
      for (const dispose of registered) {
        try {
          dispose()
        } catch {
          // 已卸载。
        }
      }
    }, 'dsh-ai-memory-ob: commands cleanup')
  })

  // ---------------------------------------------------------------- 工具

  // 同命令:工具注册表也必须等就绪,否则工具会静默丢失。
  ctx.inject(['tools'], (toolCtx) => {
    const tools = toolCtx.tools
    if (tools === undefined || typeof tools.register !== 'function') return
    const definitions = [
      {
        name: 'memory_search',
        description: '在长期记忆库里检索条目。支持关键词、日期区间、分类。只返回标题与摘要,便宜;需要全文再用 memory_recall。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词(在标题与正文里找),留空则按日期/分类筛' },
            from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
            to: { type: 'string', description: '结束日期 YYYY-MM-DD' },
            kind: { type: 'string', description: '分类:decision / fact / preference / task / code / insight' },
            limit: { type: 'number', description: '最多几条,默认 10' },
          },
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        execute: async (args) => {
          const query = String(args?.query ?? '').trim()
          const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(40, args.limit)) : 10
          const selected = service.vault.selectFiles({
            from: typeof args?.from === 'string' ? args.from : undefined,
            to: typeof args?.to === 'string' ? args.to : undefined,
            kinds: typeof args?.kind === 'string' && args.kind !== '' ? [args.kind] : undefined,
            limit: 400,
          })
          const needle = query.toLowerCase()
          const hits = selected.files.filter((file) => needle === ''
            || file.title.toLowerCase().includes(needle)
            || file.body.toLowerCase().includes(needle))
          if (hits.length === 0) {
            return { ok: true, text: `记忆库里没有匹配「${query}」的条目(库内共 ${selected.total} 条)。`, hits: 0 }
          }
          const lines = hits.slice(0, limit).map((file) => `- ${file.date} · ${file.title} [${file.kind}] — ${oneLineOf(file.body, 120)}`)
          return { ok: true, hits: hits.length, text: `${hits.length} 条命中(显示前 ${Math.min(limit, hits.length)} 条):\n${lines.join('\n')}` }
        },
      },
      {
        name: 'memory_recall',
        description: '按文件路径读取一条记忆的全文(路径来自 memory_search 的结果)。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'memories/xxx.md' } },
          required: ['path'],
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        execute: async (args) => {
          const path = String(args?.path ?? '').trim()
          if (path === '') return { ok: false, text: '需要 path。' }
          try {
            const file = service.read(path)
            if (file.ok !== true) return { ok: false, text: `读不到 ${path}` }
            return { ok: true, text: file.text }
          } catch (error) {
            return { ok: false, text: error instanceof Error ? error.message : String(error) }
          }
        },
      },
      {
        name: 'memory_write',
        description: '把当前对话窗口总结后写进长期记忆库。用户明确要求"记住这个"或 /write 时使用;不要每轮都调。',
        parameters: {
          type: 'object',
          properties: { all: { type: 'boolean', description: 'true = 整个窗口从头重写' } },
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        execute: async (args, exec) => {
          const result = await service.write(exec?.agent, { trigger: 'command', all: args?.all === true })
          return { ok: result.ok === true, text: result.text }
        },
      },
      {
        name: 'memory_status',
        description: '查看记忆库状态:库路径、条目数、上次写入、自动写入设置、注入开关。',
        parameters: { type: 'object', properties: {} },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        execute: async () => {
          const status = service.status()
          return {
            ok: true,
            text: [
              `库:${status.vault.root}`,
              `条目:${status.vault.entries} 条 · ${(status.vault.bytes / 1024).toFixed(1)} KB`,
              `压缩件:${status.vault.zips} · 图谱页:${status.vault.graphNotes}`,
              `上次写入:${status.vault.lastWrite ?? '从未'}`,
              `自动写入:${status.settings.autoWriteMode === 'turns' ? `每 ${status.settings.autoWriteTurns} 轮` : '关闭(仅 /write)'}`,
              `自动注入:${status.settings.autoInject ? '开' : '关'} · 归纳模型:${status.model}`,
            ].join('\n'),
          }
        },
      },
    ]
    const registered = []
    for (const definition of definitions) {
      try {
        registered.push(tools.register(definition))
      } catch (error) {
        log(`tool ${definition.name} registration failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    toolCtx.effect(() => () => {
      for (const dispose of registered) {
        try {
          dispose()
        } catch {
          // 已卸载。
        }
      }
    }, 'dsh-ai-memory-ob: tools cleanup')
  })

  // ---------------------------------------------------------------- 提示块

  // 提示注册表同样用 inject 等就绪:早于服务激活时 get 会拿到 undefined。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    const prompt = promptCtx.systemPrompt
    if (prompt === undefined) return
    if (typeof prompt.section === 'function') {
      try {
        promptCtx.effect(() => prompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          interpolate: false,
          text: [
            '## 长期记忆库',
            '',
            `这个部署装了一个 Obsidian 格式的长期记忆库:${vaultRoot(loadSettings())}`,
            '它按"每次对话 → 记忆条目 + 用户画像"增长,条目之间用 `[[双链]]` 相连。',
            '',
            '使用方式:',
            '- `/load` 把画像与近期记忆读进上下文(可在设置里设成每个新会话自动读)。',
            '- `/write` 把本窗口总结归档;`/update` 重建索引并连图谱;`/zip` 压缩成新文件;`/new` 从历史窗口重建整库。',
            '- 需要主动查记忆时用 `memory_search` / `memory_recall`,不要凭空猜。',
            '- 记忆是派生缓存:与用户当前的话冲突时,以用户当前的话为准。',
          ].join('\n'),
        }), 'dsh-ai-memory-ob: prompt section')
      } catch (error) {
        log(`prompt section failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (typeof prompt.context === 'function') {
      try {
        promptCtx.effect(() => prompt.context({
          name: `${SECTION_NAME}:recall`,
          order: SECTION_ORDER,
          text: (context) => {
            const sessionId = String(context?.agent?.id ?? '')
            if (sessionId === '') return ''
            return service.snapshotText(sessionId)
          },
        }), 'dsh-ai-memory-ob: memory context')
      } catch (error) {
        log(`memory context failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })

  // ---------------------------------------------------------------- 自动注入

  disposers.push(ctx.on('agent/created', async ({ agent }) => {
    const settings = service.settings
    if (settings.autoInject !== true) return
    // 子代理不继承用户记忆:它们的上下文属于父任务,记忆会干扰判断。
    const session = sessionOf(agent)
    if (session?.header?.origin === 'subagent') return
    // 会话级开关关掉时不自动注入(service.load 内部还会再判一次)。
    if (!service.isSessionEnabled(agent?.id)) return
    try {
      await service.load(agent)
    } catch (error) {
      log(`auto inject failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }))

  // 会话结束时丢掉快照(库里已经落盘了)。
  disposers.push(ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = String(agent?.id ?? '')
    if (sessionId !== '') service.dropSnapshot(sessionId)
  }))

  // ---------------------------------------------------------------- 自动写入

  disposers.push(ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const settings = service.settings
    if (settings.autoWriteMode !== 'turns') return
    if (session?.header?.origin === 'subagent') return
    // 关掉的会话连计数都不做,更不会写入。
    if (!service.isSessionEnabled(session.id)) return
    const agent = liveAgent(session.id)
    if (agent === undefined) return
    void service.tick(agent).catch((error) => {
      log(`auto write tick failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }))

  // ---------------------------------------------------------------- HTTP(设置页)

  const routes = [
    {
      path: `${API}/state`,
      handler: async (req, res) => {
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
        try {
          sendJson(res, 200, { ok: true, build: BUILD, ...service.status() })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: `${API}/tree`,
      handler: async (req, res) => {
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        try {
          sendJson(res, 200, { ok: true, ...service.tree(url.searchParams.get('path') ?? '') })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: `${API}/file`,
      handler: async (req, res) => {
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        try {
          sendJson(res, 200, service.read(url.searchParams.get('path') ?? ''))
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: `${API}/session`,
      handler: async (req, res) => {
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('id') ?? ''
        if (req.method === 'GET') {
          return sendJson(res, 200, { ok: true, ...service.sessionState(sessionId) })
        }
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST only' })
        try {
          const body = await readJson(req)
          const id = String(body?.sessionId ?? sessionId)
          if (body?.reset === true) service.clearSessionOverride(id)
          else service.setSessionEnabled(id, body?.enabled === true)
          sendJson(res, 200, { ok: true, ...service.sessionState(id) })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: `${API}/timeline`,
      handler: async (req, res) => {
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const limit = Number(url.searchParams.get('limit') ?? '40')
        try {
          sendJson(res, 200, { ok: true, ...service.timeline({ limit: Number.isFinite(limit) ? limit : 40 }) })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: `${API}/settings`,
      handler: async (req, res) => {
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        try {
          const body = await readJson(req)
          service.update(body)
          sendJson(res, 200, { ok: true, ...service.status() })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: `${API}/action`,
      handler: async (req, res) => {
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        try {
          const body = await readJson(req)
          const action = String(body?.action ?? '')
          const sessionId = String(body?.sessionId ?? '')
          const agent = sessionId === '' ? undefined : liveAgent(sessionId)
          const needsAgent = action === 'write' || action === 'load' || action === 'zip'
          if (needsAgent && agent === undefined) {
            return sendJson(res, 409, {
              ok: false,
              error: '这个操作需要一个打开着的会话。请在那个会话里用命令(/write、/load、/zip)。',
            })
          }
          if (action === 'reindex') {
            const result = service.vault.rebuildIndex()
            return sendJson(res, 200, { ok: true, text: `索引已重建:${result.entries} 条`, ...result })
          }
          if (action === 'export') {
            const result = service.exportGraph()
            return sendJson(res, 200, { ok: true, text: `已导出:${result.path}(${result.nodes} 节点 / ${result.edges} 边)`, ...result })
          }
          if (action === 'write') {
            const result = await service.write(agent, { trigger: 'command', all: body?.all === true })
            return sendJson(res, 200, { ok: result.ok === true, text: result.text })
          }
          if (action === 'load') {
            const result = await service.load(agent, {
              ...(typeof body?.from === 'string' ? { from: body.from } : {}),
              ...(typeof body?.to === 'string' ? { to: body.to } : {}),
            })
            return sendJson(res, 200, {
              ok: result.delivered === true,
              text: result.delivered === true
                ? `已挂上记忆上下文(${result.text.length} 字符)。`
                : `读取到 ${result.text.length} 字符,但没挂上(会话可能已结束)。`,
            })
          }
          if (action === 'zip') {
            const result = await service.zip(agent, { scope: body?.scope === 'vault' ? 'vault' : 'session' })
            return sendJson(res, 200, {
              ok: result.ok === true,
              text: result.text,
              ...(typeof result.file === 'string' ? { file: result.file } : {}),
            })
          }
          if (action === 'update') {
            const result = await service.updateGraph()
            return sendJson(res, 200, { ok: true, text: result.text, ...(typeof result.note === 'string' ? { note: result.note } : {}) })
          }
          if (action === 'forget') {
            const result = service.forget(String(body?.path ?? ''))
            return sendJson(res, 200, { ok: result.ok === true, text: result.text })
          }
          if (action === 'session-toggle') {
            const id = String(body?.sessionId ?? '')
            if (body?.reset === true) service.clearSessionOverride(id)
            else service.setSessionEnabled(id, body?.enabled === true)
            const state = service.sessionState(id)
            return sendJson(res, 200, {
              ok: true,
              ...state,
              text: state.enabled ? '本会话记忆已开启。' : '本会话记忆已关闭。',
            })
          }
          return sendJson(res, 400, { ok: false, error: `unknown action: ${action}` })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]

  ctx.inject(['webServer'], (serverCtx) => {
    const server = serverCtx.webServer
    if (server === undefined || typeof server.register !== 'function') return
    const registered = []
    for (const route of routes) {
      try {
        registered.push(server.register({ kind: 'exact', path: route.path, handler: route.handler }))
      } catch (error) {
        log(`route ${route.path} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    serverCtx.effect(() => () => {
      for (const dispose of registered) {
        try {
          dispose()
        } catch {
          // 已卸载。
        }
      }
    }, 'dsh-ai-memory-ob: routes cleanup')
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 已卸载。
      }
    }
  }
}

/** 一行摘要(工具返回里用)。 */
function oneLineOf(text, limit) {
  const value = String(text ?? '').replace(/^---[\s\S]*?---/, '').replace(/\s+/g, ' ').trim()
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`
}
