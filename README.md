# dsh-prompt-library

DSH Web GUI 的**预设提示词库**：把你沉淀出来的提示词模板（以及 skill 蒸馏出的 `assets/prompts`）聚合成一个可搜索的列表，点一下就把整段文本插进输入框。

和面向 agent 的 skill 不同——**调用与否完全由你决定**，agent 不会被自动塞进这些模板，也不会有一个 tool 去偷偷用它。

## 三个入口

| 入口 | 位置 | 用途 |
|---|---|---|
| **输入框按钮** | 输入框工具栏左侧的书本图标 | 快速调用：点开 → 搜索 → 点击即插入光标处 |
| **弹出面板** | 输入框上方浮层 | 搜索、预览一行描述、多选拼接、刷新扫描 |
| **Prompt 库页面** | 侧边栏面板图标 | 浏览、看全文、复制、管理来源目录与开关 |

插入走的是官方通道：会话作用域的 `inputActions.captureInsertion()` + `inputActions.insertText()`，是**一次可撤销的纯文本编辑**，不做任何 DOM 篡改。写入失败时会退回复制到剪贴板，并**如实**告诉你复制到底成没成功。

## 来源是怎么找的

自动扫描（无需配置）：

```
<DSH_HOME>/skills/*/assets/prompts
<AGENTS_HOME>/skills/*/assets/prompts
<工作区>/docs/prompts
<工作区>/prompts
<工作区>/.dsh/prompts
```

外加你在「设置」里逐行填写的任意绝对路径。

规则：

- **递归 3 层**：`docs/prompts/<主题>/*.md` 这种归档方式会被找到（旧版只扫一层，嵌套目录静默消失）。
- **支持 junction / symlink**：用 `link:` 装的 skill 能被扫到。同一批提示词即使同时通过链接和目标可见，也只列一次。
- `README.md` / `index.md` / `_index.md` 这类维护文档会被排除，只收 `*.md` / `*.markdown`。
- 目录必须是**本地绝对路径**；UNC（`\\host\share`）、Win32 设备路径（`\\?\`、`\\.\`）、相对路径一律拒绝。
- 浏览器每次请求最多带 32 条额外目录；一次请求最多遍历 4000 个目录、返回 2000 条模板。**超出会截断，并在界面上明确提示**，不会静默少给。
- 非 UTF-8、超过 512 KB（按字节）、正文为空的模板会被**静默跳过**，见「已知边界」。

## 遵守的目录约定

这个插件按 `assets/prompts/README.md` 的约定来解析，也兼容不符合约定的目录：

- **文件头注释**：开头的 `<!-- … -->` 会被剥离，**只把正文插入输入框**。**未闭合**的 `<!--` 也会被剥掉首行。
- **结构化字段**：注释里可以写 `summary:` / `detail:` / `source:` / `kind: suffix`。`summary` 是列表里的标题，`detail` 只在详情视图里展开。旧的 `用途：` / `来源：` 仍然识别。
- **自由文本**：注释里没打标签的文字不会丢 —— 没有 `summary:` 时它会成为标题。
- **编号前缀**：`NN-slug.md` 的数字决定排序，支持 1–4 位且分隔符可选，所以 `1000-a.md`、`2026-10-09-x.md`、`01align.md` 都能正确排序。5 位及以上的前缀不会被截成前四位，按无序号处理。
- **占位符**：正文里写成 `<…>` 的会被识别出来，显示成 chip。尖括号里要么是中文/日文/韩文说明（可以混数字，如 `<功能1>`），要么是全大写的 `SCREAMING_CASE`（`<PROJECT_NAME>`）。**尖括号是 ASCII 的**（中文输入法全角态的 `＜项目＞` 不识别），一个模板最多 64 个占位符。**代码块和行内代码里的尖括号不算**——文档里举例的 `<项目>` 不会被当成待填字段。HTML 标签（`<div>`、`</a>`、`<TITLE>`、`<A HREF X>`）与自动链接（`<https://…>`）**不算**占位符。占位符**只看正文**，注释里不需要再列一遍；`placeholder:` 标签已不再解析（旧文件里的这一行会被原样保留，不会被删掉）。
- **追加片段**：**只有显式写了 `kind: suffix` 的模板**才被标为「片段」。文件名完全不参与判定，所以改名不会改变一个模板的类型。

## 插入行为

- **自动追加对齐片段**（默认开）——默认追加第一个声明了 `kind: suffix` 的模板；也可以在设置里指定某一个，或选择不追加。若该句**已经出现在文本任意位置**（比如 02 模板本来就以它结尾，或你手动选了 01），不会重复追加；比较时会统一换行符，所以 LF 的模板和 CRLF 的片段不会被判成两句。
- **含占位符的模板：插入前弹出参数卡片**（默认开）——左栏一个占位符一个输入框，右栏同步预览；留空的参数默认保留 `<占位符>` 原样，可以关掉（这个开关和设置页里的同一项是同一个偏好，两边都写）。多选时跨模板合并同一个占位符，同名占位符只填一次。
- **空选择不会追加片段**——没有可插入的内容就插入空串，不会凭空多出两行。
- **多选**——面板右上角「多选」开关，或设置里设默认值。点击累积，按选择顺序用空行拼接，再一次插入。

## 浏览与编辑

- **快捷面板**：输入框左下角的书本图标。每行第一行是**文件名**、第二行是 `summary`（没有 `summary` 时只有文件名，所以两条同 `summary` 的模板也分得开）。行尾 ⓘ 打开独立详情视图（`→` / `Enter` 进入，`←` / `Esc` 返回）；来源分组可折叠，折叠状态会记住，搜索时命中分组自动展开。
- **库页面**：侧边栏的 Prompt 库。左侧同样按来源分组、可折叠。可以浏览、复制正文 / 复制含注释头、**在文件夹中显示 / 用默认程序打开 / 复制路径**，以及**编辑、新建、重命名、删除**模板。
  - 进编辑前会重新读一次磁盘上的文件，保存时校验版本；磁盘上的文件在编辑期间被改过会给出「重新载入」/「仍然覆盖」两个选择。
  - 新建时**文件名不写扩展名会按 `.md` 处理**；写了别的扩展名（如 `.txt`）会明确拒绝并说明，不会静默改名。子目录只能**从已有目录里选**——本插件不创建文件夹，需要新目录请先在磁盘上建好。新建一个**正文为空**的模板会被拒绝（扫描会跳过它，否则会出现「建完看不见、再建又提示重名」）。
  - 重命名用页面内的输入框（Enter 确认 / Esc 取消），只改同一目录下的文件名。
  - 删除**不进回收站**，确认框会显示完整路径、字节数，以及（如果在 git 工作树里）恢复命令。恢复命令只能恢复到 git 里**最后一次提交**的版本，删除前未提交的改动无法恢复。
  - 库页面**不提供插入到会话**：`main` 是 root 作用域，拿不到会话的插入能力。要插入请用输入框旁边的快捷面板。

## 安装

两种装法：**从 GitHub 装**（普通使用）和**从本地目录 link 装**（开发用）。同一个包名在 profile 里只能有一份，切换前必须先把旧的卸干净（见「卸载与切换安装方式」）。

### 从 GitHub 安装（普通使用）

GUI：侧边栏 **插件** → **添加插件**（或箭头菜单里的「安装第三方插件」），粘贴：

```
https://github.com/califorliu/dsh-prompt-library
```

命令行等价写法：

```powershell
$dsh = 'D:\dsh\resources\runtime\cli\bin\dsh.cmd'   # dsh 不在 PATH 时用绝对路径
& $dsh plugin --profile desktop add github:califorliu/dsh-prompt-library
```

`dsh plugin` 包装了 pnpm，并在装完后自己把包名注册进 profile（已实测：新 profile 与既有 profile 都会写）。它会做三件事：

1. 在 `profiles/desktop/package.json` 的 `dependencies` 里写 git 依赖（`github:califorliu/dsh-prompt-library`）；
2. 把包解压进 `profiles/desktop/node_modules/`；
3. 把 `"dsh-prompt-library"` 追加进 `dsh.profile.bundles`。

第 3 步是必需的，不是装饰：profile 的组合方式是「按 `dsh.profile.bundles` 的顺序，把每个 bundle 的 `cordis.patch.yml` 叠加到一棵空条目树上」。包不在这个数组里，`cordis.patch.yml` 里那条 `insert: [{ id: prompt-library, name: dsh-prompt-library }]` 就永远不会被应用。

git 安装按 commit 锁定：`pnpm-lock.yaml` 里记的是 `codeload.github.com/califorliu/dsh-prompt-library/tar.gz/<sha>`。仓库更新后要**重装**（卸载 + 再装，或 GUI 里的更新）才会拿到新版本。

### 从本地目录安装（开发用）

```powershell
& $dsh plugin --profile desktop add link:<你的开发目录>\dsh-prompt-library
```

与 GitHub 安装只有第 1、2 步不同：依赖写成 `link:`，`node_modules/` 下建的是 junction。改 `lib/` 后仍然要重启 DSH 才生效（见「升级」）。

> 完全不动命令行也可以：GUI 的 **插件 → 添加插件** 同样接受本地绝对路径。

### 卸载与切换安装方式

```powershell
& $dsh plugin --profile desktop remove dsh-prompt-library   # 沿用上面的 $dsh
```

`remove` 会清掉依赖项和 `dsh.profile.bundles` 里的那一项，**但会在 `node_modules/` 下留下一个悬空 junction**（已实测）。**卸载后必须再删一次**：

```powershell
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-prompt-library" -Force
# 等价的更保险写法（只删链接本身，不碰目标目录）：
# cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-prompt-library"
```

不删的后果是**下一次安装直接失败**，而且报错看不出真正原因：

```
ERR_PNPM_EPERM  [importPackage ...\node_modules\dsh-prompt-library] EPERM: operation not permitted,
rename '...\node_modules\dsh-prompt-library_tmp_16068_1' -> '...\node_modules\dsh-prompt-library'
```

pnpm 先把包下到临时目录、再 `rename` 成正式目录；Windows 上目标位置被这个悬空 junction 占着，rename 失败，pnpm 回滚并把临时目录挪进 `node_modules\.ignored\`。GUI 只会显示一个权限类错误，包永远装不上。所以**换安装方式前先看一眼有没有残留**：

```powershell
cmd /c dir /AL "$env:USERPROFILE\.dsh\profiles\desktop\node_modules" | findstr /i dsh-prompt-library
```

有输出就按上面的命令删掉，再装。

### 升级

- **GitHub 版**：重装（卸载 + 再装，或 GUI 里的更新）。
- **link 版**：替换 `lib/` 下的文件即可，**无依赖、无构建**。
- 两种方式都一样：宿主对**已经加载过**的插件模块没有热重载，改完必须**重启 DSH**（改 mtime、disable→enable 都无效）。

> 首次**新增**这个 bundle 时**不需要**重启：loader 会直接接管（实测 `fiberPhase: "active"`，四个座位当场注册）。热重载的缺口只针对「已加载过、又被改了内容」的模块。

## 目录结构

```
dsh-prompt-library/
├─ lib/index.js         host 半：目录扫描、模板解析、/api 路由
├─ lib/client.js        浏览器半：工具栏按钮 / 快捷面板 / 库页面
├─ cordis.patch.yml     bundle patch：把插件行插进 profile
├─ package.json         清单、依赖与发布白名单
└─ README.md
```

## 验证

发布包内**不含测试文件**。历史验收 harness（React + jsdom）留在开发库的 `dev/test/`，它是一次性探针，
**不是**本插件的验收证据。本插件的验收按开发库 `DEV-ITEMS.md` 的条目做**独立对抗审核**：
审核者不是作者，产出的是具体反例与失败输出，结论与已知限制记在开发库的 `FIXES.md` 与 `dev/reviews/`。

## 实现说明

- **零依赖、零构建**。客户端半 `lib/client.js` 就是 `window.__ModuleLoader__.load({ id, factory })` 模块，和官方 client 插件同一种格式；除了 React 基座不 require 任何外部模块。
- **host 半**（`lib/index.js`）扫描文件系统，并通过 `ctx.connection.fetch.register` 在宿主的 `/api` 通道上暴露 `api/dsh-prompt-library/list`。
- **信任围栏是宿主的，不是插件的**。宿主把准入闸门注册为 `/api` 的 prefix 路由（先 `connection.admit(req)`，401/403 直接返回）；`connection.fetch.register` 注册的 exact 路由只在该闸门**之后**被查询。插件里没有任何信任判断——所以它不可能比宿主更弱。
  - 反过来说：如果当初用 `ctx.webServer.register({ kind: "exact", path: "api/…" })`，exact 路由会抢在 `/api` prefix 之前匹配，**在闸门之前运行**。这正是本插件旧版让无令牌请求拿到 `200` 的原因。
  - 因此 `inject = ["connection"]` 是**硬依赖**：取不到闸门就不挂路由，不会退回无保护状态。
- 四个挂载点全部经 `ctx.slots.inject` 注册，宿主没声明某个座位时该入口静默缺席，不会让整个 GUI 启动失败。

## 配色约定（改样式前必读）

DSH 的 alias 调色板在明暗主题间是**反转**的：

| token | 浅色 | 深色 |
|---|---|---|
| `--dsw-alias-brand-primary` | `#0f1115`（近黑） | `#f9fafb`（近白） |
| `--dsw-alias-label-primary-foreground` | `#fff` | `#0f1115` |

所以 `brand-primary` **只能当填充色**，压在它上面的文字必须用 `label-primary-foreground`（它朝相反方向反转）。这正是官方主按钮的写法，五个官方包一致：

```css
background: var(--dsw-alias-button-primary-fill);
color: var(--dsw-alias-label-primary-foreground);
```

反过来，`color: #fff` 压在 `brand-primary` 上，浅色下 18.9:1 没问题，**深色下只有 1.05:1——等于看不见**。这就是本次修掉的缺陷。

其余规矩：

- 文字色一律走语义 token（`label-primary` / `label-secondary` / `label-primary-foreground`），**不要写字面色值**——写死了就没法跟随主题。
- 次级文字用 `label-secondary`。`label-tertiary` 在浅色主题的浮层上只有 3.5:1，达不到 AA。
- 语义状态色（error / success）**不要直接当正文颜色**：`state-success-primary` 在浅色浮层上只有 2.2:1。本插件用「中性色文字 + 左侧语义色条」来表达状态。
- 半透明 token（`interactive-bg-hover`、`specific-menu`）必须叠加在底面上再谈对比度。
- `--dsw-specific-menu` 是**按平台**取值的，macOS 与 Windows 不同。

## 已知边界

- 面板页（`main` 座位）是 root 作用域，拿不到会话的 `inputActions`，所以那里只提供**复制**；**插入**只在输入框旁边的面板里可用。
- 设置存在浏览器 `localStorage`（键 `dsh-prompt-library/settings/v1`），不是 profile 级配置。换浏览器或清缓存会重置。
- 目录**每次打开面板都重新扫描**（只对 1 秒内的连续打开做防抖，这不是缓存），没有文件监听。
- 追加片段默认取**排序最靠前**的那一个；可以在设置里指定具体模板，或选择不追加。
- **写能力的范围是「你在这个面板里声明的来源目录」**。关掉 profile 配置里的写开关（`allowWrite: false`）会让库页面整体只读。
- **非 UTF-8 文件、超过 512 KB（按字节）的文件、正文为空的模板会被静默跳过**，不出现在列表里。这是刻意的：宁可少一条，也不把乱码、截断内容或空行塞进输入框。需要收录就把文件转成 UTF-8。
- **保存统一用 LF**。浏览器把编辑框里的换行一律规范成 `\n`，所以「保持原文件的换行风格」只能整份生效：一份 CRLF/LF 混合的文件保存后，原来的 `\n` 段落会被写成 `\r\n\r\n`，看起来像凭空多了空行。现在所有保存都写 LF（Windows 记事本、VS Code、git 都正常处理；git 的 `core.autocrlf` 会在检出时转回 CRLF）。**没有改动直接保存仍然一个字节都不动**。
- 请求里给的目录必须是**本地绝对路径**；UNC / 设备路径 / 相对路径被拒绝且不报错（列表里少一条来源）。配置里写的路径同样受此限制。
- `?dirs=` 仍是「读本机任意绝对目录下 `*.md` 全文」的能力，这是本插件的产品设计；它的安全性**完全押在宿主 `/api` 准入闸门上**。重载后的第一次验证必须打在这里（无 cookie 应得 `401`，而不是 `200`）。
- **来源去重按 `realpath` 原样比较，不折叠大小写**：同一个目录的两种拼写会折叠成一个来源，而仅大小写不同的两个真实目录（Windows 的「按目录大小写敏感」目录、大小写敏感的卷）会各自保留。已在按目录大小写敏感的 Windows 目录上实测。
- **单次请求的扫描是有界的**（4000 个目录 / 2000 条模板）。真的超出时会截断，并在弹出面板与库页面上显示「扫描已截断：目录或模板过多，本次列表不完整」。
- 客户端对非规范 catalog 的容错有限：`null` 条目、重复 `id`、`localStorage` 里的字符串 `"false"` 都未处理（需要宿主回传非规范 item 才可达）。

缺陷修复的完整清单、每条的反例与验证状态见 [FIXES.md](FIXES.md)。
