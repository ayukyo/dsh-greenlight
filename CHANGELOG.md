# Changelog

All notable changes to this project are documented here.

## 0.4.12

**修 0.4.11 的三个界面 bug**

### 1. 点卡片上的任何按钮都会收起泳道
泳道头改成 `<button>` 时，右括号写到了末尾，卡片区被包进了按钮内部（DOM 上卡片成了按钮的后代），
点卡片里任何按钮都会冒泡到按钮的 `onClick`，触发折叠。
现在泳道头只包自己的箭头/状态名/计数，卡片区是它的**兄弟节点**。

### 2. 鼠标在子任务区滑不动
卡片区曾自带 `max-height: 62vh` + `overflow-y: auto` + `overscroll-behavior: contain`：
滚轮被内层盒子吞掉，滚到头又不许交给页面。
现在卡片区 `overflow: visible`，滚轮直接驱动页面滚动；每泳道仍只渲染 25 张（翻页控制 DOM 规模）。
同时删掉三处横排时代的死 CSS（列高上限、粘性泳道头、头部底色覆盖）。

### 3. 标题与下方按钮重叠
标题改成文本块后，旧规则里的 `height: 26px`（原输入框的单行高度）仍然生效，
换行后的文字溢出盒子，压到下面的按钮和 chips 上。现在标题 `height: auto` 按内容撑开，
顶行 `align-items: flex-start` 让 pill 和按钮跟首行对齐。

### 新增的结构守卫测试（防止同类问题再溜过去）
- 泳道头内部不得出现卡片，卡片区必须是泳道头的兄弟
- 卡片区不得是内层滚动容器（无 `overflow-y: auto` / `max-height` / `overscroll-behavior`）
- 标题规则必须有 `height: auto`，顶行必须 `align-items: flex-start`

客户端 551 项、宿主 119 项测试全通过。

## 0.4.11

**泳道可折叠、泳道内可排序，卡片开头不再浪费一行**

### 泳道折叠
- 点泳道头整条收起/展开；收起后只留头部（状态色 + 名称 + 计数），卡片区不渲染
- 头部是真正的 `<button>`：键盘、读屏、自动化三方行为一致，带 `aria-expanded` 和明确 `aria-label`
- 头部左侧箭头指示方向：展开向下、收起向右（120ms 过渡）
- 折叠状态记在 localStorage，刷新后保持

### 泳道内排序
- 筛选栏新增「排序」下拉：默认顺序 / 按优先级 / 按截止日期 / 按最近更新
- 按优先级：紧急 → 高 → 普通 → 低，同级按截止日期
- 按截止日期：最早的在前，**没有截止日期的排最后**
- 排序只影响显示，不改文档顺序；选择记在 localStorage

### 卡片密度
状态 pill 从独占一行改为**跟在标题前面同一行**，「详情」按钮也并入该行：

```
[待验收] 修复导出超时的问题   [详情] [×]
[通过] [打回]        ← 只有待验收卡有这一行
● 主会话 chip
████████ 100%
```

### 标题裁切的真正原因
标题原来是 `<textarea>`：输入框不会自己长高，行数只能猜，猜少了就裁掉。现在默认渲染成文本块
（按内容自然换行，**物理上不可能裁切**），点一下才变成输入框编辑，失焦保存。
另外，「收起详情」（卡片折叠）与「收起详情」（长文本折叠）文案撞车，前者改为「收起」。

## 0.4.10

**泳道纵向排布 + 标题完整显示**

六列横排时每列只有 ~210px，标题被挤成几个字；再加上标题本身在数据里就被截断，卡片上根本看不出这张卡是什么任务。

### 布局
- 六种状态改为**从上到下的纵向泳道**（工作流顺序），每条泳道占满整行
- 泳道内卡片按宽度栅格排布（`auto-fill, minmax(460px, 1fr)`），宽屏一行两三张，窄屏一张
- 泳道内部滚动（上限 `62vh`）+ 每泳道分批渲染 25 张
- 空泳道弱化为虚线占位，只有真正有卡片的泳道才染色
- **归档区移到页面最底部**（资料 → 草案 → 泳道 → 记忆 → 归档）

### 标题（根因修复）
- 派生标题上限 **30 → 120 字**：原来从描述生成标题时被硬截到 30 字，完整内容留在「说明」里
- 生成/修复标题时**丢掉粘贴进来的链接**（`https://…` 不进标题）
- **老数据自动修复**：标题恰为 30 字且是说明前缀的卡片，加载时从说明重新生成标题
  （手写标题不会恰好是自己说明的前缀，所以不会误改）
- 标题框按标题长度自适应 1~6 行，不再被固定高度截断
- 标题下增加一行「说明」预览（仅当说明不是标题前缀时显示）

### 顺手修掉的布局 bug
- 长标题让「项目记忆」里关联任务的 chip 变成超宽 `nowrap` 元素，把记忆正文挤成 31px 宽的竖排文字、
  还把页面撑到 4000+ px：现在 chip 限宽 220px（记忆区 160px）+ 省略号，关联标题再截 32 字

## 0.4.9

**卡片排版适配几十上百个子任务**

一张卡原来把十几行控件全摊开（优先级、日期、标签、会话行含 4 个按钮、记录验证、下一步、详情、
验收动作），一张卡 200~300px 高。栏目里几十张卡时：页面无限拉长、找不到重点、看板失去"一眼总览"。

参考 GitHub Projects / Linear 的做法改：

- **卡片默认只显示 4 行**：状态 pill + 标题、关键 chips（优先级/截止/阻塞/待我验收/会话运行态）、
  进度条（有进度才显示）、`详情` 按钮；**其余控件全部收进「详情」**，点开是原来那套完整表单，
  再点「收起详情」折回
- **审批动作不藏**：待验收卡片上的 `通过`/`打回` 留在紧凑态（那是等人决策的动作）
- **每列内部滚动 + 列头吸顶**：列高 `calc(100vh - 380px)`，页面不再被长列拉长
- **分批渲染**：每列先渲染 25 张，多出来的显示「显示更多（还剩 N 张）」
- **项目记忆同样收紧**：单条超过 120 字的默认截断 +「展开全文」；整区先显示 6 条 +「显示更多」

## 0.4.8

**配色与层级重做：一眼能分出状态和层级**

原来全板一个表面：白色分区、白色卡片、白色栏目，所有非"已完成"的状态共用同一个灰 chip。
六个栏目长得一样，卡片和它的容器也长得一样，所以看上去"乱、看不出来"。

- **一个状态一个色**，并且每个色始终只表示一件事：
  `待规划` 中性灰 · `待办`/`进行中` 蓝 · `待验收` 琥珀 · `已完成` 绿 · `已失败` 红
- 同一种色出现在四处：卡片左侧的状态竖条、状态 pill（改为填充底色）、栏目头部的分隔线、
  栏目计数与圆点——颜色和状态因此可以互相对照
- **层级分开**：页面最裸，分区是浅灰抬升面，栏目按状态淡淡染色，卡片是最亮的一层（带描边与轻微投影，
  hover 抬起来）
- 空栏目不再染色（虚线占位），只有真有卡片的栏目才上色
- 进度条颜色跟随卡片状态；阻塞卡片改用红色描边 + 淡红底
- 长文本区（完成说明 / 验证项 / 交付物 / 验收说明）收进一个左侧带状态色的浅块里，
  连同 0.4.7 的折叠，卡片不再被一大段红字撑开
- 「验收说明」也纳入折叠（原来它单独摊在卡片上，是红字最长的一块）

## 0.4.7

**卡片上的长文本默认折叠，可展开、可再收起**

完成的卡片会摊开一大段：完成说明（真实项目里一两千字）、验证项、交付物、未验证项。一张卡就把整列占满，
后面的卡被挤到看不见。

- 详情的文字量超过阈值（合计 >200 字，或验证项 ≥3 条，或交付物 ≥4 个）时，**默认折叠**
- 折叠态只显示一行摘要：「详情已折叠：完成说明 1839 字 · 验证项 8 条 · 交付物 6 个」，加一个「展开详情」
- 展开后是原来的完整内容，底部有「收起详情」可以再折回去（按钮带 `aria-expanded`）
- 短卡片不受影响：内容少就不折叠，也没有多余按钮

## 0.4.6

**「派给会话」和「打开会话」合并成卡片上的一个按钮**

原来卡片中部有「派给会话」、会话行里另有一个「打开会话」，同一件事被拆成两个割裂的控件。
现在只有一个按钮，按状态换标签与行为：

- 还没绑定会话：「派给会话」→ 新建一个主会话 → 绑定到卡片 → 把派活提示词发进去 → 卡片置为进行中
- 已绑定会话但从未派过活（会话没收到看板上下文）：「派给会话」→ 直接把提示词发进已绑定的会话
- 已经派过活：「打开会话」→ 把界面切到那个会话（`uiWorkspace.openSession`），不重复发提示词
- 新建会话 + 派活是一个串行流程：派活使用新建返回的 sessionId；任一步失败都会在卡片上显示错误
- 会话行里的「打开会话」按钮删除（已合并到卡片按钮）；0.4.2 的「还没收到看板上下文」提示保留

**数据**
- 新增 `task.contextSentAt`：0 表示从没派过活，否则为派活成功的时间戳；数据版本保持 **12**
- 老文档里没有这个字段：卡片**已经绑定会话且不在「待规划/待办」**的，按"派过活"处理（否则现有卡片会全部
  退回「派给会话」、丢掉「打开会话」）；未绑会话或还停在待办的，仍算没派过

## 0.4.5

**「有未验证事项就转人工」改为默认勾选**

0.4.3 里它是默认关的，等于没解决问题：卡片带着"还没定的事"提交，照样自动判完成。

- `blockOnDebt` 默认改为 **true**：提交里只要还有 `pendingVerification`（agent 声明的未验证/待决策事项），
  自动验收就拒绝，卡片落「待验收」
- 想恢复旧行为（未验证只提示、不拦）可以把这一项关掉
- 老文档里没有这个字段的，读取时按默认 **开** 处理

配合上一条（0.4.4）：项目要显示 100%，必须所有卡片真正验收完。

## 0.4.4

**没验收的卡不再让项目显示 100%**

项目进度原本是「所有子任务 `progress` 的简单平均」。卡片退回「待验收」时 `progress` 仍是 100%，
于是项目条照样显示 100%（绿灯）——明明一件都还没验收。

- 规则改为：只有 `done` 的卡片计满 100；其余按自身进度、**最多计 99**
  → 项目只有在全部卡片都验收后才到 100%
- 项目色带：有「待验收」卡片就显示黄灯（原来只看平均值，会误报绿灯）
- 卡片上的进度条不变：它表达"这项工作做到哪了"，与"是否验收"是两件事

实测：一张卡在待验收、进度 100% 的项目，从 `100% / 绿` 变为 `99% / 黄`。

## 0.4.3

**让"还没决定"能拦住自动验收**

真实事故：一张「TB 单分析」卡，agent 提交了分析报告（8 条验证项全 pass、6 个交付物都在磁盘上），
自动验收直接判「已完成」——但人还没决定"要不要在这个子任务里修"。根因两条，都修了：

- **卡片级「需要我验收」开关补上了界面**：`task.requireHuman` 一直有效（置 true 必转人工），
  但界面上没有控件能打开它。现在卡片「阻塞」旁有复选框，勾上后卡片显示「待我验收」
- **新增项目规则 `blockOnDebt`（默认关）**：有未验证/待决策事项就转人工。
  以前 `verificationDebt` 只进 `warnings` 不阻断，卡片上明明记着"还有事没定"也照样自动通过
- `greenlight_acceptance` 可读写 `blockOnDebt`；`greenlight_task_update` 新增 `requireHuman` 参数
- `greenlight_task_submit` 描述引导 agent：还有没定的事、或某项没验证，要写进 `pendingVerification`，
  不要用一句完成说明盖过去

## 0.4.2

**绑定了会话但还没派活时，卡片会提示**
- 卡片会话行下方出现一行提示：「这个会话还没收到看板上下文（资料、卡片 id），点「派给会话」发送」
- 判据是「已绑定会话 + 卡片还在待办」：`新建主会话` 只把 id 写到卡片上，不会给会话任何上下文，
  卡片就一直停在这里；点一次「派给会话」后卡片进入「进行中」，提示自动消失
- 起因：真实使用时用「新建主会话」绑卡，会话里手打需求就开始干活，看板资料与记忆完全没被用上，
  卡片也一直停在待办

## 0.4.1

**派活提示词补上看板上下文**
- 提示词现在带 `projectId` 与 `taskId`：会话里的 agent 能直接更新**这一张**卡，
  不用靠标题去猜哪张是它
- 明确告诉它该调哪些工具：开工 `greenlight_task_update`（置 running）、
  交付 `greenlight_task_submit`（完成说明 + 验证项 + 交付物）、补资料 `greenlight_materials`、
  记结论 `greenlight_memory_add`，并写明**不要自己把卡片标成 done**
- 起因：真实项目里用「新建主会话」绑定卡片后，会话里的 agent 完全不知道看板存在，
  卡片一直停在「待办」。现在「派给会话」这条路径会把卡片 id 和工具说明一并送过去

## 0.4.0

**项目资料简化成一个文本框**
- 「项目资料」现在就是一个多行文本框：文档路径、约定、链接都写在这一段里，**输入即保存**
  （本地立即生效，600ms 防抖后写 Host，连续输入只发一次）
- 删除：资料条目列表、`链接/约定/其它` 三种类型、行内编辑、「扫描材料」、失效标记、
  卡片上的「引用资料」chips、`greenlight_reference` 与 `greenlight_intake` 两个工具
- 新增 `greenlight_materials`：agent 直接写整段资料文本
- 工具 17 → **16**

**数据**
- 数据版本 11 → **12**：`project.materials` 为一段文本；`project.references`、`task.refs`、
  `plan.items[].refs` 移除
- 旧文档（v9/v10/v11）读取时把条目合并成文本行，不丢内容；已有非空文本则保持原样

## 0.3.0

**从材料开工**
- 材料入口：在「项目资料」里粘贴本地路径或链接（一行一个）→「扫描材料」。
  目录递归展开，自动跳过 `.git`、`node_modules`、`dist`、`build`、`out`、`target`、
  `coverage`、`.next`、`vendor`、`__pycache__`；每个输入目录最多收 200 个文件；
  路径按项目根目录记为相对路径；扫不到的报「未找到」，已存在的报「跳过重复」
- AI 拆解：agent 读材料后用 `greenlight_intake` 把文件/链接收进项目资料，
  再用 `greenlight_plan_set` 写一份**拆解草案**——草案只是提案，不建卡
- 草案卡片（位于项目资料与子任务之间）：显示摘要、每项标题/说明/引用数，可
  **编辑**（改摘要、改标题与说明、删项、加项，保存走 `plan.set`）、
  **全部落卡**（`plan.apply`，重名任务自动跳过）、**丢弃草案**（需确认）
- 编辑保存会保留界面上看不到的字段（`refs` / `deliverables` / `tags` / `priority`），
  所以 AI 给的引用不会因为改了个标题就丢

**工具**
- 新增 `greenlight_intake`（扫描路径/链接，默认 dryRun 只报告）、`greenlight_plan_set`、
  `greenlight_plan_apply`；工具总数 14 → **17**

**数据**
- 数据版本 10 → **11**：`project.plan`（null 或草案）；老文档读取时自动补 `null`
- `POST /greenlight/ops` 响应新增可选的 `results` 数组（intake 的 added/missing/skipped、
  plan.apply 的 created/skippedTitles），旧客户端忽略即可

## 0.2.1

发布链路本身的变化，功能与 0.2.0 一致。

- 发布改由 GitHub Actions 用 **Trusted Publishing**（OIDC）完成：推 `v*` tag 即发布，
  不再需要长期 npm token，也不需要 2FA 验证码
- 发布带 **provenance** 证明（npm 页面上可见来源），消费者可验证这个包确实由本仓库的
  这条工作流构建
- 工作流会先校验 tag 与 `package.json` 版本一致，再跑宿主与客户端两套测试，最后才发布

## 0.2.0

**Typed references (breaking)**
- The free-text shared body and the reference-entry list are one typed list now:
  `project.references[]` holds `link` entries (a path or URL the Host re-checks, marks stale
  and cards can point at) and `note` entries (convention text that is never probed), plus a third
  `other` kind for anything that fits neither (an external system, a verbal agreement): free text,
  also never re-checked
- Old documents migrate on read: `project.shared` becomes a `note` named 项目说明 at the top,
  `project.sharedEntries` becomes `link` entries that keep their ids, so card `refs` keep working
- Tools: `greenlight_shared_set` and `greenlight_shared_entry` are replaced by
  `greenlight_reference` (list / add / update / remove); the tool count drops from 15 to 14
- The Host still accepts the old operation names (`project.setShared`, `sharedEntry.*`) so an
  older client does not break mid-upgrade

**Board**
- The panel is called 绿灯看板 / Greenlight Board, with a traffic-light mark whose green lamp is lit
- The project rail collapses from a single icon beside the title; collapsed it renders nothing at
  all, the content takes the full width, and the state is remembered per browser
- A reference row can be edited in place (kind, name, value, description) instead of only
  added and deleted
- The empty project rail no longer prints a hint; the new-project field is the affordance

**Fixes**
- A batch that patched deliverables and submitted in one request probed against the document from
  before the patch, so the deliverables looked unverifiable (probes now follow batch order)
- Whole-document imports and replacements park the previous file first
  (`board.json.backup-<stamp>-before-replace`, newest ten kept)
- Restoring archived cards rebuilt a project without its `references`
- Socket integration tests skip instead of failing on hosts that deny loopback TCP

## 0.1.0

First public release.

**Acceptance engine**
- Automatic acceptance: a card closes itself when its evidence, claims and deliverables check out;
  anything unverifiable escalates to a human with a concrete reason
- Real deliverable verification against the filesystem: relative paths resolve against the project
  root, directories and empty files count as missing, an unset root escalates instead of guessing
- Verification layers (`static` / `unit` / `build` / `host` / `device`) with per-project
  `requiredLayers`, so "it compiled" never looks like "it ran on the device"
- Per-card claims `{ what, how, layer, outcome }`; a passing claim must say how it was checked
- Configurable rules: require evidence, require deliverables, verify deliverables, require a Session,
  require a verified claim
- Verification debt: unverified items stay visible instead of silently disappearing
- Acceptance verdicts split blockers from warnings, so small gaps do not escalate whole cards
- Column gates can require evidence or deliverables before a card enters review

**Board**
- Projects → subtasks; each subtask can own a main Session and be dispatched with one click
- Per-project shared notes, reference entries and memory; references are re-probed and flagged stale
- Decision anchor: requirement digest, key decisions, open risks, deviations
- Per-card next action, reused as the opening line of a dispatch prompt
- Card history (moves, acceptances, escalations, claims, reviews) and independent review records
- `greenlight_preview` dry-runs operations without writing anything
- Six columns with drag and drop, search and filters, priority, due date, tags, templates
- 8-second undo, 7-day trash, and confirmation for every delete, archive, import and purge
- Cold-storage archive in a separate file, restorable at any time
- Chinese and English UI, SSE live updates, JSON import/export
- 15 `greenlight_*` tools for agents

**Storage**
- Atomic writes: temp file, `fsync`, read-back comparison, rename
- Corrupt documents are preserved as a backup instead of being overwritten
- Serialized mutations with revision checks, so concurrent writes cannot lose updates

**Tests**
- 93 host tests and 259 client render checks