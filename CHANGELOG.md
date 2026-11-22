# 更新日志

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- `SECURITY.md`：漏洞报告走 GitHub 私密渠道，写明设计上的非目标与残余风险
- `CODE_OF_CONDUCT.md`（Contributor Covenant 2.1）、PR 模板、Issue 模板、Dependabot 配置
- `.editorconfig`：统一 UTF-8 / LF / 2 空格 / 120 列
- README 增加状态徽章、常见问题、目录结构与「参与」入口

### Changed

- `LICENSE` 的版权行改回本项目作者；移植来源仍在 `CREDITS.md` 里逐一列明
- `package.json` 声明 `engines.node >= 20`，并补 `lint` 脚本作为 `typecheck` 的别名

## [1.0.1] - 2026-11-22

### Fixed

- 油猴头部 `@icon` 指向本仓库的 jsDelivr 链接，而 jsDelivr 不服务 fork 仓库，图标会 404；
  改指向数据仓（非 fork）的同一张图

## [1.0.0] - 2026-11-22

首个版本：把 [zhihu-bili-blocker](https://github.com/ConspiracyThorist/zhihu-bili-blocker)（知乎搬运拦截）
与 [biliHoyoFairy](https://github.com/gendu-amd/biliHoyoFairy)（规则过滤）合并成一个产品。

### Added

- 统一面板：概览 / 拦截 / 规则 / 设置四段，扩展弹窗与油猴浮层共用同一套 DOM 与样式
- 规则过滤：关键词（`/正则/`、`title:` / `up:` / `part:` 作用域）、UP 名、UID、BV、分区、
  播放 / 点赞 / 时长阈值、营销号低赞率、广告卡、直播卡
- 评论区过滤：关键词、昵称、等级、默认头像、AI 机器人、召唤 AI、带货导流、纯表情、纯 @；
  命中折叠成可展开的灰条，白名单（UP 主 / 置顶 / 自己）优先
- 评论区大图预加载：缩略图进入视口时预热原图，点开即显
- 播放页「屏蔽此 UP」：扩展迷你面板与油猴浮层都提供
- 规则导入：支持 `biliHoyoFairy` 导出的 JSON，联网维度会明确列为跳过
- 规则导出：导出本产品格式，用于备份与换设备

### Changed

- 题库上限 800 → 12000；匹配改用 bigram 倒排索引，2 万条题库下一批 20 条标题由 260 ms 降到 4.2 ms
- 条目 bigram 改存排序哈希数组，2 万条题库堆占用约 55 MB → 10 MB
- 配置存储改为「局部补丁 + 版本信封 + 自动备份」，多标签页不再互相覆盖

### Fixed

- 卡片选择器过宽，把卡片内层包裹层当成独立卡片，广告卡被拆成碎片
- 扫描器在题库就绪前把卡片标成「已处理」，首屏那批卡片永远等不到判定
- 评论只扫影子树里的子节点，宿主本身从不判定
- 浮窗的弹层让位用了过宽的选择器，命中常驻容器后胶囊永久隐藏
- 油猴版 DOM 层缺少规则过滤，与扩展版行为不一致

### Security

- 存储写入收归 background 单写者，配置带 revision 与 5 份滚动备份
- 远端题库读取上限 512 KB → 4 MB；`/正则/` 规则保留长度上限与灾难性回溯拒收
