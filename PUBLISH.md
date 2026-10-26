# 发布 dsh-ai-memory-ob 到 GitHub

这个文件夹已经是一个**完整的 git 仓库**（已 init、已提交），你只需要把它推到 GitHub。

---

## 一、先在 GitHub 建一个空仓库

1. 打开 https://github.com/new
2. **Repository name** 填 `dsh-ai-memory-ob`
3. 选 **Public**（想给别人用）或 **Private**（只自己用）
4. ⚠️ **不要**勾选 "Add a README file"、"Add .gitignore"、"Choose a license"——
   本地已经有这些文件了，勾了会在推送时冲突
5. 点 **Create repository**

建好后页面会显示一个地址，形如：

```
https://github.com/你的用户名/dsh-ai-memory-ob.git
```

---

## 二、把本地仓库推上去

在 `D:\dsh\plugins\dsh-ai-memory-ob` 里执行（Git Bash 或 PowerShell 都行）：

```bash
cd /d/dsh/plugins/dsh-ai-memory-ob

# 换成你自己的用户名
git remote add origin https://github.com/你的用户名/dsh-ai-memory-ob.git

# 主分支改名（GitHub 现在默认 main）
git branch -M main

# 推送
git push -u origin main
```

**第一次推送会要求登录。** 有两种方式：

### 方式 A：浏览器授权（推荐，最简单）

如果装了 Git Credential Manager（Windows 版 Git 自带），执行 `git push` 会**弹出浏览器窗口**，
登录 GitHub 账号、点授权就行，之后不用再输密码。

### 方式 B：用 Personal Access Token

如果弹不出浏览器，或者提示要密码：

1. 打开 https://github.com/settings/tokens?type=beta
2. **Generate new token** → 填个名字 → **Expiration** 选 90 天
3. **Repository access** 选 "Only select repositories" → 选 `dsh-ai-memory-ob`
4. **Permissions** → Repository permissions → **Contents: Read and write**
5. 点 **Generate token**，**复制那一串**（只显示一次！）
6. 回到终端，`git push` 提示输密码时，**粘贴这个 token**（不是你的 GitHub 密码）

> 提示 `Username` 时填你的 GitHub 用户名。

---

## 三、验证

推送成功后，刷新 GitHub 页面，应该能看到：

```
README.md          ← 会渲染成漂亮的项目首页
index.js           ← 宿主半边
client.js          ← 浏览器半边（设置页）
lib/               ← 6 个模块
locale/            ← 中英文案
test/              ← 两个测试脚本
cordis.patch.yml
package.json
icon.svg
LICENSE
```

---

## 四、之后别人怎么装

在你的 README 里已经写好了。对方执行：

```bash
git clone https://github.com/你的用户名/dsh-ai-memory-ob.git
```

然后在 DSH 里：

```
plugin_manager install_bundle <克隆到的绝对路径>
```

---

## 五、以后改了代码怎么更新

```bash
cd /d/dsh/plugins/dsh-ai-memory-ob

git add -A
git commit -m "fix: 说明这次改了什么"
git push
```

建议提交信息用这几个前缀，一眼能看懂：

| 前缀 | 用途 |
| --- | --- |
| `feat:` | 新功能 |
| `fix:` | 修 bug |
| `docs:` | 只改文档 |
| `chore:` | 杂事（换行、依赖版本等） |

---

## 常见问题

**Q: 推送时报 `remote origin already exists`**

```bash
git remote set-url origin https://github.com/你的用户名/dsh-ai-memory-ob.git
```

**Q: 推送时报 `failed to push some refs` / `rejected`**

说明远端仓库不是空的（建仓库时勾了 README）。两种解法：

```bash
# 解法 1：强制覆盖远端（远端那个 README 会被丢掉）
git push -u origin main --force

# 解法 2：先合并远端
git pull origin main --allow-unrelated-histories
git push -u origin main
```

**Q: 报 `Authentication failed`**

token 过期或没给 Contents 写权限。重新生成一个，注意第 4 步要选 **Read and write**。

**Q: 我不想让 test/ 目录公开**

在 `.gitignore` 里加一行 `test/`，然后：

```bash
git rm -r --cached test
git commit -m "chore: 不公开测试脚本"
git push
```

**Q: 想发到 npm 让别人 `npm install`**

`package.json` 里现在是 `"private": true`，要发布得先删掉这行，然后：

```bash
npm login
npm publish --access public
```

不过对 DSH 插件来说，**GitHub 直装就够了**，不用发 npm。

---

## 六、发布包内容清单

`dsh-ai-memory-ob/` 目录：

```
.gitignore
.gitattributes
LICENSE                 MIT
README.md               项目首页（含徽章、命令表、设置表、设计取舍）
package.json            插件清单（name/version/exports/dsh.bundle/dsh.client）
cordis.patch.yml        插件行声明
icon.svg                设置页图标
index.js                宿主半边：命令、工具、提示上下文、HTTP 路由
client.js               浏览器半边：设置页「AI 记忆库」
lib/
  util.js               时间、字符串、token 估算
  vault.js              Obsidian 库读写（条目/画像/图谱/压缩/索引）
  digest.js             会话日志折叠成对话摘要
  summarize.js          调模型归纳（写库/图谱/压缩三套提示词）
  settings.js           设置读写（存在库外）
  service.js            服务层：把上面这些串起来
locale/
  en.json               英文文案
  zh.json               中文文案
test/
  selfcheck.mjs         落盘层测试（19 项断言）
  service-check.mjs     服务层测试（假宿主 + 假模型，全命令跑通）
  dedupe-vault.py       一次性维护脚本：合并历史重复条目
```

打包体积：40.5 kB（压缩后），137.5 kB（解压后），15 个文件。

---

## 七、装好之后怎么用

在 DSH 设置里打开 **设置 → AI 记忆库**，先确认三件事：

1. **库文件夹**——留空就是 `$DSH_HOME/ai-memory`，也可以填 `D:\我的记忆库`
2. **自动写入方式**——默认「每 5 轮」，想完全手动就选「关闭（只用 /write）」
3. **新会话自动注入记忆**——默认开，这样每个新对话都继承之前的记忆

然后在对话里试：

```
/write          把这一窗总结进库
/load           重新读取记忆
/update         重建图谱
```

最后用 Obsidian 打开库文件夹（**Open folder as vault**），就能看到关系图谱了。
