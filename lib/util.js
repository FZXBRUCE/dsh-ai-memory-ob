/**
 * dsh-ai-memory-ob — 小工具集合(原创实现)。
 * 只做纯函数:时间、字符串裁剪、文件名安全化、简易 frontmatter 读写辅助。
 */

/** 补零。 */
const pad = (value, width = 2) => String(value).padStart(width, '0')

/** 本地日期 `YYYY-MM-DD`。 */
export function dateStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 本地时间 `YYYY-MM-DD HH:mm`。 */
export function timeStamp(date = new Date()) {
  return `${dateStamp(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** ISO 时间(状态文件里用)。 */
export function isoNow(date = new Date()) {
  return date.toISOString()
}

/** 截断到 n 个字符,并标记截断。 */
export function truncate(text, limit) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (limit <= 0 || value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1))}…`
}

/** 压成单行(用于标题、摘要首行)。 */
export function oneLine(text, limit = 120) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return truncate(value, limit)
}

/** 把任意文本变成可安全落盘的一段(去掉 Windows/Unix 非法字符)。 */
export function safeSeg(text, fallback = 'untitled') {
  const value = String(text ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (value === '' || value === '.' || value === '..') return fallback
  return truncate(value, 80)
}

/** 稳定的小写 slug;中文原样保留(Obsidian 文件名支持)。 */
export function slug(text, fallback = 'untitled') {
  const value = safeSeg(text, fallback).toLowerCase().replace(/[#^[\](){}`'",.;!?]+/g, '')
  return value.replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || fallback
}

/** YAML 标量(双引号 + 转义),保证 Obsidian 属性可解析。 */
export function yamlString(value) {
  return JSON.stringify(String(value ?? ''))
}

/** YAML 字符串数组(内联流式)。 */
export function yamlList(values) {
  return `[${values.map((value) => yamlString(value)).join(', ')}]`
}

/** 简易哈希(图节点 id、去重用)。 */
export function shortHash(text) {
  let hash = 0
  const value = String(text ?? '')
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

/** 拼接消息里的纯文本块。 */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 去重保序。 */
export function unique(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** 粗略 token 估算(中文按字、英文按 4 字符)。 */
export function estimateTokens(text) {
  const value = String(text ?? '')
  let tokens = 0
  for (const char of value) {
    tokens += /[\u4e00-\u9fff]/.test(char) ? 1 : 0.25
  }
  return Math.ceil(tokens)
}
