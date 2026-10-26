/**
 * dsh-ai-memory-ob — 会话日志折叠。
 *
 * 把某个会话(窗口)的原始事件折成"这一窗聊了什么"的紧凑结构:
 * 用户说了什么、助手回了什么、用了哪些工具、涉及哪些文件。
 *
 * 只用 Node 原生能力:会话事件从 sessionQuery 读,不碰数据库。
 */

import { oneLine, textOfContent, truncate } from './util.js'

/** 单条消息保留多少字符(再长就截断,避免摘要本身变巨型)。 */
const MAX_USER_CHARS = 1200
const MAX_ASSISTANT_CHARS = 1800

/**
 * 把事件数组折成对话结构。
 * @param {Array<{type: string, seq: number, time: number, data: any}>} events
 * @param {{fromSeq?: number}} options
 */
export function foldConversation(events, options = {}) {
  const fromSeq = Number.isFinite(options.fromSeq) ? Number(options.fromSeq) : 0
  const turns = []
  const toolNames = new Map()
  const files = new Set()
  let currentTurn = null
  let lastUserText = ''
  let lastAssistantText = ''
  let userMessages = 0
  let assistantMessages = 0
  let firstSeq = null
  let lastSeq = null

  const ensureTurn = (turnNumber) => {
    if (currentTurn !== null && currentTurn.turn === turnNumber) return currentTurn
    currentTurn = {
      turn: turnNumber,
      user: [],
      assistant: [],
      tools: [],
      files: new Set(),
      seqFrom: null,
      seqTo: null,
    }
    turns.push(currentTurn)
    return currentTurn
  }

  for (const event of Array.isArray(events) ? events : []) {
    if (typeof event?.seq === 'number') {
      if (event.seq <= fromSeq) continue
      if (firstSeq === null) firstSeq = event.seq
      lastSeq = event.seq
    }
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'user/message': {
        const text = textOfContent(data.message?.content ?? data.content)
        if (text.trim() === '') break
        userMessages += 1
        lastUserText = text
        const turn = ensureTurn(typeof data.turn === 'number' ? data.turn : turns.length)
        turn.user.push(truncate(text.trim(), MAX_USER_CHARS))
        if (turn.seqFrom === null) turn.seqFrom = event.seq
        turn.seqTo = event.seq
        break
      }
      case 'assistant/message': {
        const text = textOfContent(data.message?.content)
        if (text.trim() === '') break
        assistantMessages += 1
        lastAssistantText = text
        const turn = ensureTurn(typeof data.turn === 'number' ? data.turn : turns.length)
        turn.assistant.push(truncate(text.trim(), MAX_ASSISTANT_CHARS))
        turn.seqTo = event.seq
        break
      }
      case 'tool/call': {
        const name = String(data.name ?? 'tool')
        toolNames.set(name, (toolNames.get(name) ?? 0) + 1)
        const turn = ensureTurn(typeof data.turn === 'number' ? data.turn : turns.length)
        turn.tools.push(name)
        collectFiles(data.arguments, turn.files, files)
        turn.seqTo = event.seq
        break
      }
      case 'turn/end': {
        if (currentTurn !== null) currentTurn = null
        break
      }
      default:
        break
    }
  }

  return {
    turns,
    toolNames: [...toolNames.entries()].map(([name, count]) => ({ name, count })),
    files: [...files].slice(0, 60),
    userMessages,
    assistantMessages,
    firstSeq,
    lastSeq,
    lastUserText,
    lastAssistantText,
    isEmpty: turns.length === 0,
  }
}

/** 从工具参数里抠出可能的文件路径。 */
function collectFiles(argumentsText, turnFiles, allFiles) {
  if (typeof argumentsText !== 'string' || argumentsText === '') return
  const matches = argumentsText.match(/[A-Za-z]:\\\\[^"\\\n]+|\/[^"\\\n]{3,}\.(?:md|ts|tsx|js|jsx|json|yaml|yml|py|rs|go|css|html|txt)\b|[\w./-]{3,}\.(?:md|ts|tsx|js|jsx|json|yaml|yml|py|rs|go|css|html|txt)\b/g)
  if (matches === null) return
  for (const match of matches.slice(0, 6)) {
    const clean = match.replace(/\\\\/g, '\\').trim()
    if (clean.length < 3 || clean.length > 160) continue
    turnFiles.add(clean)
    allFiles.add(clean)
  }
}

/**
 * 把折叠结果压成给模型看的纯文本块(摘要素材)。
 * 只保留结构与关键内容,便于模型二次归纳。
 */
export function renderConversationDigest(folded, options = {}) {
  const maxTurns = Number.isFinite(options.maxTurns) ? options.maxTurns : 40
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 24_000
  const includeTools = options.includeTools !== false
  const lines = []
  const turns = folded.turns.slice(-maxTurns)
  for (const turn of turns) {
    lines.push(`### 轮 ${turn.turn}`)
    for (const text of turn.user) lines.push(`用户：${oneLine(text, 600)}`)
    for (const text of turn.assistant) lines.push(`助手：${oneLine(text, 700)}`)
    if (includeTools && turn.tools.length > 0) lines.push(`工具：${[...new Set(turn.tools)].join(', ')}`)
    if (includeTools && turn.files.size > 0) lines.push(`文件：${[...turn.files].slice(0, 8).join(', ')}`)
    lines.push('')
  }
  if (includeTools && folded.toolNames.length > 0) {
    lines.push(`工具总览：${folded.toolNames.map((item) => `${item.name}×${item.count}`).join(', ')}`)
  }
  return truncate(lines.join('\n').trim(), maxChars)
}
