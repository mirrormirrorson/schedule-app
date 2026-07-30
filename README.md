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

## 生产核验

1. `GET /api/health` 应返回 `storage: "postgres"`。
2. 对比迁移前后人员、周次、用户和历史记录数量。
3. 对同一字段提交过期补丁应返回 `409`。
4. 重启服务后再次核对数据和 revision，确认数据库持久化。
