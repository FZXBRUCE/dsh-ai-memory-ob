/**
 * dsh-ai-memory-ob — 插件设置。
 *
 * 设置刻意放在库外(`$DSH_HOME/.dsh-ai-memory-ob.json`),这样用户换库路径时
 * 设置本身不会跟着丢;库内的 `.dsh/index.json` 只是派生缓存。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** DSH_HOME(与宿主一致:环境变量优先,否则 ~/.dsh)。 */
export function dshHome() {
  const raw = process.env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = raw.trim()
    return isAbsolute(value) ? value : resolve(process.cwd(), value)
  }
  return join(homedir(), '.dsh')
}

/** 设置文件路径。 */
export function settingsPath() {
  return join(dshHome(), '.dsh-ai-memory-ob.json')
}

/** 默认设置。 */
export const DEFAULT_SETTINGS = Object.freeze({
  /** 记忆库根目录;空 = `$DSH_HOME/ai-memory`。 */
  vaultPath: '',
  /** 自动写入:off = 只认 /write;turns = 每 N 轮写一次。 */
  autoWriteMode: 'turns',
  /** N 轮。 */
  autoWriteTurns: 5,
  /** 新会话首轮就自动读取并注入记忆。 */
  autoInject: true,
  /** 注入时带多少条近期记忆。 */
  injectRecent: 12,
  /** 注入是否包含用户画像。 */
  injectProfile: true,
  /** 注入是否包含压缩记忆。 */
  injectZips: false,
  /** 压缩记忆是否跨窗口共享(关闭 = 只给压缩它的那个窗口用)。 */
  zipShareAll: false,
  /** 注入文本硬上限(字符),防止上下文被记忆挤爆。 */
  injectBudgetChars: 4200,
  /** 单次写入最多生成多少条记忆。 */
  writeMaxEntries: 8,
  /** /new 全量重建时最多处理多少个会话。 */
  newMaxSessions: 8,
  /** 显式指定归纳用的模型,空 = 跟随当前会话/默认模型。 */
  model: '',
  /** 归纳时是否把工具名与文件路径一起喂给模型(更准,也更费 token)。 */
  includeToolDigest: true,
  /**
   * 新会话的默认开关状态。
   * 关掉后:不自动注入、不自动写入,但命令与工具仍可用(用户随时能手动触发)。
   * 单个会话可以在输入框下方的小按钮里单独覆盖。
   */
  defaultSessionEnabled: true,
  /** 关掉的会话是否仍允许命令与工具(默认允许,用户主动调才用)。 */
  disabledAllowsManual: true,
  /** 注入时附带一句"记忆里没有就别猜"的提示,减少模型瞎编。 */
  injectGroundingHint: true,
})

/** 归一化(容错:未知值回落默认)。 */
export function normaliseSettings(raw) {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const mode = value.autoWriteMode === 'off' || value.autoWriteMode === 'turns' ? value.autoWriteMode : DEFAULT_SETTINGS.autoWriteMode
  const number = (input, fallback, min, max) => {
    const parsed = Number(input)
    if (!Number.isFinite(parsed)) return fallback
    return Math.max(min, Math.min(max, Math.round(parsed)))
  }
  return {
    vaultPath: typeof value.vaultPath === 'string' ? value.vaultPath.trim() : DEFAULT_SETTINGS.vaultPath,
    autoWriteMode: mode,
    autoWriteTurns: number(value.autoWriteTurns, DEFAULT_SETTINGS.autoWriteTurns, 1, 200),
    autoInject: typeof value.autoInject === 'boolean' ? value.autoInject : DEFAULT_SETTINGS.autoInject,
    injectRecent: number(value.injectRecent, DEFAULT_SETTINGS.injectRecent, 0, 40),
    injectProfile: typeof value.injectProfile === 'boolean' ? value.injectProfile : DEFAULT_SETTINGS.injectProfile,
    injectZips: typeof value.injectZips === 'boolean' ? value.injectZips : DEFAULT_SETTINGS.injectZips,
    zipShareAll: typeof value.zipShareAll === 'boolean' ? value.zipShareAll : DEFAULT_SETTINGS.zipShareAll,
    injectBudgetChars: number(value.injectBudgetChars, DEFAULT_SETTINGS.injectBudgetChars, 400, 40_000),
    writeMaxEntries: number(value.writeMaxEntries, DEFAULT_SETTINGS.writeMaxEntries, 1, 20),
    newMaxSessions: number(value.newMaxSessions, DEFAULT_SETTINGS.newMaxSessions, 1, 200),
    model: typeof value.model === 'string' ? value.model.trim() : '',
    includeToolDigest: typeof value.includeToolDigest === 'boolean' ? value.includeToolDigest : DEFAULT_SETTINGS.includeToolDigest,
    defaultSessionEnabled: typeof value.defaultSessionEnabled === 'boolean' ? value.defaultSessionEnabled : DEFAULT_SETTINGS.defaultSessionEnabled,
    disabledAllowsManual: typeof value.disabledAllowsManual === 'boolean' ? value.disabledAllowsManual : DEFAULT_SETTINGS.disabledAllowsManual,
    injectGroundingHint: typeof value.injectGroundingHint === 'boolean' ? value.injectGroundingHint : DEFAULT_SETTINGS.injectGroundingHint,
  }
}

/** 读设置(文件不存在 = 默认值)。 */
export function loadSettings() {
  const path = settingsPath()
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS, path }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return { ...normaliseSettings(parsed), path }
  } catch {
    return { ...DEFAULT_SETTINGS, path }
  }
}

/** 写设置(只合并已知字段)。 */
export function saveSettings(patch) {
  const current = loadSettings()
  const merged = normaliseSettings({ ...current, ...(patch ?? {}) })
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  return { ...merged, path }
}

/** 库根目录(绝对路径)。 */
export function vaultRoot(settings = loadSettings()) {
  const configured = settings.vaultPath
  if (typeof configured === 'string' && configured.trim() !== '') {
    const value = configured.trim().replace(/^~(?=$|[\\/])/, homedir())
    return isAbsolute(value) ? resolve(value) : resolve(dshHome(), value)
  }
  return join(dshHome(), 'ai-memory')
}
