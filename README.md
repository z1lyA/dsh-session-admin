# dsh-session-admin — 已归档会话管理（DSH 插件）

在 DSH Web 界面左侧栏的「全局面板」区（与 Plugins / Schedules 同一列）新增一个 **已归档** 入口，点击后在中央区打开管理页：

- 列出全部已归档会话（标题、工作区、最后活跃时间、磁盘占用）；
- 全选 / 半选 / 单选；
- 批量**取消归档**（走 DSH 官方 `workspaces.unarchiveSession`）；
- 批量**删除**：能立即删的立即删，仍在 Host 内存里的标记为**待删除**、下次启动 DSH 时自动删除（可随时取消）。

> DSH 本身没有删除会话的 API，只有归档/取消归档。本插件补上删除能力，并把所有边界条件做成显式规则。

## 入口位置说明

DSH 原生「工作区」标题栏（搜索 / 视图 / 添加工作区）是 `@deepseek-ai/dsh-client-ui-workspace` 的封闭 JSX，没有插件扩展点；`sidebar.workspaces` 是已被占用的 single 槽。要“并排”只能整体替换原生浏览区（升级易碎）。因此本插件使用受支持的 `sidebar.panellist` + `main` keyed 页面，入口在侧栏面板列、工作区列表上方。

## 删除会做什么

删除分两种结果（混合策略）：

- **会话不在 Host 内存里**：确认后立即删除。
- **会话仍在 Host 内存里**（打开过、归档后 Agent 句柄仍驻留，DSH 没有公开的“关闭会话”接口）：确认后只登记为**待删除**，不碰任何文件；下次启动 DSH、Agent 存储为空时自动执行完整删除。页面行会显示「待删除」，可随时取消（工具栏批量取消或行内取消）。取消只删队列记录，不涉及磁盘。

队列保存在 `$DSH_HOME/session-admin/pending-deletions.json`（原子写、最多 500 条、单实例前提）。启动执行时会重新校验：会话仍归档、没有 live 会话/子代理；不满足就保留到下次启动，失败会记录原因并显示「删除失败」。

**取消归档会立即清除待删除**：无论在插件页面、原生侧栏菜单还是另一个标签页取消归档，Host 监听 workspace 域的 `domain/changed`（全局归档集合）后清除对应队列条目；页面每次读取列表、以及插件自身执行取消归档时也会兜底清理。重新归档不会恢复之前排队的删除意图。

实际执行时，对每个会话（以及它的 `origin: subagent` 派生子会话）：

1. 校验：必须仍在归档集合；当前不能有 live agent/子代理。
2. 删除整个会话日志目录：`$DSH_HOME/sessions/<cwd 编码>/<sessionId 编码>/`
   （整个目录删除，包含 v3/v4 代际；绝不截断 zstd 日志）。
3. 删除投影缓存记录：`$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json`
   （优先走 `storageDomain`，失败时按精确文件删除并告警）。
4. 删除绑定到该会话的定时任务（`ctx.schedule`），避免继续向已删会话投递。
5. 移除工作区记录中的会话槽位（best-effort `detachSession`）、取消置顶、移除归档墓碑。
6. **附件（可选，默认开）**：先读被删会话的事件，得到候选 `sha256:` 对象；再扫描其余全部会话事件 + `$DSH_HOME/llm-deepseek/files-v3.json` 上传索引；只删除**没有任何剩余引用**的 `attachments/v1/{objects,file-objects,files}` 对象。扫描不完整（读失败/超预算）时**一个附件都不删**，并在结果里报告原因。
7. 返回逐条结果与释放字节数；失败条目保留归档状态，方便重试（排队条目则保留队列，下次启动重试）。

**不会动**：其他会话、`sessions/<project>/` 目录本身、`workspace.json`（只通过 registry API 改）、`.credentials.yaml`、`profiles/**`、`cache/attachments/request-images`（跨会话派生缓存）、用户仓库里的 git worktree。

## 安全规则

- 只接受 `workspaceRegistry.archivedSessionIds` 中的 id；非归档 id 一律拒绝。
- 内存中的会话不会立即删除，只排队到下次启动；这是为了避免活句柄下删日志导致无头日志或缓存回写。
- session id 只接受 `^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`，路径全部做包含性校验。
- 每批最多 100 个 id，串行执行；同一时间只跑一个删除任务。
- HTTP 路由只对本机回环 `Host` 开放，并叠加同源 / `Sec-Fetch-Site` 检查与 `ctx.connection.requestRejection`。

## 已知限制

- 删除/取消归档成功后会调用 `ctx.sessions.refresh()` 重建侧栏会话列表；如果页面/侧栏仍显示已删除的行（旧版本或刷新前），那是客户端会话列表的残留：刷新页面（Ctrl+R）或重启 DSH 即可消失，不要再去归档/删除它（Host 会报“会话不存在”）。
- 多开 DSH 实例时，JSON 存储域是“最后写入者获胜”，别的实例可能回写已删除的缓存/记录（日志删除仍生效）；建议单实例操作，删完重启核对。待删除队列也由先启动的实例执行。
- 重启前插件被禁用/卸载时，待删除队列不会执行；重新启用后的下一次启动会继续处理。
- 归档墓碑的清理依赖 `unarchiveSession`；工作区槽位在旧版本没有公开删除 API，使用内部 `detachSession`，失败时槽位会在下次 registry 写入或重启后自行修剪（界面不再显示该会话）。
- 上传索引里 TTL 未过期的附件 id 会被视为“仍被引用”，因此对应对象会保留。
- 未发送草稿中的附件引用对 Host 不可见；若另一会话草稿恰好引用了同一内容哈希，存在极小概率被清理（内容寻址去重导致）。

## 为什么没有 agent 工具

DSH 的 agent 工具按 **agent preset** 组合，web 应用层的 bundle 行注册的工具不会被放进会话的工具作用域（实测：同层注册的探针工具不会出现在 `Tool.listTools`）。因此本插件不附加 agent 工具，删除/取消归档只能由用户在页面上操作——永久删除本来也应当只留给用户。若以后需要 agent 自助操作，正确做法是把工具行写进 agent preset，而不是这个 web bundle。

## 配置

`cordis.patch.yml` 行 `session-admin` 支持：

| 键 | 默认 | 含义 |
|---|---|---|
| `cleanupAttachmentsDefault` | `true` | 删除对话框里“同时清理未引用附件”的默认勾选状态 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | DSH 主目录（一般不用改） |
| `sessionsRoot` | `$DSH_HOME/sessions` | 会话日志根 |
| `storagesRoot` | `$DSH_HOME/storages` | JSON 存储根 |
| `attachmentsRoot` | `$DSH_HOME/attachments/v1` | 附件根 |

## 安装

从 GitHub 安装（推荐，需要 Full access）：

```
dsh plugin --profile desktop add github:Zipeter/dsh-session-admin
```

或用本地目录安装（开发调试）：

```
plugin_manager({ action: "install_bundle", target: "H:\\CodeProject\\dsh-session-admin" })
```

安装后刷新一次 Web 页面（Client 插件清单在启动时收集）；Host 代码变更需重启 DSH。

卸载：

```
plugin_manager({ action: "remove_bundle", target: "dsh-session-admin" })
```

卸载只移除插件行与包链接，不会恢复已删除的会话（那是不可逆的）。

## 开发与测试

```
cd dsh-session-admin
node --check index.js
node --check client.js
node --test
```

单元测试覆盖：路径编码/越界、目录尺寸、投影缓存路径、附件引用提取、只删无引用对象、扫描不完整时零删除、删除/计划/子代理后代、live 会话排队、取消待删除、启动清扫（删除/丢弃/保留）、队列持久化与上限、清单与显示资源。

## 结构

```
index.js            Host 入口：HTTP 路由 + 启动清扫
client.js           浏览器半：侧栏入口 + 管理页 + 确认弹窗
lib/paths.js        DSH 主目录/日志/缓存/附件路径与编码
lib/attachments.js  内容寻址附件引用扫描与安全删除
lib/archive.js      归档清单、删除计划、执行删除、排队/取消、启动清扫
lib/pending.js      待删除队列的原子读写
lib/http.js         信任栅栏、JSON body、响应
locale/{zh,en}.json 插件显示元数据
icon.svg            原始归档盒图标
```
