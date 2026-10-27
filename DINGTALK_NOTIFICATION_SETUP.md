# 钉钉排班私信配置

这套通知使用“钉钉企业内部应用机器人”的单聊能力，不使用群 Webhook，也不依赖任何电脑上的个人 CLI 登录态。

## 1. 钉钉开放平台

在当前企业组织内创建或选择企业内部应用，并完成：

1. 添加企业内部机器人。
2. 开通企业内机器人发送消息权限。
3. 发布应用到当前组织可用范围。
4. 记录应用的 Client ID（AppKey）、Client Secret（AppSecret）和 Robot Code。

不要把这三个值粘贴到源码、GitHub、网页人员绑定框或聊天消息中。

## 2. Render 密钥位置

打开 Render Dashboard，进入生产服务 `schedule-app`：

`Environment` → `Environment Variables` → `Add Environment Variable`

添加：

```text
DINGTALK_CLIENT_ID=<钉钉应用 Client ID / AppKey>
DINGTALK_CLIENT_SECRET=<钉钉应用 Client Secret / AppSecret>
DINGTALK_ROBOT_CODE=<企业内部机器人 Robot Code>
DINGTALK_NOTIFY_ENABLED=true
PUBLIC_APP_URL=https://schedule-app-4njk.onrender.com
DINGTALK_NOTIFY_AGGREGATE_MS=60000
DINGTALK_NOTIFY_SELF=false
```

- 前三个是钉钉凭证，只能放 Render Environment。
- `DINGTALK_NOTIFY_AGGREGATE_MS=60000` 表示同一老师连续修改后等待 60 秒合并成一条私信。
- `DINGTALK_NOTIFY_SELF=false` 表示老师自己修改自己的排班时不再私信自己；改为 `true` 可开启。

保存 Render 环境变量会触发服务重启。仅配置前三个凭证但保持 `DINGTALK_NOTIFY_ENABLED=false` 时，可以先部署代码和绑定人员，不会发送消息。

## 3. 绑定老师

用张雅镜、林俊凯或简慧仪账号登录排班网页：

`管理` → `钉钉通知`

为每位老师填写组织通讯录中的钉钉 `userId`，勾选“启用私信”，点击“保存绑定”。这里填写的是人员标识，不是应用密钥。

未绑定或已停用的人员不会收到消息，但排班仍会正常保存；管理员可在页面下方看到“未发送：未绑定钉钉账号”。

## 4. 上线验收顺序

1. 先保持 `DINGTALK_NOTIFY_ENABLED=false` 部署，确认排班读取、保存和历史记录正常。
2. 只绑定一个测试人员。
3. 将 `DINGTALK_NOTIFY_ENABLED=true`，修改测试人员一个测试排班并等待 60 秒。
4. 确认收到的是私信、收件人正确、正文包含日期/小组/操作人。
5. 撤销测试排班并核对生产 revision 与业务数据；再逐步绑定正式人员。

通知失败不会回滚排班。服务最多重试三次；仍失败时记录在“管理 → 钉钉通知 → 最近通知”。
