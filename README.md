# BiliBlocker

[![CI](https://github.com/ConspiracyThorist/biliblocker/actions/workflows/ci.yml/badge.svg)](https://github.com/ConspiracyThorist/biliblocker/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ConspiracyThorist/biliblocker)](https://github.com/ConspiracyThorist/biliblocker/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-安装-fb7299)](https://greasyfork.org/scripts/606704)

**B 站推荐流屏蔽器。** 在推荐数据抵达页面之前把它删掉——不是事后遮住，所以没有留白、没有闪烁。
两件事同时做：**拦截搬运知乎热榜的视频**，以及**按你自己的规则过滤推荐流与评论区**。

提供 Chrome 扩展与油猴脚本两种形态，共用同一套内核（`src/core/`）。

## 界面

![概览](assets/screenshots/panel-overview.png)
![规则](assets/screenshots/panel-rules.png)

## 能做什么

- **知乎搬运拦截**：同步知乎热榜题库（当前 600+ 条，每天增量），按标题归一后做 bigram 相似度匹配，命中即从 feed JSON 里摘掉
- **规则过滤**：关键词（支持 `/正则/` 与 `title:` / `up:` / `part:` 作用域）、UP 名、UID、BV 号、分区、播放/点赞/时长阈值、营销号低赞率、广告卡、直播卡
- **评论区过滤**：关键词、昵称、等级、默认头像、AI 总结机器人、带货导流、纯表情、纯 @；命中折叠成可展开的灰条
- **评论区大图预加载**：图片滚进视口就缓存原图，点开不再转圈
- **白名单优先**：标题 / UP / 分区 / UID 命中白名单永不屏蔽
- **一次点击**：卡片上「屏蔽此 UP」、播放页「屏蔽此 UP」、记录里「放行」
- **双端一致**：扩展与油猴共用面板、规则、存储层

## 安装

### 油猴（Tampermonkey）

前置：浏览器装好 **Tampermonkey**（或 Violentmonkey）。Chrome / Edge 需要在 `chrome://extensions`
打开「开发者模式」，并允许用户脚本运行，否则脚本不会执行。

**推荐**：从 Greasy Fork 安装 —— <https://greasyfork.org/scripts/606704>

也可以直接用仓库里的文件：

1. 打开 [BiliBlocker.user.js](./BiliBlocker.user.js)（压缩版，直接安装）
2. Tampermonkey 会弹出安装页；或把它拖进浏览器窗口
3. 刷新 B 站，右下角出现胶囊

> 脚本市场（Greasy Fork）要求源码可读，仓库里另有一份未压缩的
> [BiliBlocker.greasyfork.user.js](./BiliBlocker.greasyfork.user.js)，那份就是市场版，功能完全相同。

### Chrome 扩展

1. 下载 Release 里的 `BiliBlocker.zip` 并解压
2. 打开 `chrome://extensions`，启用「开发者模式」
3. 「加载已解压的扩展程序」，选择解压目录

> 需要 Chrome 116+（侧边栏 API 与 `world: "MAIN"` 注入）。
> **两个版本不要同时装**：会各自 hook 一遍 fetch，记录重复、开销翻倍。

## 用法

点右下角胶囊展开面板，四段：**概览 / 拦截 / 规则 / 设置**。

规则页顶部输入框会自动识别类型：

| 输入 | 落到哪 |
|---|---|
| `BV1xx411c7mD` | BV 号（屏蔽单视频） |
| `7001`（纯数字） | UID |
| `/震惊[！!]{2,}/` | 正则关键词 |
| `送十连` | 标题关键词 |
| `up:某个UP` | 只匹配 UP 名 |

**设置 → 数据 → 导入规则文件** 可以直接导入 `biliHoyoFairy` 导出的规则 JSON；
联网维度（视频标签 / 组合标签 / UP 简介）本产品未实现，导入时会明确列出跳过项。

## 数据来源

题库与 UP 库由数据仓 [ConspiracyThorist/zhihu-bili-blocker](https://github.com/ConspiracyThorist/zhihu-bili-blocker)
的 GitHub Actions 每天更新，客户端从 CDN 拉取；本地也会按 30 天窗口累积，上限 12000 条。

## 隐私

- 题库、规则、命中记录全部存在浏览器本地，不上传
- 只有手动拉黑 UP 且开启「匿名贡献」时，会把 UP 编号与昵称提交到投稿端（不含任何账号信息，可关闭）
- 不申请 `cookies` 权限，读不到账号信息

## 常见问题

**装上之后没效果？**
先确认只装了一个版本（扩展或油猴），再看面板「概览」里题库条数与累计拦截数是否在变。默认「保守」档只拦原样搬运，改写过的可能放过，可在设置里切「标准」或「激进」。

**照搬的视频被漏了？**
记录里没有就能确认没命中。优先加关键词规则（规则页顶部输入框），比调低阈值更可控。

**误拦了正常视频？**
记录里点「放行」加白名单；或把强度切回「保守」。

**两个版本能一起装吗？**
不要。它们各自 hook 一遍 `fetch`，判两次、记录重复、开销翻倍。

**题库为什么不涨？**
题库由数据仓的 Actions 每天跑一次增量：热榜约 30 条，去重后实际新增十几到二十条，所以是缓慢爬升。

## 目录结构

```
src/core/        与宿主无关的内核：归一、相似度、判定、剪枝、hook、扫描、规则、评论、面板、预加载、存储
src/extension/   Chrome MV3 壳：background（唯一配置写者）/ content / page(MAIN world) / popup
src/userscript/  油猴壳：同一套 core，GM_* 适配
assets/icons/    扩展与脚本图标
tools/           构建辅助（zip 打包）
docs/            面向脚本市场的附加信息
```

## 参与

- 贡献流程与提交约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)
- 漏洞请走私密渠道，见 [SECURITY.md](./SECURITY.md)
- 行为准则见 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

## 开发

```bash
npm install
npm run build      # dist/BiliBlocker.zip + 两种 user.js，并在仓库根留一份
npm run typecheck
npm test           # 本地测试套件（tests/ 按维护者惯例不进仓库）
```

架构、判定规则与性能数据见 [DEVELOP.md](./DEVELOP.md)。

## 许可证

MIT。本项目移植并改写了 [biliHoyoFairy](https://github.com/gendu-amd/biliHoyoFairy)（MIT）与
bili-comment-preload 的部分逻辑，来源与版权声明见 [CREDITS.md](./CREDITS.md)。
