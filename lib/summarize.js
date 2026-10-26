/**
 * dsh-ai-memory-ob — 用当前模型做归纳。
 *
 * 只用 `ctx.llm.stream` 这一条官方通道:没有自带 SDK、没有外部请求。
 * 归纳结果要求是严格 JSON,解析失败就退回纯文本兜底,不让写入整体失败。
 */

import { truncate } from './util.js'

/** 归纳请求的 system 提示。 */
const SYSTEM = [
  '你是一个长期记忆整理器。你的输出会被写进一个 Obsidian 知识库,供以后的对话检索。',
  '要求:',
  '1. 只输出一个 JSON 对象,不要 Markdown 代码块,不要任何解释。',
  '2. 内容用中文,事实优先,不要编造对话里没有的信息。',
  '3. 条目要能被单独检索:标题短、正文自足、写明关键决定与结论。',
].join('\n')

/**
 * 调模型拿一段文本。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{provider: string, model: string, prompt: string, system?: string, maxTokens?: number, signal?: AbortSignal}} request
 * @returns {Promise<string>}
 */
export async function generate(ctx, request) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('llm service is not available')
  const options = {
    provider: request.provider,
    model: request.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }],
    system: request.system ?? SYSTEM,
    maxTokens: request.maxTokens ?? 2400,
    signal: request.signal,
  }
  const parts = []
  let failure
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') parts.push(chunk.text)
    else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      failure = chunk.reason.kind === 'error' ? chunk.reason.failure?.message : 'aborted'
    }
  }
  const text = parts.join('').trim()
  if (text === '' && failure !== undefined) throw new Error(`model call failed: ${failure}`)
  return text
}

/** 宽松解析:去掉代码围栏、找第一个 `{`…最后一个 `}`。 */
export function parseJsonLoose(text) {
  const source = String(text ?? '').trim()
  if (source === '') return undefined
  const candidates = []
  candidates.push(source)
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(source)
  if (fenced !== null) candidates.push(fenced[1])
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(source.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch {
      // 下一个候选。
    }
  }
  return undefined
}

/** 归纳"这一窗聊了什么" → 记忆条目 + 画像补丁。 */
export async function summarizeConversation(ctx, request) {
  const prompt = [
    `会话标题:${request.sessionTitle || '(无)'}`,
    `会话 id:${request.sessionId}`,
    `已有记忆条数:${request.existingEntries ?? 0}`,
    '',
    '下面是这次对话的折叠记录:',
    '<<<',
    request.digest,
    '>>>',
    '',
    '请输出 JSON:',
    '{',
    '  "summary": "一句话概括这段对话在做什么(≤40字)",',
    '  "entries": [',
    '    {',
    '      "title": "短标题(≤24字,同一库里唯一)",',
    '      "kind": "decision|fact|preference|task|code|insight 之一",',
    '      "text": "自足的正文:背景 + 结论 + 必要的细节,200~600字",',
    '      "tags": ["2~5个中文标签"],',
    '      "links": ["只填本次 entries 里其它条目的 title,没有就空数组"]',
    '    }',
    '  ],',
    '  "profile": {',
    '    "概览": "对方是什么样的人、在做什么项目",',
    '    "偏好": "沟通/技术/工作方式的偏好",',
    '    "技术栈": "常用语言、工具、环境",',
    '    "目标": "当前推进中的目标"',
    '  }',
    '}',
    '',
    '规则:',
    '- entries 取 1~8 条,只写有长期价值的内容;寒暄、一次性问答不要写。',
    '- links 只能引用**本次输出里其它条目的 title**,原样照抄,不要引用旧标题或库外标题。',
    '- profile 只写这次对话新暴露出来的稳定信息;没有新信息就给空字符串。',
    '- 同一事实不要拆成多条。',
  ].join('\n')
  const raw = await generate(ctx, {
    provider: request.provider,
    model: request.model,
    prompt,
    maxTokens: request.maxTokens ?? 2600,
    signal: request.signal,
  })
  const parsed = parseJsonLoose(raw)
  if (parsed === undefined) {
    return {
      summary: '',
      entries: [{ title: `会话记录 ${request.sessionTitle || request.sessionId}`, kind: 'fact', text: truncate(raw, 4000), tags: ['会话'], links: [] }],
      profile: undefined,
      degraded: true,
    }
  }
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    profile: parsed.profile,
    degraded: false,
  }
}

/** 归纳整库 → 压缩记忆文件内容。 */
export async function summarizeVault(ctx, request) {
  const prompt = [
    `压缩范围:${request.scopeLabel}`,
    `覆盖条目:${request.entryCount} 条,原始文件 ${request.fileCount} 个`,
    '',
    '原始素材(每条以 `--- 文件: ...` 分隔):',
    '<<<',
    request.material,
    '>>>',
    '',
    '请输出 JSON:',
    '{',
    '  "title": "这段记忆的主题(≤24字)",',
    '  "overview": "3~6句话的总体回顾",',
    '  "threads": [{"name": "线索名", "text": "这条线索的来龙去脉"}],',
    '  "decisions": ["关键决定,每条一句"],',
    '  "open": ["还没解决的问题 / 下一步"],',
    '  "links": ["值得保留的关联记忆标题"]',
    '}',
    '',
    '规则:源文件保持不动,你写的是一份可独立阅读的压缩件;宁可具体,不要空话。',
  ].join('\n')
  const raw = await generate(ctx, {
    provider: request.provider,
    model: request.model,
    prompt,
    maxTokens: request.maxTokens ?? 3200,
    signal: request.signal,
  })
  const parsed = parseJsonLoose(raw)
  if (parsed === undefined) {
    return {
      title: request.scopeLabel,
      overview: truncate(raw, 6000),
      threads: [],
      decisions: [],
      open: [],
      links: [],
      degraded: true,
    }
  }
  return {
    title: typeof parsed.title === 'string' ? parsed.title : request.scopeLabel,
    overview: typeof parsed.overview === 'string' ? parsed.overview : '',
    threads: Array.isArray(parsed.threads) ? parsed.threads : [],
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    open: Array.isArray(parsed.open) ? parsed.open : [],
    links: Array.isArray(parsed.links) ? parsed.links : [],
    degraded: false,
  }
}

/** 归纳"整库关系" → /update 的图谱连边。 */
export async function summarizeGraph(ctx, request) {
  const prompt = [
    `记忆库现有 ${request.entryCount} 个条目,下面是它们的标题、分类与日期:`,
    '<<<',
    request.catalog,
    '>>>',
    '',
    '请输出 JSON:',
    '{',
    '  "themes": [{"name": "主题名", "entries": ["条目标题"], "text": "这个主题在讲什么"}],',
    '  "edges": [{"from": "条目标题", "to": "条目标题", "why": "它们的关系(一句)"}],',
    '  "hub": ["最值得作为入口的条目标题"]',
    '}',
    '',
    '规则:只能使用上面出现过的标题,不要新造;edges 取 10~40 条真正相关的。',
  ].join('\n')
  const raw = await generate(ctx, {
    provider: request.provider,
    model: request.model,
    prompt,
    maxTokens: request.maxTokens ?? 3000,
    signal: request.signal,
  })
  const parsed = parseJsonLoose(raw)
  if (parsed === undefined) return { themes: [], edges: [], hub: [], degraded: true }
  return {
    themes: Array.isArray(parsed.themes) ? parsed.themes : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    hub: Array.isArray(parsed.hub) ? parsed.hub : [],
    degraded: false,
  }
}
