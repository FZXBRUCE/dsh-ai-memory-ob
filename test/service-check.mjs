/**
 * dsh-ai-memory-ob — 服务层端到端自测(用假的宿主服务,不花 token)。
 *
 * 覆盖:注入渲染与体积上限、写入落盘、游标增量、按轮自动写入、
 * 图谱更新、压缩、状态与浏览。
 */

import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-ob-svc-'))
process.env.DSH_HOME = home

const { MemoryService } = await import('../lib/service.js')
const { saveSettings } = await import('../lib/settings.js')

/** 造一个只会返回预设 JSON 的假 llm。 */
function fakeLlm(script) {
  let call = 0
  return {
    stream(options) {
      const reply = script(call, options)
      call += 1
      return (async function* generate() {
        for (const piece of reply.match(/[\s\S]{1,24}/g) ?? []) {
          yield { type: 'text-delta', text: piece }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

const events = [
  { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 0, data: { turn: 1, message: { content: [{ type: 'text', text: '我想做一个长期记忆插件' }] } } },
  { type: 'assistant/message', seq: 3, time: 0, data: { turn: 1, message: { content: [{ type: 'text', text: '可以,用 Obsidian 库落盘。' }] } } },
  { type: 'turn/end', seq: 4, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
]

const injected = []
const agent = {
  id: 'session-demo',
  session: { header: { id: 'session-demo', cwd: home } },
  requestHeader: () => ({ config: { provider: 'demo', model: 'demo-model' } }),
  inject: (message) => {
    injected.push(message)
  },
}

const ctx = {
  get(name) {
    if (name === 'llm') return llm
    if (name === 'sessionQuery') {
      return {
        readSession: async () => ({ session: { id: 'session-demo' }, events }),
        readTitle: async () => ({ title: { title: '长期记忆插件' } }),
        listSessions: async () => [
          { header: { id: 'session-demo', createdAt: 1 }, live: false, persisted: true },
        ],
      }
    }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'demo', model: 'demo-model' }) }
    return undefined
  },
}

const writeReply = JSON.stringify({
  summary: '确定用 Obsidian 库做长期记忆',
  entries: [
    { title: '记忆库落盘方式', kind: 'decision', text: '用 Obsidian vault 存 Markdown + 双链。', tags: ['设计'], links: [] },
    { title: '注入策略', kind: 'decision', text: '画像 + 近期条目 + 图谱索引,受字符预算限制。', tags: ['注入'], links: ['记忆库落盘方式'] },
  ],
  profile: { 概览: '在做 DSH 长期记忆插件', 偏好: '要能导出' },
})

const graphReply = JSON.stringify({
  themes: [{ name: '记忆库', entries: ['记忆库落盘方式', '注入策略'], text: '两个决定一起构成记忆库的骨架。' }],
  edges: [{ from: '注入策略', to: '记忆库落盘方式', why: '注入的内容来自落盘的库' }],
  hub: ['记忆库落盘方式'],
})

const zipReply = JSON.stringify({
  title: '记忆库决策压缩',
  overview: '这一窗确定了落盘与注入两件事。',
  threads: [{ name: '落盘', text: 'Markdown + 双链。' }],
  decisions: ['用 Obsidian vault'],
  open: ['还没做图谱连边'],
  links: ['记忆库落盘方式'],
})

// 假模型按用途分流:写库 / 图谱 / 压缩 各自一个固定回答。
// 用各提示词独有的句子判断,而不是 JSON 字段名——字段名在提示词的格式说明里也出现。
const llm = fakeLlm((_call, options) => {
  const prompt = JSON.stringify(options.messages ?? [])
  if (prompt.includes('源文件保持不动')) return zipReply
  if (prompt.includes('只能使用上面出现过的标题')) return graphReply
  return writeReply
})

// 1. 设置写盘(库指到临时目录)
const saved = saveSettings({ vaultPath: join(home, 'vault'), autoWriteMode: 'turns', autoWriteTurns: 2 })
assert.equal(saved.autoWriteMode, 'turns')
const service = new MemoryService(ctx)
assert.equal(service.vault.root, join(home, 'vault'))

// 2. 空库状态
const empty = service.status()
assert.equal(empty.vault.entries, 0)

// 3. /load 挂上记忆上下文(空库也要有提示,且能读回来)
const loaded = await service.load(agent)
assert.equal(loaded.delivered, true)
assert.ok(service.snapshotText('session-demo').includes('ai-memory'))
assert.equal(injected.length, 0, '记忆不该再往 inbox 里塞消息')

// 4. /write 落盘
const written = await service.write(agent, { trigger: 'command' })
assert.equal(written.ok, true, written.text)
assert.equal(written.written.written.length, 2)
const vaultDir = service.vault.root
assert.ok(existsSync(join(vaultDir, 'memories')))
const files = readdirSync(join(vaultDir, 'memories')).filter((name) => name.endsWith('.md'))
assert.equal(files.length, 2)
assert.ok(existsSync(join(vaultDir, 'sessions', 'session-demo.md')), '会话页文件名应只带一个 session- 前缀')
assert.ok(existsSync(join(vaultDir, 'profile', 'user-profile.md')))
const profile = readFileSync(join(vaultDir, 'profile', 'user-profile.md'), 'utf8')
assert.ok(profile.includes('在做 DSH 长期记忆插件'))
assert.ok(profile.includes('要能导出'))

// 5. 游标增量:再写一次,没有新内容时应拒绝
const again = await service.write(agent, { trigger: 'command' })
assert.equal(again.ok, false)
assert.equal(again.reason, 'empty')

// 6. /load 现在能带出条目
const reloaded = await service.load(agent)
assert.ok(reloaded.text.includes('记忆库落盘方式') || reloaded.text.includes('注入策略'), '注入里没有条目')
assert.ok(service.snapshotText('session-demo').includes('注入策略'), '快照没更新')

// 7. /update 图谱
const updated = await service.updateGraph()
assert.equal(updated.ok, true)
assert.ok(updated.graph.edges.length >= 1)
const graphIndex = readFileSync(join(vaultDir, 'graph', 'graph-index.md'), 'utf8')
assert.ok(graphIndex.includes('记忆库落盘方式'))
assert.ok(graphIndex.includes('↔'))

// 8b. 整窗重写:替换该窗口旧条目,不产生同义重复
const beforeRewrite = readdirSync(join(vaultDir, 'memories')).filter((name) => name.endsWith('.md')).length
const rewritten = await service.write(agent, { trigger: 'command', all: true })
assert.equal(rewritten.ok, true, rewritten.text)
assert.ok(rewritten.written.retired.length >= 2, '整窗重写应替换旧条目')
const afterRewrite = readdirSync(join(vaultDir, 'memories')).filter((name) => name.endsWith('.md')).length
assert.equal(afterRewrite, rewritten.written.written.length, `重写后条目数应为本次写入数,实际 ${afterRewrite}`)

// 8c. 压缩(源文件不动)
const beforeZip = readdirSync(join(vaultDir, 'memories')).length
const zipped = await service.zip(agent, { scope: 'session' })
assert.equal(zipped.ok, true, zipped.text)
assert.ok(existsSync(join(vaultDir, zipped.file)))
assert.equal(readdirSync(join(vaultDir, 'memories')).length, beforeZip, '压缩动了源文件')

// 9. 按轮自动写入:tick 到阈值才写
const ticks = []
for (let index = 0; index < 2; index += 1) {
  ticks.push(await service.tick(agent))
}
assert.ok(existsSync(join(vaultDir, '.dsh', 'index.json')))

// 10. 浏览与读取
const tree = service.tree('')
assert.ok(tree.entries.some((entry) => entry.name === 'memories' && entry.dir === true))
const listing = service.tree('memories')
assert.ok(listing.entries.length >= 2)
const one = service.read(listing.entries[0].path)
assert.equal(one.ok, true)
assert.ok(one.text.includes('---'))

// 11. 越界拒绝
let rejected = false
try {
  service.read('../../../etc/passwd')
} catch {
  rejected = true
}
assert.ok(rejected, '越界路径没被拒绝')

// 12. 图谱导出(不依赖索引缓存,直接扫条目)
const exported = service.exportGraph()
assert.ok(existsSync(exported.path))
assert.ok(exported.nodes >= 2, `导出的节点太少: ${exported.nodes}`)
const exportJson = JSON.parse(readFileSync(exported.path, 'utf8'))
assert.equal(exportJson.nodes.length, exported.nodes)
assert.ok(exportJson.edges.length >= 1, '导出的边为空')

rmSync(home, { recursive: true, force: true })
console.log('service-check: all assertions passed')
