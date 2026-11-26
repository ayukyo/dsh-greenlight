# Changelog

All notable changes to this project are documented here.

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