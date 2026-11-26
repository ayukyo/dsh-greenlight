# Changelog

All notable changes to this project are documented here.

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