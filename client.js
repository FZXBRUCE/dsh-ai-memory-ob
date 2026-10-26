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
      dockLabel: '记忆开关',
      dockOn: '记忆:开',
      dockOff: '记忆:关',
      dockHintOn: '本会话已启用记忆:会自动注入上下文并按设置自动归档',
      dockHintOnIdle: '本会话已启用记忆:下次组装提示时会带上',
      dockHintOff: '本会话已关闭记忆:不注入、不归档、不消耗 token;命令仍可手动用',
      toggleDefaultOn: '新会话默认启用记忆',
      toggleDefaultHint: '关掉后新会话默认不启用,可在输入框下方的按钮里单独打开某个会话。',
      toggleGrounding: '注入时提示"记忆里没有就别猜"',
      timeline: '记忆时间线',
      timelineEmpty: '还没有记忆。',
      updateTitle: '插件更新',
      updateCurrent: '当前版本',
      updateLatest: '远端版本',
      updateCheck: '检查更新',
      updateApply: '立即更新',
      updateApplying: '正在更新…',
      updateChecking: '检查中…',
      updateHint: '从 GitHub 拉取新版本。更新后通常需要停用再启用插件行才能加载新代码。',
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
      dockLabel: 'Memory',
      dockOn: 'Memory: on',
      dockOff: 'Memory: off',
      dockHintOn: 'Memory is on for this chat: it injects context and archives on schedule',
      dockHintOnIdle: 'Memory is on for this chat: it will be included on the next prompt',
      dockHintOff: 'Memory is off for this chat: no injection, no archiving, no token cost. Commands still work.',
      toggleDefaultOn: 'Enable memory in new chats by default',
      toggleDefaultHint: 'Turn off to start new chats with memory disabled; enable it per chat with the button under the composer.',
      toggleGrounding: 'Warn the model not to guess beyond memory',
      timeline: 'Memory timeline',
      timelineEmpty: 'No memories yet.',
      updateTitle: 'Plugin update',
      updateCurrent: 'Current',
      updateLatest: 'Remote',
      updateCheck: 'Check for updates',
      updateApply: 'Update now',
      updateApplying: 'Updating…',
      updateChecking: 'Checking…',
      updateHint: 'Pulls the latest version from GitHub. You usually need to disable and re-enable the plugin row to load the new code.',
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
      defaultSessionEnabled: true,
      disabledAllowsManual: true,
      injectGroundingHint: true,
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
      '.aimem .aimem-timeline{display:flex;flex-direction:column;gap:10px}',
      '.aimem .aimem-day{display:flex;flex-direction:column;gap:4px}',
      '.aimem .aimem-day-head{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.aimem .aimem-day-body{display:flex;flex-direction:column;gap:2px;padding-left:2px;border-left:2px solid var(--dsw-alias-border-l1)}',
      '.aimem .aimem-entry{text-align:left;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;padding:2px 8px;border-radius:6px;cursor:pointer}',
      '.aimem .aimem-entry:hover{background:var(--dsw-alias-bg-layer-2)}',
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
      const [timeline, setTimeline] = React.useState(undefined)
      const [updateState, setUpdateState] = React.useState({ current: undefined })

      const refresh = React.useCallback(async () => {
        try {
          const next = await getJson(`${API}/state`)
          setState(next)
          setDraft(next.settings)
          // 版本号从状态里带出来,更新卡片一打开就能显示"当前版本"。
          setUpdateState((current) => ({ ...current, current: next.version }))
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

      const refreshTimeline = React.useCallback(async () => {
        try {
          const next = await getJson(`${API}/timeline?limit=40`)
          setTimeline(next)
        } catch {
          setTimeline({ total: 0, days: [] })
        }
      }, [])

      React.useEffect(() => {
        void refresh()
        void refreshTree('')
        void refreshTimeline()
      }, [refresh, refreshTree, refreshTimeline])

      const run = async (action, payload) => {
        setBusy(action)
        setMessage(undefined)
        setError('')
        try {
          const result = await postJson(`${API}/action`, { action, sessionId: currentSessionId(ctx), ...(payload ?? {}) })
          setMessage({ ok: result.ok !== false, text: String(result.text ?? '') })
          await refresh()
          await refreshTree(tree.path)
          await refreshTimeline()
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

      /** 检查更新:只读,拉远端 package.json 比版本。 */
      const checkUpdate = async () => {
        setUpdateState((current) => ({ ...current, checking: true, text: undefined }))
        try {
          const result = await postJson(`${API}/action`, { action: 'check-update' })
          setUpdateState({
            current: result.current ?? updateState.current,
            latest: result.latest,
            hasUpdate: result.hasUpdate === true,
            sameVersion: result.sameVersion === true,
            ok: result.ok !== false,
            text: String(result.text ?? ''),
            checking: false,
          })
        } catch (issue) {
          setUpdateState((current) => ({
            ...current,
            checking: false,
            ok: false,
            text: issue instanceof Error ? issue.message : String(issue),
          }))
        }
      }

      /** 执行更新:让插件管理器从 GitHub 重装。会跑 pnpm,较慢。 */
      const applyUpdate = async () => {
        setUpdateState((current) => ({ ...current, applying: true, text: dict.updateApplying }))
        try {
          const result = await postJson(`${API}/action`, { action: 'apply-update' })
          setUpdateState((current) => ({
            ...current,
            applying: false,
            ok: result.ok !== false,
            hasUpdate: result.ok === true ? false : current.hasUpdate,
            latest: result.version ?? current.latest,
            text: String(result.text ?? ''),
          }))
        } catch (issue) {
          setUpdateState((current) => ({
            ...current,
            applying: false,
            ok: false,
            text: issue instanceof Error ? issue.message : String(issue),
          }))
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

        // 更新
        h('div', { className: 'card' },
          h('h3', null, dict.updateTitle),
          h('div', { className: 'row' },
            h('span', { className: 'hint' }, `${dict.updateCurrent}: v${updateState.current ?? '?'}`),
            updateState.latest !== undefined
              ? h('span', { className: 'hint' }, `· ${dict.updateLatest}: v${updateState.latest}`)
              : null,
            updateState.checking === true ? h('span', { className: 'hint' }, dict.updateChecking) : null,
          ),
          updateState.text !== undefined
            ? h('div', { className: updateState.ok === false ? 'err' : 'hint' }, updateState.text)
            : null,
          h('div', { className: 'row' },
            h('button', { disabled: busy !== '' || updateState.checking === true, onClick: () => void checkUpdate() }, dict.updateCheck),
            updateState.hasUpdate === true
              ? h('button', {
                className: 'primary',
                disabled: busy !== '' || updateState.applying === true,
                onClick: () => void applyUpdate(),
              }, updateState.applying === true ? dict.updateApplying : dict.updateApply)
              : null,
          ),
          h('p', { className: 'hint' }, dict.updateHint),
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
            toggle(dict.toggleDefaultOn, draft.defaultSessionEnabled, (value) => update({ defaultSessionEnabled: value })),
            toggle(dict.toggleGrounding, draft.injectGroundingHint, (value) => update({ injectGroundingHint: value })),
          ),
          h('p', { className: 'hint' }, dict.toggleDefaultHint),
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

        // 时间线
        h('div', { className: 'card' },
          h('h3', null, dict.timeline),
          timeline === undefined
            ? h('div', { className: 'hint' }, dict.loading)
            : timeline.days.length === 0
              ? h('div', { className: 'hint' }, dict.timelineEmpty)
              : h('div', { className: 'aimem-timeline' },
                timeline.days.slice(0, 8).map((day) => h('div', { key: day.day, className: 'aimem-day' },
                  h('div', { className: 'aimem-day-head' }, `${day.day} · ${day.count}`),
                  h('div', { className: 'aimem-day-body' },
                    day.entries.slice(0, 6).map((entry) => h('button', {
                      key: entry.file,
                      type: 'button',
                      className: 'aimem-entry',
                      title: entry.file,
                      onClick: () => void openFile(entry.file),
                    }, `[${entry.kind}] ${entry.title}`)),
                  ),
                )),
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

    // ------------------------------------------------------------ 会话开关按钮

    /**
     * 输入框下方的记忆开关。
     *
     * 只做一件事:让用户决定"这个会话要不要被记忆插件碰"。
     * 关掉后宿主侧不再自动注入、不再自动归档,也就不会消耗 token;
     * 命令与工具仍然可用,用户想手动用随时能调。
     *
     * 状态存在宿主内存里(按会话 id),不写盘 —— 一次性的决定不该污染全局设置。
     */
    function SessionToggle(props) {
      const sessionId = String(props?.sessionId ?? '')
      const [state, setState] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const dict = React.useMemo(() => pickDict(), [])

      const load = React.useCallback(async () => {
        if (sessionId === '') return
        try {
          const next = await getJson(`${API}/session?id=${encodeURIComponent(sessionId)}`)
          setState(next)
          setError('')
        } catch (issue) {
          setError(issue instanceof Error ? issue.message : String(issue))
        }
      }, [sessionId])

      React.useEffect(() => {
        void load()
      }, [load])

      const flip = async () => {
        if (busy || sessionId === '' || state === undefined) return
        setBusy(true)
        try {
          const next = await postJson(`${API}/session`, { sessionId, enabled: state.enabled !== true })
          setState(next)
          setError('')
        } catch (issue) {
          setError(issue instanceof Error ? issue.message : String(issue))
        } finally {
          setBusy(false)
        }
      }

      // 没有会话(空白态)或状态还没拿到时不占位置。
      if (sessionId === '' || state === undefined) {
        return error === '' ? null : h('div', { className: 'aimem-dock-err' }, error)
      }

      const on = state.enabled === true
      const label = on ? dict.dockOn : dict.dockOff
      const hint = on
        ? (state.hasSnapshot ? dict.dockHintOn : dict.dockHintOnIdle)
        : dict.dockHintOff

      return h('div', { className: 'aimem-dock' },
        h('button', {
          type: 'button',
          className: on ? 'aimem-dock-btn on' : 'aimem-dock-btn',
          onClick: () => void flip(),
          disabled: busy,
          title: hint,
          'aria-pressed': on,
        },
          h('span', { className: 'aimem-dock-dot', 'aria-hidden': true }),
          h('span', null, label),
          state.overridden === true ? h('span', { className: 'aimem-dock-mark' }, '*') : null,
        ),
        error !== '' ? h('span', { className: 'aimem-dock-err' }, error) : null,
      )
    }

    /** 开关按钮的样式(只挂一次)。 */
    const DOCK_CSS = [
      '.aimem-dock{display:flex;align-items:center;gap:6px;padding:2px 2px 0;font-size:11px}',
      '.aimem-dock-btn{display:inline-flex;align-items:center;gap:6px;background:transparent;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 10px;font-size:11px;cursor:pointer;transition:border-color .12s ease,color .12s ease,background .12s ease}',
      '.aimem-dock-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}',
      '.aimem-dock-btn:disabled{opacity:.5;cursor:default}',
      '.aimem-dock-btn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '.aimem-dock-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}',
      '.aimem-dock-btn.on .aimem-dock-dot{background:var(--dsw-alias-brand-primary)}',
      '.aimem-dock-mark{opacity:.7;font-size:10px}',
      '.aimem-dock-err{color:var(--dsw-alias-state-error-primary);font-size:11px}',
    ].join('')

    /** 一次性注入样式,组件卸载时移除。 */
    function DockStyle() {
      React.useEffect(() => {
        const tag = document.createElement('style')
        tag.setAttribute('data-dsh-ai-memory-ob', 'dock')
        tag.textContent = DOCK_CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, [])
      return null
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
      // 输入框下方的会话开关:order 靠后,不和宿主的 activity/usage 抢位置。
      try {
        disposers.push(slots.inject('conversation.composer.dock', () => slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-ai-memory-ob-toggle',
          order: 20,
          label: () => dict.dockLabel,
        }, (props) => h(SessionToggle, { ...props, ctx }))))
      } catch {
        // 座位不可用时按钮不出现,命令 /memory 仍然能切换。
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
