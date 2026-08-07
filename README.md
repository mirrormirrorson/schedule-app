# 视频排班汇总

部门内部使用的多人排班网页。生产环境使用 Render 托管 Node.js 服务，Neon
PostgreSQL 保存排班、用户和历史记录。

## 低额度运行方式

服务启动时只从 PostgreSQL 读取一次排班、账号和历史记录，之后普通浏览、3 秒版本探测、
在线协作、账号权限查看及历史筛选全部从 Render 进程内存读取。真正的排班修改仍先在
PostgreSQL 事务中持久化，提交成功后才更新内存缓存，数据库失败时不会把未落库的数据伪装
成“已保存”。

- `/api/health` 和 `/api/ping` 不查询数据库，Render 健康检查不会持续唤醒 Neon。
- 正常保存只从数据库锁定并读取 revision，不再把整份排班 JSON 从 Neon 返回给服务端。
- 多条历史记录一次批量写入；历史裁剪只在确有新历史时执行。
- 已存在账号的 `last_seen_at` 默认最多每天写一次；身份、权限和在线状态仍即时生效。
- 历史抽屉由每 4 秒传输全部记录改为每 60 秒条件检查；无变化返回 HTTP 304 空响应。
- 当前缓存一致性以单个 Render 实例为前提；不要同时运行两个生产实例或绕过网页直接改表。

这样，日常空闲浏览和在线心跳不会产生 Neon 查询，Neon 连接在 30 秒空闲后释放，可继续
自动休眠。数据库仍是唯一真相源，内存只承担读取缓存。

## 数据模型

- `app_state`：当前排班 JSON 及单调递增的 `revision`
- `history_entries`：追加式操作历史
- `app_users`：用户列表

客户端保存时只发送实际变化的字段。服务器在事务内比对字段的旧值，避免两个浏览器
基于旧页面互相覆盖；冲突返回 HTTP `409`，由页面提示用户刷新或确认覆盖。

## 本地运行

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm start
```

未设置 `DATABASE_URL` 时使用 `data/db.json`，仅用于本地开发。生产环境必须配置
PostgreSQL 连接串。

为了避免本地验收改写仓库数据，可指定独立副本：

```bash
DB_PATH=/absolute/path/to/local-preview.json pnpm start
```

## 前端结构

- `public/index.html`：页面结构和脚本入口。
- `public/css/app.css`：原有页面主题、排班表和编辑交互样式。
- `public/css/enhancements.css`：条件管理和结构化历史记录样式。
- `public/js/state-sync.js`：持久化 outbox、同步、三方合并和冲突处理。
- `public/js/schedule-core.js`：排班表、总览、编辑、拖拽和撤销。
- `public/js/management.js`：人员、小组、条件和主题。
- `public/js/view-export.js`：视图和导出。
- `public/js/identity-history.js`：用户身份和修改历史。
- `public/js/bootstrap.js`：启动顺序。
- `public/js/background.js`：背景装饰。

页面顶部显示正在读取、正在保存、已保存、未保存和冲突状态。未提交修改会先写入
浏览器持久化 outbox；重新打开页面后与服务器最新状态做三方合并。

## 前端可靠性与记录

- 单元格编辑和主题保持原有线上交互与外观，本轮不发布本地试验版编辑器或主题。
- 修改记录按“内容、位置”统一分行；移动记录使用等宽的旧位置 → 新位置路线，
  日期和操作时间均显示完整年月日。
- 人员新增、改名、删除类记录不显示“位置”，并明确区分“常用人员模板”和
  “本周人员名单”；旧记录会按原字段自动归类。
- 历史抽屉打开时优先筛选当前周；在小组表中再优先筛选当前小组，在总览中显示
  当前周全部小组，并可手动切换为其他范围。
- 条件颜色提供更清晰的色板分组和自定义颜色，原有主题名称、主题背景和字体选择
  保持不变。

本地前端回归使用独立 `DB_PATH` 文件，禁止使用 Neon 生产连接串。当前契约、同步与
并发测试可通过 `pnpm test` 执行。

## 初始化和导入

服务启动时会自动执行 `migrations/001_init.sql`。首次迁移已有 JSON 快照：

```bash
DATABASE_URL='postgresql://...' pnpm import:snapshot -- path/to/state.json
```

连接串只保存在部署平台的 Secret/Environment Variables 中，禁止提交到仓库。

## 独立备份

项目包含每天两次的私有 GitHub JSON 备份、本地镜像、完整性检查和新库恢复工具。JSON
可以直接查看；备份过程只读数据库，不会修改 revision 或真实数据。旧 `.sab` 加密备份仍
可继续检查和恢复。详细配置和恢复步骤见
[`BACKUP_RUNBOOK.md`](BACKUP_RUNBOOK.md)。

## 生产核验

1. `GET /api/health` 应返回 `storage: "postgres"`。
2. 对比迁移前后人员、周次、用户和历史记录数量。
3. 对同一字段提交过期补丁应返回 `409`。
4. 重启服务后再次核对数据和 revision，确认数据库持久化。
