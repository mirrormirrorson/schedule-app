# 排班数据库备份与恢复手册

## 目标

数据库仍是线上唯一写入真相源；GitHub 和本地只保存只读、可直接查看、可恢复的 JSON 快照，绝不再把
GitHub 当作网页每次编辑时来回同步的数据源。

备份采用两层副本：

1. GitHub Actions 每天北京时间 02:20 和 14:20 从 Neon 各做一次一致性只读快照，生成
   UTF-8 JSON，然后作为独立私有备份仓库的 GitHub Release 附件保存。
2. 本机定期把最新的 GitHub JSON 附件下载到 `production-backups/github-mirror/`。即使 Neon
   因额度限制完全拒绝连接，GitHub 和本机副本仍能读取。

新备份文件后缀为 `.json`，其中包含排班状态、账号权限、修改历史和近 30 天防重复提交
记录。仓库必须保持 Private，因为 JSON 可以直接阅读。原有 `.sab` 加密备份保留，检查和
恢复工具继续兼容，不需要删除。

## 首次配置

1. 新建私有仓库 `mirrormirrorson/schedule-app-backups`，不要把备份 Release 放在当前公开的
   源码仓库里。
2. 在私有备份仓库创建 `.github/workflows/encrypted-database-backup.yml`。文件名为兼容旧任务而保留，当前工作流实际生成可直接阅读的 JSON；工作流只读检出公开源码仓库，
   并把 JSON 快照发布为当前私有仓库的 Release。
3. 把当前生产数据库连接串填入私有备份仓库的 Actions Secret `BACKUP_DATABASE_URL`。
   工作流使用该仓库自身的 `github.token` 写 Release，不需要额外保存 GitHub 访问令牌。
4. 在 GitHub Actions 手动运行一次 `Readable database backup`，确认私有仓库产生
   `db-backup-*` Release。

## 本地备份

有数据库连接时可直接生成一份本地 JSON 备份：

```powershell
$env:BACKUP_DATABASE_URL='postgresql://...'
pnpm backup:export
Remove-Item Env:BACKUP_DATABASE_URL
```

也可以从 GitHub Release 下载最新 `.json` 到本机，这不会访问 Neon，也不会消耗 Neon
Compute 或 Network transfer。

```powershell
$env:GITHUB_BACKUP_TOKEN='只读私有备份仓库的令牌'
.\scripts\mirror-latest-backup.ps1
Remove-Item Env:GITHUB_BACKUP_TOKEN
```

## 每月检查

每月第一周做一次不写数据库的结构校验：

```powershell
pnpm backup:inspect -- production-backups/github-mirror/某个备份.json
```

成功时会显示 revision、人员数、历史记录数和校验哈希。JSON 本身可以用浏览器、记事本或
VS Code 直接打开。不要把备份上传到公开仓库或公开网盘。

## 灾难恢复

优先创建一个全新的空数据库，然后先运行只读验证：

```powershell
pnpm backup:restore -- production-backups/某个备份.json
```

确认备份日期、revision 和数量正确后，才允许写入新数据库：

```powershell
$env:RESTORE_DATABASE_URL='postgresql://新数据库...'
pnpm backup:restore -- production-backups/某个备份.json --apply --confirm-database 新数据库名称
Remove-Item Env:RESTORE_DATABASE_URL
```

恢复工具默认拒绝覆盖非空数据库。确需覆盖时，必须先对目标再做一份独立安全备份，并显式
设置 `RESTORE_ALLOW_NONEMPTY=yes`。不要直接在正在使用的生产库上试恢复。

旧 `.sab` 备份仍可通过 `--private-key` 指定原私钥后检查或恢复；新 JSON 不需要私钥。

## 保留策略

- GitHub：保留最近 70 个备份点（约 35 天）；更早的非月备份自动清理，每月 1 日备份长期保留。
- 本地：不自动删除，确认磁盘空间和多份结构验证成功后再人工归档。
- Neon：仍可使用平台自带恢复功能，但不把它当作唯一备份。
