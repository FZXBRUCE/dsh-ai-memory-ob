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

/** 归纳"这一窗聊了什么" → 原子记忆条目 + 带证据的画像补丁。 */
export async function summarizeConversation(ctx, request) {
  const prompt = [
    `会话标题:${request.sessionTitle || '(无)'}`,
    `会话 id:${request.sessionId}`,
    '',
    '## 已有记忆(用来判断重复与推翻关系,不要重复造)',
    request.existingCatalog === undefined || request.existingCatalog === ''
      ? '(库里还没有记忆)'
      : request.existingCatalog,
    '',
    '## 这次对话的折叠记录',
    '<<<',
    request.digest,
    '>>>',
    '',
    '## 输出要求',
    '只输出一个 JSON 对象:',
    '{',
    '  "entries": [',
    '    {',
    '      "title": "短标题(≤24字),能被当文件名用",',
    '      "claim": "一句话主张:只有一个主语、一个结论,脱离上下文也能读懂",',
    '      "kind": "decision|fact|preference|constraint|insight|question",',
    '      "why": "为什么这么定:推理过程、考虑过什么、放弃了什么",',
    '      "evidence": "对话里支撑它的事实:谁说了什么、试出了什么、报了什么错",',
    '      "entities": ["这条谈到的具体实体:项目名/工具名/文件名/技术名"],',
    '      "tags": ["2~5个中文标签"],',
    '      "relates": [{"to": "已有条目的 title", "how": "supersedes|depends-on|contradicts|refines", "note": "关系说明"}],',
    '      "confidence": 0.0 到 1.0',
    '    }',
    '  ],',
    '  "profile": {',
    '    "身份": {"value": "...", "evidence": "你凭什么这么判断"},',
    '    "沟通风格": {"value": "...", "evidence": "..."},',
    '    "工作方式": {"value": "...", "evidence": "..."},',
    '    "技术环境": {"value": "...", "evidence": "..."},',
    '    "在意的": {"value": "...", "evidence": "..."},',
    '    "当前目标": {"value": "...", "evidence": "..."}',
    '  }',
    '}',
    '',
    '## 硬性规则',
    '1. entries 取 1~6 条。**一条只讲一件事**:如果一条里出现了"另外""同时""还有",',
    '   说明该拆。宁可 4 条精准的,不要 1 条塞满的。',
    '2. claim 不能出现"这次对话""本次会话""我们讨论了"这类主语 —— 那不是知识,是纪要。',
    '   把纪要翻译成结论:不是"我们讨论了注入方式",而是"记忆注入走提示上下文通道而不是构造消息"。',
    '3. why / evidence 宁缺勿滥:想不出具体的理由或证据就留空字符串,不要写套话',
    '   ("为了更好的效果""经过讨论决定"这类一律不要)。',
    '4. entities 是图谱连边的依据,必须具体:写 "dsh-ai-memory-ob"、"lib/vault.js"、',
    '   "Obsidian"、"PowerShell",不要写 "插件"、"项目"、"工具" 这种泛词。',
    '5. relates 只在**已有记忆里确实存在**对应 title 时才填;推翻旧结论用 supersedes,',
    '   同一件事补充细节用 refines,两者冲突待裁决用 contradicts。没有就空数组。',
    '6. profile 的门槛是:换一个话题还成立吗?只对这次任务成立的(比如"正在改某个 bug")',
    '   属于 entries,不属于 profile。**没有新信息的分节直接省略,不要填占位文字。**',
    '7. 寒暄、确认、一次性问答不写。',
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
      entries: [],
      profile: undefined,
      degraded: true,
      raw: truncate(raw, 4000),
    }
  }
  return {
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
    `记忆库现有 ${request.entryCount} 个条目,下面是它们的主张与实体:`,
    '<<<',
    request.catalog,
    '>>>',
    '',
    '请输出 JSON:',
    '{',
    '  "merges": [{"dupes": ["标题A", "标题B"], "keep": "保留哪个标题", "why": "它们是同一件事的原因"}],',
    '  "edges": [{"from": "标题A", "to": "标题B", "how": "supersedes|depends-on|contradicts|refines", "why": "关系是什么"}],',
    '  "themes": [{"name": "主题名", "entries": ["标题"], "text": "这个主题在讲什么"}],',
    '  "hub": ["最值得作为入口的标题"]',
    '}',
    '',
    '规则:',
    '- 只使用上面出现过的标题,不要新造。',
    '- merges 只报**语义重复**的条目(同一个主张说了两遍),不要报"相关"的条目。',
    '- edges 必须是真实关系,不要因为"都提到同一个项目"就连边 —— 那不算关系。',
    '  有用的边是:这条推翻了那条、这条依赖那条、这两条冲突、这条细化了那条。',
    '- 找不到真实关系就留空数组,不要凑数。',
  ].join('\n')
  const raw = await generate(ctx, {
    provider: request.provider,
    model: request.model,
    prompt,
    maxTokens: request.maxTokens ?? 3200,
    signal: request.signal,
  })
  const parsed = parseJsonLoose(raw)
  if (parsed === undefined) return { themes: [], edges: [], hub: [], merges: [], degraded: true }
  return {
    themes: Array.isArray(parsed.themes) ? parsed.themes : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    hub: Array.isArray(parsed.hub) ? parsed.hub : [],
    merges: Array.isArray(parsed.merges) ? parsed.merges : [],
    degraded: false,
  }
}
