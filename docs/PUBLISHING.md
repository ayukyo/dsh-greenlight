# 发布与上架（Publishing）

这份文档记录 Greenlight 怎么发布、怎么被插件市场收录、以及"来源指向本仓库"靠的是什么字段。
面向维护者，不面向使用者。

---

## 一、发布渠道的真实结构

DSH 没有"第三方提交到官方目录"的入口。实测当前 profile 的 `plugin_manager.list_bundles`：

| 包 | official | availability | source |
|---|---|---|---|
| `@deepseek-ai/dsh-experimental-forge-bundle` | `true` | installation | 随 DSH 发行 |
| `dsh-greenlight` | `false` | profile | `dsh-greenlight@0.2.0`（npm 装）或 `link:...`（本地开发） |

- `official: true` 只属于 `@deepseek-ai/*` 包，随 DSH 版本发布
- 第三方插件的"上线" = **发布到 npm**，用户安装后进入其 profile 的插件列表
- 社区市场全部从 npm 抓取，因此 npm 是唯一必需的分发点

## 二、发布一次（每个版本）

```powershell
# 1) 版本与变更
#    改 package.json 的 version，CHANGELOG.md 顶部加同版本小节
# 2) 本地验证
node --test "host/test/**/*.test.js"
node test/client-checks.cjs ./client.js ./host/board.js
# 3) 打包内容自检（确认 host/*.js 进包、测试不进包）
npx npm pack --dry-run
# 4) 发布（2FA 账号需要 OTP，或用 Automation token）
npm publish --access public
# 5) 打 tag + Release（来源=本仓库）
git tag -a vX.Y.Z -m "Greenlight X.Y.Z"
git push origin vX.Y.Z
```

发布后核对：

```powershell
npm view dsh-greenlight version        # 应当是刚发的版本
npm view dsh-greenlight repository.url # 应当是 git+https://github.com/ayukyo/dsh-greenlight.git
```

## 三、"来源指向本仓库"靠什么字段

插件详情、市场条目、npm 页面都读 `package.json`，所以以下字段就是来源标注：

| 字段 | 值 |
|---|---|
| `repository.url` | `git+https://github.com/ayukyo/dsh-greenlight.git` |
| `homepage` | `https://github.com/ayukyo/dsh-greenlight#readme` |
| `bugs.url` | `https://github.com/ayukyo/dsh-greenlight/issues` |
| `author` | `ayukyo` |
| `keywords` | `dsh`、`dsh-plugin`、`deepseek-harness`、`task-board`、`acceptance`、`verification` … |

`keywords` 决定 npm 搜索能否命中：社区市场按 `keywords:dsh-plugin` / `keywords:deepseek-harness` 抓取。

## 四、更新如何同步到市场

四个社区市场的 npm 版本号都是**日期**，说明按日重建：

| 市场 | 抓取包 | 最新版本号示例 | 源码仓库 |
|---|---|---|---|
| awesome-dsh-plugin | `dsh-plugin-catalog` | `2026.1125.27413` | `awesome-dsh-plugin/awesome-dsh-plugin` |
| awesome-dsh-plugin-pro | `awesome-dsh-plugin-feed` | `20261126.1` | `bruc3van/awesome-dsh-plugin-pro` |
| dshmarket | `dshmarket` | `1.84.1` | `dsh-market/dsh-market` |
| dsh-plugin-shop | `dsh-plugin-shop-catalog` | `2026.1125.0` | `LivXue/dsh-plugin-shop` |

结论：**发布新版本后不需要逐版本提 PR**，市场下次重建时自动同步版本与仓库链接。
首次收录通常要在对应仓库提 issue/PR 说明项目（文案见下）。

## 五、四个市场的提交文案

统一信息（可直接复制）：

- 名称：`dsh-greenlight`
- 一句话（中）：**能核对的自动通过，核不了的才找人** —— DSH 的验收看板：卡片凭证据与交付物自动完成，只有核不了的才转人工。
- 一句话（英）：**A verifiable task board for DeepSeek Harness** — cards close themselves when their evidence and deliverables check out; only the unverifiable ones ask a human.
- 仓库：https://github.com/ayukyo/dsh-greenlight
- npm：https://www.npmjs.com/package/dsh-greenlight
- 安装：`npm i dsh-greenlight`，然后在 DSH 插件页启用（或写入 profile 依赖）
- 关键词：`dsh` `dsh-plugin` `deepseek-harness` `task-board` `kanban` `acceptance` `verification` `agent-workflow`
- 许可证：MIT
- 截图：`docs/board.png`、`docs/columns.png`

**1) awesome-dsh-plugin**（`github.com/awesome-dsh-plugin/awesome-dsh-plugin`）

> 提 PR 往列表里加一行：`- [dsh-greenlight](https://github.com/ayukyo/dsh-greenlight) — 带验收判断的项目看板：证据/交付物核对通过即自动完成，核不了的转人工。`

**2) awesome-dsh-plugin-pro**（`github.com/bruc3van/awesome-dsh-plugin-pro`，标注 "every reviewed repository"）

> 走它的评审收录流程；提交时附仓库、npm 包名、许可证、一句话介绍，并说明"无遥测、无网络请求、数据只写本地 `~/.dsh/greenlight/`"。

**3) dshmarket**（`github.com/dsh-market/dsh-market`，站内可视化市场）

> 在其仓库提 issue 申请收录，附 npm 包名 `dsh-greenlight`（它按包名安装，需要能 `npm i` 成功）。

**4) dsh-plugin-shop**（`github.com/LivXue/dsh-plugin-shop`）

> 同上，提交包名与仓库链接；它的 catalog 也是按 npm 抓取。

## 六、发布前的检查清单

- [ ] `package.json` 版本号与 CHANGELOG 一致
- [ ] `npm pack --dry-run` 里 `host/*.js` 齐全、`host/test/**` 不在包内
- [ ] `locale/zh.json`、`locale/en.json` 的 `meta.title` / `meta.description` 是当前定位
- [ ] `docs/board.png`、`docs/columns.png` 与当前 UI 一致（改过界面就重拍）
- [ ] README 顶部 `npm version` 徽章指向的包名正确
- [ ] `repository` / `homepage` / `bugs` 三个字段仍指向本仓库
- [ ] 打包后 `files` 列表未意外包含本地数据（`board.json` 之类由 `.gitignore` 挡在仓库外）