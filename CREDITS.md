# 来源与版权

本项目是 MIT 许可的开源软件。下列代码衍生自他人的 MIT 项目，按 MIT 要求保留出处与版权声明。

## biliHoyoFairy

- 上游：<https://github.com/gendu-amd/biliHoyoFairy>（作者 gendu-amd，MIT）
- 用到的部分：
  - `src/core/rules/text.ts` —— 规则文本归一、作用域关键词编译、`/正则/` 与反绕过处理
  - `src/core/rules/card.ts` —— 推荐接口列表项的字段归一
  - `src/core/rules/domCard.ts` —— 卡片 DOM 抽取与选择器（含 BewlyCat 适配）
  - `src/core/comments.ts` —— 评论组件 `__data` 读取、判定维度与折叠交互
  - 规则导入的字段映射参考其导出文件结构
- 改动：去掉订阅源、联网维度（视频标签 / 组合标签 / UP 简介）、简繁归一；
  存储、面板、扫描器、拦截管线换成本项目的实现。

## bili-comment-preload

- 来源：本项目维护者早前的油猴脚本（MIT）
- 用到的部分：`src/core/preload.ts` 的评论区大图预加载思路与 URL 处理
  （剥掉 CDN 转码参数、统一到 i0 主机以命中同一条 HTTP 缓存）

## 第三方运行依赖

构建期依赖 esbuild、TypeScript；运行时无第三方库。
