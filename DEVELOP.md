# 开发说明

## 架构

```
src/core/          与宿主无关：归一、相似度、判定、JSON 剪枝、fetch hook、DOM 扫描、规则、评论、面板、预加载
src/extension/     Chrome MV3 壳：background（单写者）/ content / page(MAIN world) / popup
src/userscript/    油猴壳：同一套 core，GM_* 适配
```

两条拦截路径共用一份判定：

1. **网络层（主）**：`page.js` 在 `document_start` hook `fetch` 与 XHR，拿到 feed JSON 后先按规则、再按知乎题库剪枝，有删项才重建响应
2. **DOM 层（兜底）**：SSR 首屏、接口没覆盖的版式，`content.js` 用 MutationObserver 增量扫描卡片

两端都从 `core/` 取同一套 `matchTitle` / `matchCard` / `matchComment`，所以结论一致。

## 判定规则

| 级别 | 条件 | 场景 |
|---|---|---|
| `exact` | 归一后完全相同 | 直接搬运 |
| `contain` | 互相包含，得分为长度比 | 加前后缀 |
| `dice` | 字符 bigram 相似度 ≥ 阈值 | 等长改写 |
| `cover` | 短标题 bigram 被覆盖比例 ≥ 阈值 | 删减版 |
| `rule` | 关键词 / UP / UID / BV / 分区 / 数值 / 卡片类型 | 用户自定义 |

三档阈值：保守 0.86（默认）/ 标准 0.78 / 激进 0.66，来自 259 条题库的分数分布实验。
`rule` 是用户显式配置，优先于标题匹配；白名单（标题 / UP / 分区 / UID）优先级最高。

## 匹配性能

题库上万条后线性比对不可行（2 万条时一批 20 个标题要 260 ms）。实现是 bigram 倒排索引 + 上界剪枝：

- 索引：`bigram 哈希 → 条目下标`；查询侧累加共享量上界
- 下界：`need = 阈值 × min(查询 bigram 数, 条目 bigram 数)`，同时覆盖 dice 与覆盖率两条路
- 只对候选做完整算分，结论与线性扫描逐条一致（测试里有等价性断言）

实测（2 万条题库、20 条标题一批）：线性 145 ms → 索引 **4.2 ms**；建池 +110 ms，堆 +10 MB。
条目侧 bigram 存为升序 `Uint32Array`，多集交集用双指针。

## 存储

- 只有 background 写配置，UI 一律发 `PATCH_SETTINGS`（局部补丁）
- 存储形态 `{ rev, data }`；写入前留快照（滚动 5 份），可回滚
- 高频数据（命中记录 / 计数 / 题库）各自独立键，计数自增不重写规则

## 扫描策略

- 首屏：mutation 只收集新增节点，扫描只针对新子树
- 补扫：2s 一次，标签页不可见时跳过，60s 后停止
- 配置变更：`unhideAll()` + `rescan()`，删掉规则后卡片会当场恢复

## 构建

```bash
npm run build
```

esbuild CLI 打包（`--minify`），产物：
`dist/extension/*` → `dist/BiliBlocker.zip`、`dist/BiliBlocker.user.js`，并在仓库根留一份 user.js 供直接安装。
