/**
 * dsh-ai-memory-ob — 用户画像模型。
 *
 * 画像不是"最后一次对话的摘要"。它应该回答:
 *   这个人是谁、怎么做事、在意什么、有哪些稳定特征。
 *
 * 所以每个画像字段都要带:
 *   value    当前值
 *   evidence 支撑它的事实(来自哪次对话的什么行为)
 *   since    什么时候观察到的
 *   history  之前的值(被推翻时不删,留痕,这样能看到"他变了")
 *
 * 判断"该不该写进画像"的门槛是:这个特征换一个话题还成立吗?
 * 只对当前任务成立的东西属于记忆条目,不属于画像。
 */

import { oneLine, truncate } from './util.js'

/**
 * 画像分节。name 是 Markdown 标题,也是模型输出里的 key。
 * hint 会写进提示词,约束模型"这里该放什么"。
 */
export const PROFILE_SECTIONS = Object.freeze([
  {
    key: '身份',
    hint: '他是谁、做什么的、什么水平。只写换话题也成立的部分。',
  },
  {
    key: '沟通风格',
    hint: '希望怎么被回应:长短、语气、要不要解释、讨厌什么说法。要有具体例子。',
  },
  {
    key: '工作方式',
    hint: '怎么推进事情:先想后做还是边做边改、要不要先确认、偏好原子改动还是大改。',
  },
  {
    key: '技术环境',
    hint: '常用系统、语言、工具链、目录约定。写具体的版本/路径,不写"熟悉编程"。',
  },
  {
    key: '在意的',
    hint: '反复强调的价值判断:什么算做对了、什么不能忍。这是他做取舍的依据。',
  },
  {
    key: '当前目标',
    hint: '正在推进的事。会变,所以要带日期。',
  },
])

/** 允许的分节 key。 */
export const PROFILE_KEYS = PROFILE_SECTIONS.map((section) => section.key)

/**
 * 归一模型给出的画像补丁。
 *
 * 支持两种输入:
 *   { "沟通风格": "..." }                                   —— 纯文本,退化成无证据更新
 *   { "沟通风格": { "value": "...", "evidence": "..." } }    —— 完整形式
 * @param {unknown} raw
 * @returns {Array<{key: string, value: string, evidence: string}>}
 */
export function normaliseProfilePatch(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  const patch = []
  for (const section of PROFILE_SECTIONS) {
    const entry = raw[section.key]
    if (entry === undefined || entry === null) continue
    if (typeof entry === 'string') {
      const value = truncate(entry.trim(), 800)
      if (value !== '') patch.push({ key: section.key, value, evidence: '' })
      continue
    }
    if (typeof entry === 'object') {
      const value = truncate(String(entry.value ?? '').trim(), 800)
      if (value === '') continue
      patch.push({
        key: section.key,
        value,
        evidence: truncate(String(entry.evidence ?? '').trim(), 400),
      })
    }
  }
  return patch
}

/**
 * 渲染画像正文。
 * @param {Map<string, {value: string, evidence: string, since: string, history: Array<{value: string, until: string}>}>} sections
 * @param {{updated: string, entryCount: number}} meta
 */
export function profileBody(sections, meta) {
  const lines = [
    '# 用户画像',
    '',
    `> 最近更新 ${meta.updated} · 依据 ${meta.entryCount} 条记忆`,
    '> 每个分节都带证据;历史值保留在折叠块里,能看到变化而不是被悄悄覆盖。',
    '',
  ]
  for (const section of PROFILE_SECTIONS) {
    const record = sections.get(section.key)
    if (record === undefined || record.value === '') continue
    lines.push(`## ${section.key}`, '', record.value, '')
    if (record.evidence !== '') lines.push(`**依据**:${record.evidence}`, '')
    lines.push(`<sub>自 ${record.since} 起</sub>`, '')
    if (Array.isArray(record.history) && record.history.length > 0) {
      lines.push('<details><summary>历史值</summary>', '')
      for (const old of record.history.slice(-5)) {
        lines.push(`- ${oneLine(old.value, 200)} <sub>(至 ${old.until})</sub>`)
      }
      lines.push('', '</details>', '')
    }
  }
  lines.push('## 相关', '- [[记忆库索引]]', '')
  return lines.join('\n')
}

/**
 * 合并一次画像补丁。
 *
 * 语义是"覆盖但有留痕":
 * - 值没变 → 只刷新依据(证据可以变多)。
 * - 值变了 → 旧值进 history,新值生效,记下 since。
 * - 模型没提到的分节 → 原样保留(那是更早积累或用户手写的)。
 *
 * @param {Map<string, object>} current 现有分节
 * @param {Array<{key: string, value: string, evidence: string}>} patch 新补丁
 * @param {string} now 当前时间戳
 */
export function mergeProfile(current, patch, now) {
  const next = new Map(current)
  for (const update of patch) {
    const existing = next.get(update.key)
    if (existing === undefined) {
      next.set(update.key, {
        value: update.value,
        evidence: update.evidence,
        since: now,
        history: [],
      })
      continue
    }
    // 值实质没变:只更新依据与时间,不动 since。
    if (normaliseText(existing.value) === normaliseText(update.value)) {
      next.set(update.key, {
        ...existing,
        evidence: update.evidence !== '' ? update.evidence : existing.evidence,
      })
      continue
    }
    next.set(update.key, {
      value: update.value,
      evidence: update.evidence,
      since: now,
      history: [...(existing.history ?? []), { value: existing.value, until: now }].slice(-10),
    })
  }
  return next
}

/** 比较用:去空白、去标点。 */
function normaliseText(text) {
  return String(text ?? '').replace(/[\s,。、;；:：!！?？"'“”]/g, '').toLowerCase()
}
