/**
 * dsh-ai-memory-ob — 自测脚本(开发期用,不随插件激活)。
 *
 * 只碰临时目录:`node test/selfcheck.mjs`。
 * 覆盖:落盘结构、frontmatter 往返、压缩、索引重建、图谱导出。
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { MemoryVault, composeMarkdown, extractBody, parseFrontmatter } from '../lib/vault.js'
import { foldConversation, renderConversationDigest } from '../lib/digest.js'
import { normaliseSettings, DEFAULT_SETTINGS } from '../lib/settings.js'
import { parseJsonLoose } from '../lib/summarize.js'
import { dateStamp } from '../lib/util.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-ob-test-'))
const vault = new MemoryVault(root)
vault.ensureLayout()

// 1. 落盘结构
for (const dir of ['memories', 'profile', 'graph', 'zips', 'daily', '.dsh']) {
  assert.ok(existsSync(join(root, dir)), `missing dir ${dir}`)
}

// 2. 写一批记忆
const written = vault.writeEntries({
  sessionId: 'session-abc',
  sessionTitle: '插件开发',
  entries: [
    { title: '记忆库设计', kind: 'decision', text: '用 Obsidian vault 落盘,双链建图谱。', tags: ['设计'], links: ['压缩策略'] },
    { title: '压缩策略', kind: 'insight', text: '源文件不动,压缩件另存。', tags: ['压缩'] },
  ],
  profile: { 概览: '在写 DSH 插件', 偏好: '喜欢直接给结论' },
})
assert.equal(written.written.length, 2)
assert.ok(existsSync(join(root, written.sessionNote)))
assert.ok(existsSync(join(root, written.dailyNote)))
assert.ok(existsSync(join(root, written.profileNote)))

// 3. frontmatter 往返
const first = written.written[0]
const text = readFileSync(join(root, first.path), 'utf8')
const parsed = parseFrontmatter(text)
assert.equal(parsed.fields.title, '记忆库设计')
assert.equal(parsed.fields.kind, 'decision')
assert.deepEqual(parsed.fields.tags, ['记忆', 'decision', '设计'])
assert.deepEqual(parsed.fields.links, ['压缩策略'])
assert.ok(extractBody(text).includes('Obsidian vault'))


// 4. 选择与区间
const today = dateStamp()
const picked = vault.selectFiles({ from: today, to: today })
assert.equal(picked.total, 2)
const byKind = vault.selectFiles({ kinds: ['insight'] })
assert.equal(byKind.total, 1)

// 5. 画像合并(第二次写不覆盖第一次)
vault.writeEntries({
  sessionId: 'session-abc',
  sessionTitle: '插件开发',
  entries: [{ title: '命令设计', kind: 'decision', text: '/load /write /update /zip /new。' }],
  profile: { 目标: '做出长期记忆插件', 偏好: '要能导出' },
})
const profileText = vault.readProfile()
assert.ok(profileText.includes('在写 DSH 插件'), 'profile 概览被覆盖了')
assert.ok(profileText.includes('做出长期记忆插件'), 'profile 目标没合并进去')
assert.ok(profileText.includes('要能导出'), 'profile 偏好没合并')

// 5b. 画像刷新语义:同名分节替换,不在同一分节下无限追加;`相关` 只出现一次
vault.writeEntries({
  sessionId: 'session-abc',
  sessionTitle: '插件开发',
  entries: [{ title: '画像刷新', kind: 'fact', text: '刷新画像。' }],
  profile: { 目标: '把插件做完并发布' },
})
const refreshed = vault.readProfile()
assert.ok(refreshed.includes('把插件做完并发布'), '目标没刷新')
assert.ok(!refreshed.includes('做出长期记忆插件'), '同名分节应替换而不是追加')
assert.ok(refreshed.includes('在写 DSH 插件'), '未提及的分节应保留')
assert.equal((refreshed.match(/^## 相关$/gm) ?? []).length, 1, '`相关` 分节重复了')

// 6. 索引重建
const rebuilt = vault.rebuildIndex()
assert.equal(rebuilt.entries, 4)

// 7. 上下文摘要体积受控
const digest = vault.composeContextDigest({ recent: 5 })
assert.ok(digest.includes('用户画像'))
assert.ok(digest.includes('近期记忆'))
assert.ok(digest.length < 8000, `digest 太大: ${digest.length}`)

// 8. 会话折叠
const events = [
  { type: 'user/message', seq: 1, time: 0, data: { turn: 1, message: { content: [{ type: 'text', text: '帮我写个插件' }] } } },
  { type: 'assistant/message', seq: 2, time: 0, data: { turn: 1, message: { content: [{ type: 'text', text: '好,先看需求。' }] } } },
  { type: 'tool/call', seq: 3, time: 0, data: { turn: 1, name: 'read', arguments: '{"path":"D:\\\\dsh\\\\AGENTS.md"}' } },
  { type: 'turn/end', seq: 4, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
]
const folded = foldConversation(events)
assert.equal(folded.userMessages, 1)
assert.equal(folded.assistantMessages, 1)
assert.equal(folded.turns.length, 1)
assert.equal(folded.lastSeq, 4)
assert.ok(renderConversationDigest(folded).includes('帮我写个插件'))
const incremental = foldConversation(events, { fromSeq: 2 })
assert.equal(incremental.userMessages, 0, '增量折叠应从游标之后开始')

// 9. 设置归一化
const normalized = normaliseSettings({ autoWriteTurns: '9999', autoWriteMode: 'bogus', injectRecent: -3 })
assert.equal(normalized.autoWriteTurns, 200)
assert.equal(normalized.autoWriteMode, DEFAULT_SETTINGS.autoWriteMode)
assert.equal(normalized.injectRecent, 0)

// 10. JSON 宽松解析
assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 })
assert.deepEqual(parseJsonLoose('前缀 {"b":2} 后缀'), { b: 2 })
assert.equal(parseJsonLoose('不是 json'), undefined)

// 11. 压缩件落盘 + 共享范围
const zipsDir = join(root, 'zips')
writeFileSync(join(zipsDir, 'demo.md'), composeMarkdown({
  type: 'ai-memory-zip', title: '示例压缩', session: 'session-abc', scope: 'session', date: today,
}, '# 示例压缩\n\n内容。\n'), 'utf8')
const own = vault.selectZips({ session: 'session-abc' })
assert.equal(own.length, 1)
// 关键:库里存的是 `session-abc`,查询用裸 `abc` 也必须命中(反之亦然)。
const ownBare = vault.selectZips({ session: 'abc' })
assert.equal(ownBare.length, 1, '裸会话 id 查不到自己的压缩件')
const other = vault.selectZips({ session: 'session-other' })
assert.equal(other.length, 0)
const shared = vault.selectZips({ session: 'session-other', shareAll: true })
assert.equal(shared.length, 1)

// 11b. 会话页文件名归一:两种写法落到同一页
vault.writeEntries({ sessionId: 'session-abc', sessionTitle: '归一测试', entries: [{ title: '归一甲', kind: 'fact', text: '甲' }] })
vault.writeEntries({ sessionId: 'abc', sessionTitle: '归一测试', entries: [{ title: '归一乙', kind: 'fact', text: '乙' }] })
const sessionPages = readdirSync(join(root, 'sessions')).filter((name) => name.endsWith('.md'))
assert.deepEqual(sessionPages, ['session-abc.md'], `会话页出现了重复: ${sessionPages.join(', ')}`)
const pageText = readFileSync(join(root, 'sessions', 'session-abc.md'), 'utf8')
assert.ok(pageText.includes('归一甲') && pageText.includes('归一乙'), '两次写入没并到同一会话页')

// 11c. 同会话同标题重写不产生重复条目
const beforeRewrite = readdirSync(join(root, 'memories')).filter((name) => name.endsWith('.md')).length
const rewrite = vault.writeEntries({
  sessionId: 'abc',
  sessionTitle: '归一测试',
  entries: [{ title: '归一甲', kind: 'fact', text: '甲(改写后)' }],
})
assert.equal(rewrite.written[0].updated, true, '同标题应复用原文件')
const afterRewrite = readdirSync(join(root, 'memories')).filter((name) => name.endsWith('.md')).length
assert.equal(afterRewrite, beforeRewrite, '重写把条目写成了重复文件')
assert.ok(readFileSync(join(root, rewrite.written[0].path), 'utf8').includes('甲(改写后)'), '重写没覆盖内容')

// 12. 越界路径被拦
let escaped = false
try {
  vault.resolveInside('../../etc/passwd')
} catch {
  escaped = true
}
assert.ok(escaped, '路径越界没被拦住')

// 13. 状态
const stats = vault.stats()
assert.equal(stats.entries, 6)
assert.ok(stats.profile === true)
assert.ok(stats.bytes > 0)

// 3b. 死链过滤:指向不存在条目的链接不写进文件(否则 Obsidian 里是一堆空节点)
const dangling = vault.writeEntries({
  sessionId: 'session-abc',
  sessionTitle: '插件开发',
  entries: [{ title: '死链测试', kind: 'fact', text: '测死链。', links: ['根本不存在的条目', '记忆库设计'] }],
})
const danglingText = readFileSync(join(root, dangling.written[0].path), 'utf8')
assert.ok(danglingText.includes('[[记忆库设计]]'), '有效链接被误删')
assert.ok(!danglingText.includes('根本不存在的条目'), '死链没被过滤')

rmSync(root, { recursive: true, force: true })
console.log('selfcheck: all assertions passed')
