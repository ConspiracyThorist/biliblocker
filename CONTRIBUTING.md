# 参与贡献

## 开发环境

Node 20+，命令见 README 的「开发」一节（`npm install` / `npm run build` / `npm run typecheck`）。

## 提交约定

- 提交信息 `<type>(<scope>): <描述>`，type 取 `feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `build` / `ci` / `chore`
- 一条提交只做一类改动；破坏性变更写 `!` 或 `BREAKING CHANGE:` footer
- `CHANGELOG.md` 常驻 `## [Unreleased]`，条目只用 Added / Changed / Deprecated / Removed / Fixed / Security

## 改动前请确认

1. 两端（扩展 + 油猴）共用 `src/core/`，**壳层只做适配**；改内核后两端产物都要重建
2. 新增阈值 / 上限 / 频率要写实测依据在注释里，不拍脑袋
3. 热路径（拦截、扫描）改动需附带耗时数字
4. 修 bug 先能稳定复现，改完做一次回归自检（把修复回滚后问题应重现）
5. 外部依赖失败必须降级：不白屏、不丢数据、不阻塞主流程

## 隐私红线

- 不引入任何上传用户数据的行为（除非用户显式开启且只上传匿名编号）
- 不申请 `cookies` 权限，不读取账号信息
- 本地凭据放 `.local/`（已 gitignore），永不进仓库

## 行为准则

讨论与协作保持基本礼貌：对事不对人，不人身攻击，不发布他人隐私信息。
遇到骚扰或不当行为，用 [SECURITY.md](./SECURITY.md) 里的私密渠道联系维护者，不必公开对峙。
