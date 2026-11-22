# BiliBlocker

**B 站推荐流屏蔽器。** 在推荐数据抵达页面之前把它删掉——不是事后遮住，所以没有留白、没有闪烁。
两件事同时做：**拦截搬运知乎热榜的视频**，以及**按你自己的规则过滤推荐流与评论区**。

提供 Chrome 扩展与油猴脚本两种形态，共用同一套内核（`src/core/`）。

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

1. 打开 [BiliBlocker.user.js](./BiliBlocker.user.js)
2. Tampermonkey 会弹出安装页；或把它拖进浏览器窗口
3. 刷新 B 站，右下角出现胶囊

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

## 开发

```bash
npm install
npm run build      # dist/BiliBlocker.zip + dist/BiliBlocker.user.js，并在仓库根留一份 user.js
npm run typecheck
npm test           # 本地测试套件（tests/ 不进仓库）
```

架构、判定规则与性能数据见 [DEVELOP.md](./DEVELOP.md)。

## 许可证

MIT。本项目移植并改写了 [biliHoyoFairy](https://github.com/gendu-amd/biliHoyoFairy)（MIT）与
bili-comment-preload 的部分逻辑，来源与版权声明见 [CREDITS.md](./CREDITS.md)。
