/**
 * dsh-ai-memory-ob — 记忆条目模型。
 *
 * 设计原则:一条记忆 = 一个可以独立成立的主张,不是一次对话的纪要。
 *
 * 为什么这样切:
 * - 对话纪要检索不了。"这次我们聊了命令、设置、目录结构"这种内容,
 *   以后问"设置项默认值是什么"时匹配不上,因为句子主语是"这次对话"。
 * - 原子主张可以。每条只有一个主语、一个结论,能被精确命中,也能被推翻。
 * - 有了原子性,才谈得上"这条推翻那条"、"这条依赖那条" —— 图谱的边
 *   才有真实语义,而不是"这两条都是讲插件的"。
 *
 * 一条记忆的骨架:
 *   claim      一句话主张(可独立阅读)
 *   why        为什么这么定(推理过程)
 *   evidence   对话里支撑它的事实(引用或转述)
 *   entities   它谈到的实体(项目/工具/人/文件),这是图谱连边的依据
 *   relates    与其它条目的关系(supersedes / depends-on / contradicts / refines)
 *   confidence 有多确定
 */

import { oneLine, truncate, unique } from './util.js'

/** 允许的分类。 */
export const KINDS = Object.freeze([
  'decision', // 做了决定,含取舍
  'fact', // 客观事实 / 环境状态
  'preference', // 用户的偏好与口味
  'constraint', // 硬约束(权限、平台、协议限制)
  'insight', // 想通了的事 / 因果
  'question', // 悬而未决的问题
])

/** 允许的关系类型。 */
export const RELATIONS = Object.freeze([
  'supersedes', // 本条推翻/替换那条
  'depends-on', // 本条依赖那条成立
  'contradicts', // 本条与那条冲突(待裁决)
  'refines', // 本条细化了那条
])

/** 分类的中文标签(渲染用)。 */
export const KIND_LABEL = Object.freeze({
  decision: '决定',
  fact: '事实',
  preference: '偏好',
  constraint: '约束',
  insight: '洞察',
  question: '待解',
})

/** 关系的中文标签。 */
export const RELATION_LABEL = Object.freeze({
  supersedes: '取代',
  'depends-on': '依赖',
  contradicts: '冲突',
  refines: '细化',
})

/**
 * 把模型输出的一条记忆归一成内部结构。
 * 容错优先:模型少给字段时用兜底,而不是整条丢弃。
 * @param {unknown} raw 模型给的原始对象
 * @returns {object|undefined} 归一后的条目;完全不可用时返回 undefined
 */
export function normaliseEntry(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const value = raw

  // claim 是核心。模型只给了 text 就退而用它当 claim。
  const claim = oneLine(
    typeof value.claim === 'string' ? value.claim : typeof value.text === 'string' ? value.text : '',
    200,
  )
  if (claim === '') return undefined

  const title = oneLine(
    typeof value.title === 'string' && value.title.trim() !== '' ? value.title : claim,
    48,
  )

  const kind = KINDS.includes(String(value.kind)) ? String(value.kind) : 'fact'

  const why = typeof value.why === 'string' ? truncate(value.why.trim(), 1200) : ''
  const evidence = typeof value.evidence === 'string' ? truncate(value.evidence.trim(), 1200) : ''

  const entities = unique(
    (Array.isArray(value.entities) ? value.entities : [])
      .map((entity) => oneLine(String(entity ?? ''), 40))
      .filter((entity) => entity !== ''),
  ).slice(0, 12)

  const tags = unique(
    (Array.isArray(value.tags) ? value.tags : [])
      .map((tag) => oneLine(String(tag ?? ''), 24))
      .filter((tag) => tag !== ''),
  ).slice(0, 8)

  const relates = (Array.isArray(value.relates) ? value.relates : [])
    .map((relation) => {
      if (relation === null || typeof relation !== 'object') return undefined
      const to = oneLine(String(relation.to ?? ''), 60)
      const how = RELATIONS.includes(String(relation.how)) ? String(relation.how) : 'refines'
      if (to === '') return undefined
      return { to, how, note: typeof relation.note === 'string' ? truncate(relation.note, 300) : '' }
    })
    .filter((relation) => relation !== undefined)
    .slice(0, 8)

  const confidence = (() => {
    const parsed = Number(value.confidence)
    if (!Number.isFinite(parsed)) return 0.8
    return Math.max(0, Math.min(1, parsed))
  })()

  return {
    title,
    claim,
    kind,
    why,
    evidence,
    entities,
    tags,
    relates,
    confidence,
    /** 兼容旧字段:模型若给了 links,转成 refines 关系。 */
    ...(relates.length === 0 && Array.isArray(value.links) && value.links.length > 0
      ? { relates: value.links.slice(0, 8).map((link) => ({ to: oneLine(String(link), 60), how: 'refines', note: '' })) }
      : {}),
  }
}

/**
 * 条目正文(Markdown,不含 frontmatter)。
 * 结构固定:主张 → 为什么 → 证据 → 影响/待办 → 关联。
 * 空节不渲染,避免一堆空标题。
 */
export function entryBody(entry, meta) {
  const lines = [`# ${entry.title}`, '']
  lines.push(`> ${entry.claim}`, '')

  if (entry.why !== '') lines.push('## 为什么', '', entry.why, '')
  if (entry.evidence !== '') lines.push('## 证据', '', entry.evidence, '')
  if (entry.entities.length > 0) {
    // 链接目标必须和实体页文件名一致,否则 Obsidian 里是断链。
    lines.push('## 涉及', '', entry.entities.map((entity) => `- [[${entityLinkTarget(entity)}]]`).join('\n'), '')
  }
  if (entry.relates.length > 0) {
    lines.push('## 关联', '')
    for (const relation of entry.relates) {
      const label = RELATION_LABEL[relation.how] ?? relation.how
      const note = relation.note === '' ? '' : ` — ${relation.note}`
      lines.push(`- ${label} [[${relation.to}]]${note}`)
    }
    lines.push('')
  }
  if (meta?.sessionTitle) {
    lines.push('## 出处', '', `- 会话 [[${meta.sessionLink}|${oneLine(meta.sessionTitle, 40)}]] · ${meta.created}`, '')
  }
  return lines.join('\n')
}

/**
 * 两条记忆是否可能在讲同一件事(去重候选的初筛,不花 token)。
 *
 * 判据是"实体重叠 + 主张词重叠",刻意宽松:宁可多送几条给模型判断,
 * 也不要漏掉真正的重复。真正裁决交给模型。
 */
export function looksRelated(left, right) {
  const entityOverlap = intersectionSize(left.entities ?? [], right.entities ?? [])
  if (entityOverlap >= 1) return true
  const leftTokens = tokensOf(`${left.title} ${left.claim}`)
  const rightTokens = tokensOf(`${right.title} ${right.claim}`)
  const shared = intersectionSize(leftTokens, rightTokens)
  // 短句要求更高的重叠比例,长句放宽。
  const threshold = Math.max(2, Math.ceil(Math.min(leftTokens.size, rightTokens.size) * 0.4))
  return shared >= threshold
}

/** 集合交集大小(大小写不敏感)。 */
function intersectionSize(left, right) {
  const rightSet = new Set([...right].map((value) => String(value).toLowerCase()))
  let count = 0
  for (const value of left) {
    if (rightSet.has(String(value).toLowerCase())) count += 1
  }
  return count
}

/** 抽取用于相似度比较的词(中文按二元组,英文按单词)。 */
function tokensOf(text) {
  const value = String(text ?? '').toLowerCase()
  const tokens = new Set()
  for (const word of value.match(/[a-z][a-z0-9_-]{2,}/g) ?? []) tokens.add(word)
  const han = value.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of han) {
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2))
  }
  return tokens
}

/**
 * 实体名 → 文件名。
 *
 * 关键约束:**文件名必须和双链文字一致**,否则 Obsidian 里全是断链。
 * 条目正文写的是 `[[@deepseek-ai/dsh-typert-protocol]]`,如果文件叫
 * `@deepseek-ai-dsh-typert-protocol.md`,这条链接就废了。
 *
 * 所以这里只做最小改动:
 *   - 替换 Windows 不允许出现在文件名里的字符(`\ / : * ? " < > |`)为 `-`
 *   - 去掉首尾空白和结尾的点(Windows 也不允许)
 *   - 过长时截断
 * 中文、`@`、`.`、`_`、`-`、空格都原样保留。
 *
 * 如果实体名里确实含有 `/`,Obsidian 会把它当子目录路径 —— 这种情况把
 * 斜杠换成全角 `／`(视觉上接近,但不是路径分隔符),双链文字也要同步改。
 */
export function entityFileName(name) {
  const raw = String(name ?? '').trim()
  if (raw === '') return 'entity'
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, (char) => (char === '/' ? '／' : '-'))
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned === '') return 'entity'
  return truncate(cleaned, 120)
}

/**
 * 实体名 → 正文里应当写的双链目标。
 *
 * 必须和 entityFileName 保持一致(去掉 .md 后缀),这样 `[[目标]]`
 * 才能命中文件。含 `/` 的实体在这里也换成全角,避免被当成路径。
 */
export function entityLinkTarget(name) {
  return entityFileName(name)
}
