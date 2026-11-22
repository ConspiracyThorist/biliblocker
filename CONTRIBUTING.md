# 参与贡献

## 开发环境

```bash
npm install
npm run build       # dist/BiliBlocker.zip、dist/BiliBlocker.user.js，并在仓库根留一份 user.js
npm run typecheck
npm test            # 本地测试套件（tests/ 不进仓库）
```

## 提交约定

- 提交信息 `<type>(<scope>): <描述>`，type 取 `feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `build` / `ci` / `chore`
- 一条提交只做一类改动；破坏性变更写 `!` 或 `BREAKING CHANGE:` footer
- `CHANGELOG.md` 常驻 `## [Unreleased]`，条目只用 Added / Changed / Deprecated / Removed / Fixed / Security

## 改动前请确认

1. 两端（扩展 + 油猴）共用 `src/core/`，**壳层只做适配**；改内核后两端产物都要重建
2. 新增阈值 / 上限 / 频率要写实测依据在注释里，不拍脑袋
3. 热路径（拦截、扫描）改动需附带耗时数字
4. 修 bug 要留下能复现它的测试；回滚修复后该测试应变红
5. 外部依赖失败必须降级：不白屏、不丢数据、不阻塞主流程

## 隐私红线

- 不引入任何上传用户数据的行为（除非用户显式开启且只上传匿名编号）
- 不申请 `cookies` 权限，不读取账号信息
- 本地凭据放 `.local/`（已 gitignore），永不进仓库
