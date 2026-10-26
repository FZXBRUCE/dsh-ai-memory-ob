/**
 * dsh-ai-memory-ob — 浏览器半边。
 *
 * 在设置里加一页「AI 记忆库」:状态概览、写入/注入/压缩/图谱操作、
 * 全部设置项、以及记忆库文件浏览。数据全走宿主侧的只读路由
 * `/api/dsh-ai-memory-ob/*`,前端不碰磁盘。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ai-memory-ob',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** 设置页路由前缀。 */
    const API = '/api/dsh-ai-memory-ob'

    // ------------------------------------------------------------ 文案

    const ZH = {
      nav: 'AI 记忆库',
      title: 'AI 记忆库',
      intro: '每次对话都会被归纳成记忆条目和用户画像,以 Obsidian 库的形式落盘(双链即图谱)。',
      statsEntries: '条目',
      statsSize: '体积',
      statsZips: '压缩件',
      statsLast: '上次写入',
      never: '从未',
      model: '归纳模型',
      autoWrite: '自动写入',
      autoInject: '自动注入',
      on: '开',
      off: '关',
      actions: '操作',
      actWrite: '立刻写入本窗',
      actLoad: '重新注入记忆',
      actZip: '压缩本窗',
      actUpdate: '重建图谱',
      actReindex: '重建索引',
      actExport: '导出图谱 JSON',
      needsSession: '这个操作需要一个打开着的会话。',
      settings: '设置',
      vaultPath: '库文件夹',
      vaultPathHint: '绝对路径或 ~/路径。留空 = $DSH_HOME/ai-memory。',
      autoWriteMode: '自动写入方式',
      modeOff: '关闭(只用 /write)',
      modeTurns: '每 N 轮写一次',
      turns: '每几次写入',
      injectRecent: '注入的近期条目数',
      budget: '注入字符上限',
      maxEntries: '单次写入最多条目',
      newSessions: '/new 扫描的会话数',
      modelLabel: '归纳模型(provider/model,留空跟随会话)',
      toggles: '开关',
      toggleInject: '新会话自动注入记忆',
      toggleProfile: '注入用户画像',
      toggleZips: '注入压缩记忆',
      toggleShare: '压缩记忆跨窗口共享',
      toggleTools: '摘要素材带工具名与文件路径',
      save: '保存',
      saved: '已保存',
      reset: '恢复默认',
      browse: '库浏览',
      up: '上一级',
      empty: '空文件夹',
      pickFile: '点左侧文件查看内容',
      loading: '加载中…',
      error: '连不上记忆服务',
      running: '执行中…',
      openFolder: '库路径',
    }

    const EN = {
      nav: 'AI Memory',
      title: 'AI Memory',
      intro: 'Every conversation is distilled into memory notes and a user profile, stored as an Obsidian vault (links become the graph).',
      statsEntries: 'Entries',
      statsSize: 'Size',
      statsZips: 'Compressed',
      statsLast: 'Last write',
      never: 'never',
      model: 'Summarizer',
      autoWrite: 'Auto write',
      autoInject: 'Auto inject',
      on: 'on',
      off: 'off',
      actions: 'Actions',
      actWrite: 'Write this window now',
      actLoad: 'Re-inject memory',
      actZip: 'Compress this window',
      actUpdate: 'Rebuild graph',
      actReindex: 'Rebuild index',
      actExport: 'Export graph JSON',
      needsSession: 'This action needs an open conversation.',
      settings: 'Settings',
      vaultPath: 'Vault folder',
      vaultPathHint: 'Absolute path or ~/path. Empty = $DSH_HOME/ai-memory.',
      autoWriteMode: 'Automatic write',
      modeOff: 'Off (only /write)',
      modeTurns: 'Every N turns',
      turns: 'Turns per write',
      injectRecent: 'Recent entries to inject',
      budget: 'Injection character budget',
      maxEntries: 'Max entries per write',
      newSessions: 'Sessions scanned by /new',
      modelLabel: 'Summarizer model (provider/model, empty = follow session)',
      toggles: 'Toggles',
      toggleInject: 'Inject memory into new sessions',
      toggleProfile: 'Include the user profile',
      toggleZips: 'Include compressed memories',
      toggleShare: 'Share compressed memories across sessions',
      toggleTools: 'Include tool names and file paths in the digest',
      save: 'Save',
      saved: 'Saved',
      reset: 'Reset to defaults',
      browse: 'Vault browser',
      up: 'Up',
      empty: 'Empty folder',
      pickFile: 'Pick a file on the left',
      loading: 'Loading…',
      error: 'Cannot reach the memory service',
      running: 'Working…',
      openFolder: 'Vault',
    }

    /** 当前语言下的文案(优先宿主 locale,退到本地表)。 */
    function pickDict() {
      let lang = ''
      try {
        lang = String(document?.documentElement?.lang ?? navigator?.language ?? '')
      } catch {
        lang = ''
      }
      return /^zh/i.test(lang) ? ZH : EN
    }

    /** 恢复默认时提交的值,必须与宿主 DEFAULT_SETTINGS 一致。 */
    const DEFAULTS = {
      vaultPath: '',
      autoWriteMode: 'turns',
      autoWriteTurns: 5,
      autoInject: true,
      injectRecent: 12,
      injectProfile: true,
      injectZips: false,
      zipShareAll: false,
      injectBudgetChars: 4200,
      writeMaxEntries: 8,
      newMaxSessions: 8,
      model: '',
      includeToolDigest: true,
    }

    // ------------------------------------------------------------ 样式

    const CSS = [
      '.aimem{display:flex;flex-direction:column;gap:16px;font-size:13px;color:var(--dsw-alias-label-primary);padding:2px 0}',
      '.aimem h3{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}',
      '.aimem .intro{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:0}',
      '.aimem .card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
      '.aimem .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}',
      '.aimem .stat{display:flex;flex-direction:column;gap:2px}',
      '.aimem .stat b{font-size:16px;font-weight:600}',
      '.aimem .stat span{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.aimem .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.aimem .field{display:flex;flex-direction:column;gap:4px;flex:1;min-width:180px}',
      '.aimem .field label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.aimem .hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.aimem input[type=text],.aimem input[type=number],.aimem select{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:13px;outline:none;min-width:0}',
      '.aimem input[type=text]:focus,.aimem input[type=number]:focus,.aimem select:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.aimem button{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer}',
      '.aimem button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.aimem button:disabled{opacity:.5;cursor:default}',
      '.aimem button.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
      '.aimem .toggle{display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;user-select:none}',
      '.aimem .toggle input{accent-color:var(--dsw-alias-brand-primary)}',
      '.aimem .output{white-space:pre-wrap;font-size:12px;line-height:1.6;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;max-height:220px;overflow:auto}',
      '.aimem .browse{display:grid;grid-template-columns:220px 1fr;gap:10px;min-height:180px}',
      '.aimem .tree{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:auto;max-height:300px;background:var(--dsw-alias-bg-layer-2)}',
      '.aimem .tree button{display:block;width:100%;text-align:left;border:none;border-radius:0;background:transparent;padding:5px 10px;font-size:12px}',
      '.aimem .tree button:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.aimem .tree button.file{color:var(--dsw-alias-label-secondary)}',
      '.aimem .preview{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;background:var(--dsw-alias-bg-base);overflow:auto;max-height:300px;white-space:pre-wrap;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.aimem .err{color:var(--dsw-alias-state-error-primary);font-size:12px}',
      '.aimem .ok{color:var(--dsw-alias-state-success-primary);font-size:12px}',
    ].join('')

    /** 一个只挂载一次的 <style>(组件卸载即移除)。 */
    function StyleOnce() {
      React.useEffect(() => {
        const tag = document.createElement('style')
        tag.setAttribute('data-dsh-ai-memory-ob', 'panel')
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, [])
      return null
    }

    // ------------------------------------------------------------ 数据访问

    async function getJson(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }

    async function postJson(path, payload) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }

    /** 主视图里那个会话 id(读会话目录的 retainedBy.mainView 标记)。 */
    function currentSessionId(ctx) {
      try {
        const sessions = ctx.get('sessions')
        const snapshot = sessions?.list?.getSnapshot?.()
        const byId = snapshot?.byId
        if (byId === undefined || byId === null) return undefined
        for (const row of Object.values(byId)) {
          if (row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) return String(row.id)
        }
        return undefined
      } catch {
        return undefined
      }
    }

    // ------------------------------------------------------------ 组件

    function MemoryPanel(props) {
      const ctx = props.ctx
      const dict = React.useMemo(() => pickDict(), [])
      const [state, setState] = React.useState(undefined)
      const [draft, setDraft] = React.useState(undefined)
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(undefined)
      const [error, setError] = React.useState('')
      const [tree, setTree] = React.useState({ path: '', entries: [] })
      const [preview, setPreview] = React.useState(undefined)

      const refresh = React.useCallback(async () => {
        try {
          const next = await getJson(`${API}/state`)
          setState(next)
          setDraft(next.settings)
          setError('')
        } catch (issue) {
          setError(issue instanceof Error ? issue.message : String(issue))
        }
      }, [])

      const refreshTree = React.useCallback(async (path) => {
        try {
          const next = await getJson(`${API}/tree?path=${encodeURIComponent(path ?? '')}`)
          setTree({ path: next.path ?? '', entries: next.entries ?? [] })
        } catch (issue) {
          setError(issue instanceof Error ? issue.message : String(issue))
        }
      }, [])

      React.useEffect(() => {
        void refresh()
        void refreshTree('')
      }, [refresh, refreshTree])

      const run = async (action, payload) => {
        setBusy(action)
        setMessage(undefined)
        setError('')
        try {
          const result = await postJson(`${API}/action`, { action, sessionId: currentSessionId(ctx), ...(payload ?? {}) })
          setMessage({ ok: result.ok !== false, text: String(result.text ?? '') })
          await refresh()
          await refreshTree(tree.path)
        } catch (issue) {
          setError(issue instanceof Error ? issue.message : String(issue))
        } finally {
          setBusy('')
        }
      }

      const save = async () => {
        setBusy('save')
        setError('')
        try {
          const next = await postJson(`${API}/settings`, draft ?? {})
          setState(next)
          setDraft(next.settings)
          setMessage({ ok: true, text: dict.saved })
        } catch (issue) {
          setError(issue instanceof Error ? issue.message : String(issue))
        } finally {
          setBusy('')
        }
      }

      const openFile = async (path) => {
        try {
          const file = await getJson(`${API}/file?path=${encodeURIComponent(path)}`)
          setPreview(file?.ok === true ? { path, text: file.text } : undefined)
        } catch (issue) {
          setError(issue instanceof Error ? issue.message : String(issue))
        }
      }

      const update = (patch) => setDraft((current) => ({ ...(current ?? {}), ...patch }))

      if (error !== '' && state === undefined) {
        return h('div', { className: 'aimem' }, h(StyleOnce), h('div', { className: 'err' }, `${dict.error}: ${error}`))
      }
      if (state === undefined || draft === undefined) {
        return h('div', { className: 'aimem' }, h(StyleOnce), h('div', { className: 'hint' }, dict.loading))
      }

      const vault = state.vault ?? {}
      const hasSession = currentSessionId(ctx) !== undefined
      const kb = ((vault.bytes ?? 0) / 1024).toFixed(1)

      return h('div', { className: 'aimem' },
        h(StyleOnce),
        h('div', null,
          h('h3', null, dict.title),
          h('p', { className: 'intro' }, dict.intro),
        ),

        // 概览
        h('div', { className: 'card' },
          h('div', { className: 'grid' },
            h('div', { className: 'stat' }, h('b', null, String(vault.entries ?? 0)), h('span', null, dict.statsEntries)),
            h('div', { className: 'stat' }, h('b', null, `${kb} KB`), h('span', null, dict.statsSize)),
            h('div', { className: 'stat' }, h('b', null, String(vault.zips ?? 0)), h('span', null, dict.statsZips)),
            h('div', { className: 'stat' }, h('b', null, String(vault.graphNotes ?? 0)), h('span', null, 'Graph notes')),
          ),
          h('div', { className: 'row' },
            h('span', { className: 'hint' }, `${dict.openFolder}: ${vault.root ?? ''}`),
          ),
          h('div', { className: 'row' },
            h('span', { className: 'hint' }, `${dict.statsLast}: ${vault.lastWrite ?? dict.never}`),
            h('span', { className: 'hint' }, `· ${dict.model}: ${state.model ?? '—'}`),
            h('span', { className: 'hint' }, `· ${dict.autoWrite}: ${draft.autoWriteMode === 'turns' ? `${draft.autoWriteTurns}` : dict.off}`),
            h('span', { className: 'hint' }, `· ${dict.autoInject}: ${draft.autoInject ? dict.on : dict.off}`),
          ),
        ),

        // 操作
        h('div', { className: 'card' },
          h('h3', null, dict.actions),
          h('div', { className: 'row' },
            h('button', { disabled: busy !== '' || !hasSession, onClick: () => void run('write'), title: hasSession ? '' : dict.needsSession }, dict.actWrite),
            h('button', { disabled: busy !== '' || !hasSession, onClick: () => void run('load'), title: hasSession ? '' : dict.needsSession }, dict.actLoad),
            h('button', { disabled: busy !== '' || !hasSession, onClick: () => void run('zip'), title: hasSession ? '' : dict.needsSession }, dict.actZip),
            h('button', { disabled: busy !== '', onClick: () => void run('update') }, dict.actUpdate),
            h('button', { disabled: busy !== '', onClick: () => void run('reindex') }, dict.actReindex),
            h('button', { disabled: busy !== '', onClick: () => void run('export') }, dict.actExport),
          ),
          busy !== '' ? h('div', { className: 'hint' }, dict.running) : null,
          message !== undefined
            ? h('div', { className: message.ok ? 'output' : 'err' }, message.text)
            : null,
          error !== '' ? h('div', { className: 'err' }, error) : null,
          hasSession ? null : h('div', { className: 'hint' }, dict.needsSession),
        ),

        // 设置
        h('div', { className: 'card' },
          h('h3', null, dict.settings),
          h('div', { className: 'field' },
            h('label', null, dict.vaultPath),
            h('input', {
              type: 'text',
              value: draft.vaultPath ?? '',
              placeholder: '$DSH_HOME/ai-memory',
              onChange: (event) => update({ vaultPath: event.target.value }),
            }),
            h('span', { className: 'hint' }, dict.vaultPathHint),
          ),
          h('div', { className: 'row' },
            h('div', { className: 'field' },
              h('label', null, dict.autoWriteMode),
              h('select', {
                value: draft.autoWriteMode,
                onChange: (event) => update({ autoWriteMode: event.target.value }),
              },
              h('option', { value: 'turns' }, dict.modeTurns),
              h('option', { value: 'off' }, dict.modeOff)),
            ),
            h('div', { className: 'field' },
              h('label', null, dict.turns),
              h('input', {
                type: 'number', min: 1, max: 200, value: draft.autoWriteTurns,
                onChange: (event) => update({ autoWriteTurns: Number(event.target.value) }),
              }),
            ),
            h('div', { className: 'field' },
              h('label', null, dict.injectRecent),
              h('input', {
                type: 'number', min: 0, max: 40, value: draft.injectRecent,
                onChange: (event) => update({ injectRecent: Number(event.target.value) }),
              }),
            ),
          ),
          h('div', { className: 'row' },
            h('div', { className: 'field' },
              h('label', null, dict.budget),
              h('input', {
                type: 'number', min: 400, max: 40000, step: 200, value: draft.injectBudgetChars,
                onChange: (event) => update({ injectBudgetChars: Number(event.target.value) }),
              }),
            ),
            h('div', { className: 'field' },
              h('label', null, dict.maxEntries),
              h('input', {
                type: 'number', min: 1, max: 20, value: draft.writeMaxEntries,
                onChange: (event) => update({ writeMaxEntries: Number(event.target.value) }),
              }),
            ),
            h('div', { className: 'field' },
              h('label', null, dict.newSessions),
              h('input', {
                type: 'number', min: 1, max: 200, value: draft.newMaxSessions,
                onChange: (event) => update({ newMaxSessions: Number(event.target.value) }),
              }),
            ),
          ),
          h('div', { className: 'field' },
            h('label', null, dict.modelLabel),
            h('input', {
              type: 'text', value: draft.model ?? '', placeholder: 'provider/model',
              onChange: (event) => update({ model: event.target.value }),
            }),
          ),
          h('h3', null, dict.toggles),
          h('div', { className: 'grid' },
            toggle(dict.toggleInject, draft.autoInject, (value) => update({ autoInject: value })),
            toggle(dict.toggleProfile, draft.injectProfile, (value) => update({ injectProfile: value })),
            toggle(dict.toggleZips, draft.injectZips, (value) => update({ injectZips: value })),
            toggle(dict.toggleShare, draft.zipShareAll, (value) => update({ zipShareAll: value })),
            toggle(dict.toggleTools, draft.includeToolDigest, (value) => update({ includeToolDigest: value })),
          ),
          h('div', { className: 'row' },
            h('button', { className: 'primary', disabled: busy !== '', onClick: () => void save() }, dict.save),
            h('button', {
              disabled: busy !== '',
              onClick: () => {
                // 恢复默认:提交与宿主 DEFAULT_SETTINGS 相同的值,而不是把当前值再存一遍。
                setDraft({ ...DEFAULTS })
                void postJson(`${API}/settings`, { ...DEFAULTS }).then((next) => {
                  setState(next)
                  setDraft(next.settings)
                  setMessage({ ok: true, text: dict.saved })
                  setError('')
                }).catch((issue) => {
                  setError(issue instanceof Error ? issue.message : String(issue))
                })
              },
            }, dict.reset),
          ),
        ),

        // 库浏览
        h('div', { className: 'card' },
          h('h3', null, dict.browse),
          h('div', { className: 'row' },
            h('span', { className: 'hint' }, tree.path === '' ? dict.openFolder : `/${tree.path}`),
            tree.path !== ''
              ? h('button', {
                onClick: () => {
                  const parts = tree.path.split('/')
                  parts.pop()
                  void refreshTree(parts.join('/'))
                },
              }, dict.up)
              : null,
          ),
          h('div', { className: 'browse' },
            h('div', { className: 'tree' },
              tree.entries.length === 0
                ? h('div', { className: 'hint', style: { padding: '8px 10px' } }, dict.empty)
                : tree.entries.map((entry) => h('button', {
                  key: entry.path,
                  className: entry.dir ? 'dir' : 'file',
                  onClick: () => {
                    if (entry.dir) void refreshTree(entry.path)
                    else void openFile(entry.path)
                  },
                }, `${entry.dir ? '▸ ' : '  '}${entry.name}`)),
            ),
            h('div', { className: 'preview' },
              preview === undefined
                ? dict.pickFile
                : `# ${preview.path}\n\n${preview.text}`),
          ),
        ),
      )
    }

    /** 一个带文案的复选框。 */
    function toggle(label, value, onChange) {
      return h('label', { className: 'toggle', key: label },
        h('input', {
          type: 'checkbox',
          checked: value === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', null, label),
      )
    }

    // ------------------------------------------------------------ 注册

    /** 需要的客户端服务。 */
    const inject = ['slots']

    function apply(ctx) {
      let slots
      try {
        slots = ctx.get('slots')
      } catch {
        slots = undefined
      }
      if (slots === undefined) return () => {}
      const dict = pickDict()
      const disposers = []
      try {
        disposers.push(slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'dsh-ai-memory-ob',
          order: 152,
          label: () => dict.nav,
        }, (props) => h(MemoryPanel, { ...props, ctx }))))
      } catch {
        // 设置页座位不可用时保持安静:命令与工具仍然可用。
      }
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

    return { apply, inject }
  },
})
