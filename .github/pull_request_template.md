## 改了什么

<!-- 一句话说明；关联的 issue 用 Closes #123 -->

## 类型

- [ ] `feat` 新功能
- [ ] `fix` 修复
- [ ] `perf` 性能
- [ ] `docs` 文档
- [ ] `refactor` 重构
- [ ] `build` / `ci` / `chore`

## 自查（逐条确认，不是勾选形式）

- [ ] 两端同改：扩展与油猴共用 `src/core/`，本次改动会让**两个产物**都重建（只改一端的壳层除外）
- [ ] `npm run typecheck` 通过
- [ ] 单元测试通过；修 bug 时新增了能复现它的用例（回滚修复后应变红）
- [ ] 改了 UI 的话附截图
- [ ] 动了拦截/扫描热路径的话附耗时数字
- [ ] `CHANGELOG.md` 的 `[Unreleased]` 下加了条目，且只用 Added/Changed/Deprecated/Removed/Fixed/Security
- [ ] 新增的阈值/上限/频率在注释里写了实测依据
- [ ] 没有提交任何凭据、本地路径或 `.local/` 内容

## 说明

<!-- 有取舍、有反直觉的实现、或需要 reviewer 特别注意的地方写在这里 -->
