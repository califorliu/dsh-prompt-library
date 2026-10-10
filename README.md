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

- **文件头注释**：开头的 `<!-- … -->` 会被剥离（默认开启）。注释原文保留，用于列表里的一行描述。**未闭合**的 `<!--` 也会被剥掉，不会漏进输入框。
- **结构化字段**：如果注释里写了 `用途：` / `来源：` / `占位符：`，`用途` 会直接成为标题。
- **编号前缀**：`NN-slug.md` 的数字决定排序，支持 1–4 位且分隔符可选，所以 `1000-a.md`、`2026-10-09-x.md`、`01align.md` 都能正确排序。5 位及以上的前缀不会被截成前四位，按无序号处理。
- **占位符**：正文里的 `<中文说明>`、`<PROJECT_NAME>` 和 `xxxxx` 会被识别出来，显示成 chip。HTML 标签（`<div>`、`</a>`）与自动链接（`<https://…>`）**不算**占位符。**插入时原样保留，由你自己改。**
- **追加片段**：文件名含 `align` / `suffix` / `append` / `closing` / `footer` / `tail`（且该词有词边界）的，被标为「片段」而不是普通模板。`01align.md` 不算片段。

## 插入行为

- **剥离注释头**（默认开）——按约定，`<!-- -->` 是给维护者看的，不该进提示词。
- **自动追加对齐片段**（默认开）——识别到的 `01-align` 会在末尾补上。若该句**已经出现在文本任意位置**（比如 02 模板本来就以它结尾，或你手动选了 01），不会重复追加；比较时会统一换行符，所以 LF 的模板和 CRLF 的片段不会被判成两句。
- **空选择不会追加片段**——没有可插入的内容就插入空串，不会凭空多出两行。
- **多选**——面板右上角「多选」开关，或设置里设默认值。点击累积，按选择顺序用空行拼接，再一次插入。

## 安装

```powershell
$dsh = 'D:\dsh\resources\runtime\cli\bin\dsh.cmd'   # dsh 不在 PATH 时用绝对路径
& $dsh plugin --profile desktop add link:D:\dsh\workspace\dsh-plugin-prompt-library\dsh-prompt-library
```

**这一条就够了。** `dsh plugin` 包装了 pnpm，并在装完后自己把包名注册进 profile（已实测：新 profile 与既有 profile 都会写）。它会做三件事：

1. 在 `profiles/desktop/package.json` 的 `dependencies` 里写 `link:` 依赖；
2. 在 `profiles/desktop/node_modules/` 下建 junction；
3. 把 `"dsh-prompt-library"` 追加进 `dsh.profile.bundles`。

第 3 步是必需的，不是装饰：profile 的组合方式是「按 `dsh.profile.bundles` 的顺序，把每个 bundle 的 `cordis.patch.yml` 叠加到一棵空条目树上」。包不在这个数组里，`cordis.patch.yml` 里那条 `insert: [{ id: prompt-library, name: dsh-prompt-library }]` 就永远不会被应用。

> 也可以完全不动命令行：GUI 的 **Settings → Plugins** 页面能装本地包。

卸载：

```powershell
& $dsh plugin --profile desktop remove dsh-prompt-library
```

`remove` 会清掉依赖项和 `dsh.profile.bundles` 里的那一项，**但会在 `node_modules/` 下留下一个悬空 junction**（已实测）。要彻底干净，卸载后再删一次：

```powershell
Remove-Item 'C:\Users\micha\.dsh\profiles\desktop\node_modules\dsh-prompt-library' -Force
```

升级：替换 `lib/` 下的文件即可，**无依赖、无构建**。但宿主对**已经加载过**的插件模块没有热重载，改完必须**重启 DSH**（改 mtime、disable→enable 都无效）。

> 首次**新增**这个 bundle 时**不需要**重启：loader 会直接接管（实测 `fiberPhase: "active"`，四个座位当场注册）。热重载的缺口只针对「已加载过、又被改了内容」的模块。

## 目录结构

```
dsh-prompt-library/
├─ lib/index.js         host 半：目录扫描、模板解析、/api 路由
├─ lib/client.js        浏览器半：工具栏按钮 / 弹出面板 / 库页面
├─ cordis.patch.yml     bundle patch：把插件行插进 profile
├─ test/acceptance.mjs  验收测试（44 项断言）
├─ test/theme.mjs       亮/暗配色审计：token 解析 + WCAG 对比度计算
├─ FIXES.md             缺陷修复记录（每条缺陷的反例与修复后行为）
├─ HANDOFF.md           上一轮交接文档（含本轮的更正说明）
└─ README.md
```

## 测试

验收测试真的会调用 host 半去扫描你的 prompt 目录，再把浏览器半挂进 jsdom，模拟点击，断言最终送进 `inputActions.insertText` 的文本。

```powershell
cd test
pnpm install --node-linker=hoisted
node acceptance.mjs
```

> `--node-linker=hoisted` 在 Windows 上是必需的：pnpm 默认把 `node_modules/jsdom` 建成 junction，Node 的模块解析在这种布局下找不到 jsdom 的传递依赖（报 `Cannot find module 'tough-cookie'`）。hoisted 布局把依赖摊平成真实目录，绕开这个问题。

覆盖 44 项断言：

- **扫描与解析**——注释剥离、`xxxxx`/`<…>` 占位符识别、片段判定、README 排除、编号排序；
- **交互**——四个座位的注册、弹出面板渲染与搜索、单条插入、多选按序拼接、align 片段不重复追加、库页面渲染与预览；
- **配色**——解析样式表里每个前景/背景配对，用 DSH 真实的亮/暗 token 值算 WCAG 对比度，要求两种主题下都 ≥ 4.5:1，并禁止把字面色值写进 `color`。

> 旧版是 45 项。删掉的那条 `non-loopback peer is refused` 测的是插件自己那道**已经被删除**的围栏（见 FIXES.md §0），被测对象已经不存在，改由运行中的宿主实测覆盖。

测试依赖只装在 `test/` 下（react / react-dom / jsdom），不需要时可以整个删掉 `test/node_modules`。

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
- `--dsw-specific-menu` 是**按平台**取值的，macOS 与 Windows 不同；`test/theme.mjs` 里的基准表取的是 Windows 值。

`test/theme.mjs` 会把上面这些规则自动跑一遍，改动样式后 `node acceptance.mjs` 会直接报出违反项。

## 已知边界

- 面板页（`main` 座位）是 root 作用域，拿不到会话的 `inputActions`，所以那里只提供**复制**；**插入**只在输入框旁边的面板里可用。
- 设置存在浏览器 `localStorage`（键 `dsh-prompt-library/settings/v1`），不是 profile 级配置。换浏览器或清缓存会重置。
- 目录每次打开面板时重新扫描（15 秒内复用缓存），没有文件监听。
- **多个片段文件时只自动追加排序最靠前的那个**，其余不会追加也不提示。这是「多片段策略」未定义，属功能变更，不在本轮缺陷修复范围。
- **非 UTF-8 文件、超过 512 KB（按字节）的文件、正文为空的模板会被静默跳过**，不出现在列表里。这是刻意的：宁可少一条，也不把乱码、截断内容或空行塞进输入框。需要收录就把文件转成 UTF-8。
- 请求里给的目录必须是**本地绝对路径**；UNC / 设备路径 / 相对路径被拒绝且不报错（列表里少一条来源）。配置里写的路径同样受此限制。
- `?dirs=` 仍是「读本机任意绝对目录下 `*.md` 全文」的能力，这是本插件的产品设计；它的安全性**完全押在宿主 `/api` 准入闸门上**。重载后的第一次验证必须打在这里（无 cookie 应得 `401`，而不是 `200`）。
- **来源去重按 `realpath` 原样比较，不折叠大小写**：同一个目录的两种拼写会折叠成一个来源，而仅大小写不同的两个真实目录（Windows 的「按目录大小写敏感」目录、大小写敏感的卷）会各自保留。已在按目录大小写敏感的 Windows 目录上实测。
- **单次请求的扫描是有界的**（4000 个目录 / 2000 条模板）。真的超出时会截断，并在弹出面板与库页面上显示「扫描已截断：目录或模板过多，本次列表不完整」。
- 客户端对非规范 catalog 的容错有限：`null` 条目、重复 `id`、`localStorage` 里的字符串 `"false"` 都未处理（需要宿主回传非规范 item 才可达）。

缺陷修复的完整清单、每条的反例与验证状态见 [FIXES.md](FIXES.md)。
