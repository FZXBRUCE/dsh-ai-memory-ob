# dsh-ai-memory-ob

> DSH 的长期记忆库插件：把每次对话沉淀成 **Obsidian 库**——记忆条目、用户画像、双链关系图谱。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.2-blue)
![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen)

## 它解决什么

和 AI 聊得越久，两个问题越明显：

1. **上下文衰减**——窗口塞满了，早期的决定被挤出去，AI 开始重复问你已经回答过的事。
2. **每轮都写入太贵**——把整段对话反复喂给模型做总结，token 涨得比记忆还快。

这个插件把记忆搬到**对话之外**：写进一个普通的 Markdown 文件夹，用 Obsidian 打开就是图谱。
需要时按需取回一小段，而不是把历史全塞进上下文。

## 快速开始

```bash
# 1. 克隆到本地任意目录
git clone https://github.com/<你的用户名>/dsh-ai-memory-ob.git

# 2. 在 DSH 里安装这个目录（把路径换成你克隆到的位置）
```

然后在 DSH 里让 agent 执行：

```
plugin_manager install_bundle <你克隆到的绝对路径>
```

装好后打开 **设置 → AI 记忆库**，就能看到库路径、状态和全部开关。

## 五个命令

| 命令 | 作用 |
| --- | --- |
| `/load` | 读取记忆并挂到当前会话上下文。可带日期区间：`/load 2026-10-01..2026-10-20` |
| `/write` | 把本窗口总结后写进库（只写自上次写入以来的新内容）；`/write all` 整窗重写 |
| `/update` | 全量读取库、重建索引，并让模型把条目之间的关系统连成图谱 |
| `/zip` | 压缩成新文件，**源文件不动**。默认本窗口；`/zip vault` 全库；`/zip 2026-10-01..2026-10-20` 区间 |
| `/new` | 新装用户用：扫描历史对话窗口，重建整个记忆库并连好图谱 |

## 模型工具

| 工具 | 作用 |
| --- | --- |
| `memory_search` | 按关键词 / 日期 / 分类检索，只返回标题与摘要 |
| `memory_recall` | 按路径读一条记忆全文 |
| `memory_write` | 归档本窗（用户说"记住这个"时用） |
| `memory_status` | 看库状态、条目数、当前设置 |

有了这几个工具，AI 可以**主动**查记忆，而不是每次都要你手动 `/load`。

## 库结构

```
<vault>/
├── memories/   记忆条目，一个条目一个文件
├── sessions/   每个对话窗口一页，串起它的全部条目
├── profile/    用户画像（单文件，分节替换式合并，可在 Obsidian 里手改）
├── graph/      图谱索引（每日 MOC + /update 的全局索引 + 导出的 JSON）
├── zips/       压缩记忆（源文件不动）
├── daily/      每日时间线
└── .dsh/       插件状态（派生缓存，可删）
```

每个条目都是带 YAML frontmatter 的 Markdown：

```markdown
---
type: "ai-memory"
kind: "decision"
title: "记忆注入改用运行时上下文通道"
session: "d2ec6b21-..."
date: "2026-10-26"
tags: ["记忆", "decision", "注入"]
links: ["dsh-ai-memory-ob 插件总体设计"]
---
# 记忆注入改用运行时上下文通道

> 采集于 2026-10-26 15:39 · 会话 [[session-d2ec6b21-...|Obsidian AI 长期记忆库插件设计]]

手工构造消息注入不够稳定，改为走框架的提示上下文通道……

## 关联
- [[dsh-ai-memory-ob 插件总体设计]]
```

`[[双链]]` 就是图谱的边——Obsidian 打开即得关系图，不需要额外导出。

## 设置项

设置页在 **设置 → AI 记忆库**，数据存在 `$DSH_HOME/.dsh-ai-memory-ob.json`
（刻意放在库外：换库路径时设置不会跟着搬走）。

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 库文件夹 | 空 | 空 = `$DSH_HOME/ai-memory`；支持 `~/path` |
| 自动写入方式 | 每 5 轮 | 或关闭，只用 `/write` |
| 每几次写入 | 5 | 自动写入的轮数间隔 |
| 新会话自动注入记忆 | 开 | 每个新会话首轮自动 `/load` |
| 注入的近期条目数 | 12 | |
| 注入用户画像 / 压缩记忆 | 开 / 关 | |
| 压缩记忆跨窗口共享 | 关 | 关 = 只有压缩它的那个窗口能看到 |
| 注入字符上限 | 4200 | 硬上限，防止记忆挤爆上下文 |
| 单次写入最多条目 | 8 | |
| /new 扫描的会话数 | 8 | |
| 归纳模型 | 空 | `provider/model`；空 = 跟随会话当前模型 |
| 摘要素材带工具名与文件路径 | 开 | 更准，也更费 token |

## 设计取舍

- **记忆是派生缓存**。真相在会话日志里；库随时可以 `/new` 或 `/update` 重建。
  与用户当前的话冲突时，以当前的话为准。
- **注入走框架的提示上下文通道**，不手工构造消息、不往 inbox 塞东西，
  所以不会打断会话流，也不会和宿主的消息模型对不上。
- **子代理不继承用户记忆**：它们的上下文属于父任务，记忆只会干扰判断。
- **写库是增量的**：每条会话有游标，`/write` 只处理游标之后的新事件。
- **整窗重写以窗口为单位替换**：模型换标题也不会在库里留下同义重复。
- **死链过滤**：只写库里真实存在的条目名，Obsidian 图谱里不会出现空节点。
- **压缩件独立**：`/zip` 只新增文件，不改原始条目，所以可以反复压缩、随时回退。

## 兼容性

- 需要 DSH `>= 0.2.1-rc.2`，Node `^22.19 || >=24`。
- 只用宿主已注册的服务，全部按可选取用：缺哪个就少一块能力，不会让整行插件挂掉。
- 不依赖任何第三方运行时库（`node:fs` / `node:path` / `node:os` 而已）。

## 开发

改完宿主代码后，需要停用再启用插件行才会加载新模块：

```
plugin_manager set_plugin include:dsh-ai-memory-ob enabled:false
plugin_manager set_plugin include:dsh-ai-memory-ob enabled:true
```

改 `client.js`（设置页）或 `locale/*.json`（文案）通常热更新即可，刷新页面生效。

### 变更记录

**0.1.1**

- 修复命令与工具静默丢失：原先用 `ctx.effect` + `ctx.get('commands')` 取服务，
  插件激活早于服务注册时取到 `undefined` 就永久放弃注册。改用 `ctx.inject(['commands'], …)`
  等服务就绪后再注册，`tools` / `systemPrompt` / `webServer` 三处同样修正。
- 现象：斜杠命令 `/load` `/write` `/update` `/zip` /`new` 在输入框里不出现、无法调用。

## 许可

[MIT](./LICENSE)
