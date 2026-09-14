# 自选股「行情条播报」开关设计文档

日期：2026-09-14
状态：已批准，待实现

## 目标

在自选列表新增一列「行情条播报」，列内是一个开关。开关开启的标的参与行情条（ticker 窗口）的滚动播报，关闭的则不参与。**添加自选时默认开启**，历史自选同样默认开启。

## 背景与现状

- 自选表 [WatchlistTable.vue](../../../src/components/watchlist/WatchlistTable.vue) 当前 8 列：代码(72) / 名称(168) / 最新价(100) / 涨跌幅(100) / 涨跌额(90) / 成交量(90) / 成交额(90) / 换手率(80)，宽度合计 **790px**。新增 96px 的播报列后为 **886px**。
  - 主窗口默认 1388px、持久化宽度实测 1342px，正常使用下有余量。
  - **已知约束**：主窗口 `resizable: true` 且未设 `minWidth`，`NDataTable` 也未开 `scroll-x`。内容宽度低于约 918px 时最右列（恰是本次新增的列）可能被裁切且无横向滚动。默认窗口宽度下不触发，收窄窗口时需留意。若不接受此行为，可在 `tauri.conf.json` 给主窗口设 `minWidth`（约 960）或给表格开 `scroll-x`。
- 行情条 [TickerBar.vue](../../../src/components/ticker/TickerBar.vue)：独立的 `ticker` webview 窗口，`tickerItems` 直接由 `watchlist.items` 映射而来，每次展示 2 条、每 3 秒翻页，悬停暂停。空列表时显示「暂无自选」。
- 行情条已监听 `watchlist-changed` 事件并在触发时重新拉取自选列表，因此后端任何写操作后发该事件即可让行情条实时生效，**无需新增事件**。
- 已有的 `ticker_visible` setting 控制的是**整个行情条窗口的显隐**（托盘菜单切换），与本次的按标的开关是两个正交的维度。
- 数据库 [db/mod.rs](../../../src-tauri/src/db/mod.rs) 的 `Database::open()` 在每次启动时执行 `migrate()` → `migrate_watchlist_codes()` → `init_defaults()`；`migrate_watchlist_codes()` 已确立了「靠自检保证幂等」的迁移风格。

## 设计

### 1. 数据模型

`watchlist` 表新增一列：

```sql
ticker_enabled INTEGER NOT NULL DEFAULT 1
```

配置跟着行一起走。**不采用**把禁播标的列表塞进 `settings` 表的方案：那会引入第二个数据源，删除自选时需手动清理、排序变更时容易失配，且无法在单条 SQL 中一并查出。本方案只多一次幂等迁移。

### 2. 数据库迁移（幂等，覆盖全新安装与老库升级）

迁移在**每次启动**触发，而非仅首次安装。[lib.rs:151](../../../src-tauri/src/lib.rs#L151) 在 Tauri `.setup()` 中调用 `Database::open(app_dir)`；数据库文件位于 `{app_data_dir}/quant-desktop.db`，自动更新器只替换二进制、不触碰该文件，因此更新后首次启动即在旧库上完成迁移。

调用顺序保证一致性：迁移在 `app.manage(db)`（[lib.rs:181](../../../src-tauri/src/lib.rs#L181)）与 `Scheduler::spawn`（[lib.rs:194](../../src-tauri/src/lib.rs#L194)）之前完成，不存在读到半迁移 schema 的并发窗口。

两处改动，互斥且收敛到同一 schema：

**位置 1 —— `migrate()` 的建表语句**（覆盖全新安装），在 `added_at` 之后加入 `ticker_enabled INTEGER NOT NULL DEFAULT 1`。

**位置 2 —— 新增 `migrate_ticker_enabled()`**（覆盖已有安装），在 [db/mod.rs:19](../../../src-tauri/src/db/mod.rs#L19) 的 `migrate_watchlist_codes()` 之后调用：

```rust
/// 幂等迁移：为历史库补上 ticker_enabled 列。
/// SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，重复执行会返回
/// "duplicate column name: ticker_enabled"，故先用 PRAGMA 探测。
fn migrate_ticker_enabled(&self) -> SqliteResult<()> {
    let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = conn.prepare("PRAGMA table_info(watchlist)")?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?   // 第 1 列是列名
        .collect::<SqliteResult<Vec<_>>>()?
        .iter()
        .any(|name| name == "ticker_enabled");
    drop(stmt);
    if !exists {
        conn.execute(
            "ALTER TABLE watchlist ADD COLUMN ticker_enabled INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
        log::info!("Migration: added watchlist.ticker_enabled");
    }
    Ok(())
}
```

关键 SQLite 语义：

1. **`ADD COLUMN` 是纯元数据操作**，不重写表、不复制数据，任意规模下均为 O(1)，启动无停顿。已有行读出时返回默认值 `1`，因此历史自选全部默认开启。
2. **`NOT NULL` 在 `ADD COLUMN` 上合法，前提是带非 NULL 默认值**，`DEFAULT 1` 写全即不会报错。
3. **降级安全**：用户装新版后退回旧版时，`CREATE TABLE IF NOT EXISTS` 不会删列，旧代码的 SELECT 为显式列清单 + 结构体映射，多出的列被忽略。

长期方案 `PRAGMA user_version` 版本号迁移留待迁移累积到 3~4 个以上时再引入：目前全量现存库的 `user_version` 均为 0，引入需先补一次「基线打标」，反而多一层出错可能。

### 3. 后端改动

| 文件 | 改动 |
|---|---|
| [db/mod.rs](../../../src-tauri/src/db/mod.rs) | 新增 `migrate_ticker_enabled()` 并在 `open()` 中调用；`migrate()` 建表语句加列；`WatchItem` 结构体加 `pub ticker_enabled: bool`（rusqlite 的 `INTEGER` ↔ `bool` 直接映射）；`get_watchlist()` 的 SELECT 列清单与行映射加该列；`add_watch()` 显式写入 `1`；新增 `set_watch_ticker_enabled(&self, id: i64, enabled: bool)` |
| [commands/watchlist.rs](../../../src-tauri/src/commands/watchlist.rs) | 新增 `#[tauri::command] set_watch_ticker_enabled(app_handle, db, id, enabled)`，写库后 `emit("watchlist-changed")` |
| [lib.rs](../../../src-tauri/src/lib.rs) | `invoke_handler` 注册新命令 |

`add_watch()` 显式写入 `1` 而非依赖列默认值：语义更明确，且未来若默认值变更，此处意图不受影响。

`get_watch_codes()`（Scheduler 消费）只取 `code` + `market`，不受影响——**禁播标的仍照常轮询**，因为它在自选表中依然展示行情。

### 4. 前端改动

**类型** —— [types/index.ts](../../../src/types/index.ts) 的 `WatchItem` 加 `ticker_enabled: boolean`。

**自选列表** —— [WatchlistTable.vue](../../../src/components/watchlist/WatchlistTable.vue)：在 `columns` 数组**末尾**追加一列。

- 表头「行情条播报」，宽 96，`render` 返回 naive-ui `NSwitch`（`size="small"`）。
- 开关外层包一个 `div` 并挂 `@click.stop`：表格行的 `onClick` 会展开/收起详情面板，不拦截则拨开关会连带触发。
- **乐观更新**：先改本地 `row.ticker_enabled`，再 `invoke`；失败则回滚该字段并记录日志。不把 `watchlist.error` 置位——该 error 会让整张表被错误态替换（[WatchlistTable.vue:251](../../../src/components/watchlist/WatchlistTable.vue#L251) 的 `v-if`），一次开关失败就清空表格的体验过于突兀。

**行情条** —— [TickerBar.vue](../../../src/components/ticker/TickerBar.vue)：

- `tickerItems` 的 `computed` 中先 `filter(item => item.ticker_enabled)` 再 map。
- 过滤后数量变化时把 `page` 归零，避免列表变短后观众从半截开始看。**必须用 `watch(() => tickerItems.value.length, ...)`，不能 `watch(tickerItems, ...)`**：`tickerItems` 依赖 quote store，行情每次轮询（2s）都会重算，直接监听它会每 2 秒重置一次 `page`，翻页将永远停在第一屏。按长度监听则只在开关真正改变可见集合时触发。
- 全部关闭时自然落入已有的 `暂无自选` 空态分支，无需新文案。

前端无需感知默认值：新增自选的默认开启由数据库列默认值与 `add_watch()` 的显式写入共同保证，[AddStockDialog.vue](../../../src/components/watchlist/AddStockDialog.vue) 与 [stores/watchlist.ts](../../../src/stores/watchlist.ts) 的 `addStock()` 签名均不变。

### 5. 不做的事

- **不因禁播而停止轮询**：标的仍在自选表中展示行情，轮询必须继续。
- **不改 `ticker_visible`**：那是行情条窗口整体的显隐，与按标的开关正交。
- **不加全局「一键全开/全关」**：未提出，不做。

## 影响面

6 个文件，无新增依赖，无新增 Tauri 事件。
