# 视频排班汇总

部门内部使用的多人排班网页。生产环境使用 Render 托管 Node.js 服务，Neon
PostgreSQL 保存排班、用户和历史记录。

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

## 初始化和导入

服务启动时会自动执行 `migrations/001_init.sql`。首次迁移已有 JSON 快照：

```bash
DATABASE_URL='postgresql://...' pnpm import:snapshot -- path/to/state.json
```

连接串只保存在部署平台的 Secret/Environment Variables 中，禁止提交到仓库。

## 生产核验

1. `GET /api/health` 应返回 `storage: "postgres"`。
2. 对比迁移前后人员、周次、用户和历史记录数量。
3. 对同一字段提交过期补丁应返回 `409`。
4. 重启服务后再次核对数据和 revision，确认数据库持久化。
