# 自选股「行情条播报」开关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在自选列表末尾新增「行情条播报」开关列，控制单个标的是否参与行情条滚动播报；新增自选与历史自选均默认开启。

**Architecture:** `watchlist` 表新增 `ticker_enabled INTEGER NOT NULL DEFAULT 1` 列，配置随行存储。迁移在 `Database::open()` 中幂等执行（`PRAGMA table_info` 探测 + `ALTER TABLE`），覆盖全新安装与老库升级两条路径。前端行情条在 `computed` 中按该字段过滤，开关写入后复用已有的 `watchlist-changed` 事件让行情条实时刷新。

**Tech Stack:** Tauri 2 / Rust（rusqlite bundled）、Vue 3 + Pinia + naive-ui、vue-tsc 类型检查、cargo test。

## Global Constraints

- 不引入新依赖（`tempfile` 也不加，测试用 `std::env::temp_dir()` 自建临时目录）。
- 不新增 Tauri 事件，复用已有 `watchlist-changed`。
- 每次提交的前置校验：`cargo test --manifest-path src-tauri/Cargo.toml` 与 `npx vue-tsc --noEmit` 均须通过。
- 不改动 `get_watch_codes()`——Scheduler 消费它，禁播标的仍须照常轮询。
- 不改动 `ticker_visible` setting（那是行情条窗口整体显隐，与按标的开关正交）。
- 不改动 `addStock()` / `AddStockDialog` 签名——默认开启由数据库列默认值与 `add_watch()` 的显式写入保证。
- Rust 注释与 UI 文案用中文，与现有风格一致。
- 提交粒度：每个任务一个提交，messages 用 `feat:` / `chore:` 前缀。

---

## File Structure

| 文件 | 责任 | 改动类型 |
|------|------|---------|
| `src-tauri/src/db/mod.rs` | `watchlist` 表加 `ticker_enabled` 列；新增幂等迁移 `migrate_ticker_enabled()`；`WatchItem` 加字段；`get_watchlist()`/`add_watch()` 带上该列；新增 `set_watch_ticker_enabled()`；新增 `mod tests` | 修改 |
| `src-tauri/src/commands/watchlist.rs` | 新增 IPC 命令 `set_watch_ticker_enabled` | 修改 |
| `src-tauri/src/lib.rs` | `invoke_handler` 注册新命令 | 修改 |
| `src/types/index.ts` | `WatchItem` 加 `ticker_enabled: boolean` | 修改 |
| `src/stores/watchlist.ts` | 新增 action `setTickerEnabled(id, enabled)`，乐观更新 + 失败回滚 | 修改 |
| `src/components/watchlist/WatchlistTable.vue` | 末尾追加「行情条播报」列，`NSwitch` 渲染 | 修改 |
| `src/components/ticker/TickerBar.vue` | `tickerItems` 按 `ticker_enabled` 过滤；按长度变化重置 `page` | 修改 |

---

### Task 1: 数据库列与幂等迁移

**Files:**
- Modify: `src-tauri/src/db/mod.rs`（`open()` 约 L18-21、`migrate()` 约 L24-49、`get_watchlist()` 约 L118-135、`add_watch()` 约 L137-156、文件末尾 `WatchItem` 约 L361-369、新增 `mod tests`）
- Test: `src-tauri/src/db/mod.rs`（`mod tests`）

**Interfaces:**
- Consumes: 无
- Produces:
  - `WatchItem` 新增字段 `pub ticker_enabled: bool`
  - `Database::open(PathBuf) -> SqliteResult<Database>` 行为变更：额外执行幂等迁移
  - `Database::get_watchlist() -> SqliteResult<Vec<WatchItem>>` 返回的 `WatchItem` 带 `ticker_enabled`
  - `Database::add_watch(&self, code: &str, market: &str, name: &str) -> SqliteResult<()>` 行为变更：新行 `ticker_enabled = 1`

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/db/mod.rs` 文件末尾（`WatchItem` 结构体定义之后）追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// 每个测试用独立的临时 app 目录，避免共享数据库文件互相干扰。
    /// 不加 `tempfile` 依赖，用进程 id + 纳秒 + 自增序号保证唯一。
    fn temp_app_dir(tag: &str) -> PathBuf {
        let seq = SEQ.fetch_add(1, Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "qd-test-{}-{}-{}-{}",
            tag,
            std::process::id(),
            nanos,
            seq
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 写入一份旧版本 schema 的数据库（watchlist 无 ticker_enabled 列），
    /// 用于模拟「用户从旧版本升级上来」的路径。
    fn seed_legacy_db(dir: &PathBuf) {
        let conn = Connection::open(dir.join("quant-desktop.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE watchlist (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                code        TEXT NOT NULL,
                market      TEXT NOT NULL DEFAULT 'CN',
                name        TEXT NOT NULL,
                sort_order  INTEGER DEFAULT 0,
                added_at    TEXT NOT NULL,
                UNIQUE(code, market)
            );
            INSERT INTO watchlist (code, market, name, sort_order, added_at)
            VALUES ('sh600519', 'CN', '贵州茅台', 0, '2026-01-01T00:00:00');",
        )
        .unwrap();
    }

    #[test]
    fn fresh_db_add_watch_defaults_ticker_enabled() {
        let dir = temp_app_dir("fresh");
        let db = Database::open(dir.clone()).unwrap();
        db.add_watch("sh600519", "CN", "贵州茅台").unwrap();

        let items = db.get_watchlist().unwrap();
        assert_eq!(items.len(), 1);
        assert!(
            items[0].ticker_enabled,
            "全新安装下新增自选应默认开启行情条播报"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_db_migrates_and_defaults_enabled() {
        let dir = temp_app_dir("legacy");
        seed_legacy_db(&dir);

        let db = Database::open(dir.clone()).unwrap();
        let items = db.get_watchlist().unwrap();
        assert_eq!(items.len(), 1, "迁移不应丢失历史自选");
        assert_eq!(items[0].name, "贵州茅台");
        assert_eq!(items[0].code, "sh600519");
        assert!(
            items[0].ticker_enabled,
            "历史自选迁移后应默认开启行情条播报"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ticker_enabled_migration_is_idempotent() {
        let dir = temp_app_dir("idem");
        seed_legacy_db(&dir);

        // 第一次打开触发 ALTER TABLE
        {
            let _db = Database::open(dir.clone()).unwrap();
        }
        // 第二次打开列已存在，不应因 "duplicate column name" 报错
        let db = Database::open(dir.clone()).unwrap();
        db.add_watch("sz000001", "CN", "平安银行").unwrap();

        let items = db.get_watchlist().unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|i| i.ticker_enabled));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_ticker_enabled_persists_across_reopen() {
        let dir = temp_app_dir("set");
        let id = {
            let db = Database::open(dir.clone()).unwrap();
            db.add_watch("sh600519", "CN", "贵州茅台").unwrap();
            let id = db.get_watchlist().unwrap()[0].id;
            db.set_watch_ticker_enabled(id, false).unwrap();
            assert!(!db.get_watchlist().unwrap()[0].ticker_enabled);
            id
        };

        // 重开确认已落盘
        let db = Database::open(dir.clone()).unwrap();
        let items = db.get_watchlist().unwrap();
        assert_eq!(items[0].id, id);
        assert!(
            !items[0].ticker_enabled,
            "关闭状态应持久化，不应被迁移重置为开启"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml db::tests`
Expected: 编译失败 —— `no field 'ticker_enabled' on type 'WatchItem'`、`no method named 'set_watch_ticker_enabled'`。

- [ ] **Step 3: 建表语句加列**

在 `src-tauri/src/db/mod.rs` 的 `migrate()` 中，把 `watchlist` 建表语句改为（新增 `ticker_enabled` 一行）：

```rust
            "CREATE TABLE IF NOT EXISTS watchlist (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                code        TEXT NOT NULL,
                market      TEXT NOT NULL DEFAULT 'CN',
                name        TEXT NOT NULL,
                sort_order  INTEGER DEFAULT 0,
                added_at    TEXT NOT NULL,
                ticker_enabled INTEGER NOT NULL DEFAULT 1,
                UNIQUE(code, market)
            );
```

- [ ] **Step 4: 新增幂等迁移函数并在 `open()` 中调用**

在 `open()` 中把调用链改为：

```rust
        let db = Self { conn: Mutex::new(conn) };
        db.migrate()?;
        db.migrate_watchlist_codes()?;
        db.migrate_ticker_enabled()?;
        db.init_defaults()?;
        Ok(db)
```

并在 `migrate_watchlist_codes()` 之后新增该函数：

```rust
    /// 幂等迁移：为历史库补上 `ticker_enabled` 列。
    ///
    /// `CREATE TABLE IF NOT EXISTS` 对已存在的表不会加列，所以老库需要单独
    /// `ALTER TABLE`。SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，重复执行会报
    /// "duplicate column name: ticker_enabled"，因此先用 PRAGMA 探测。
    ///
    /// 两点依赖的 SQLite 语义：
    /// - `ADD COLUMN` 是纯元数据操作，不重写表、不复制数据，任意规模均是 O(1)；
    ///   已有行读出时返回默认值，故历史自选全部默认开启。
    /// - `NOT NULL` 在 `ADD COLUMN` 上合法，前提是带非 NULL 默认值。
    fn migrate_ticker_enabled(&self) -> SqliteResult<()> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn.prepare("PRAGMA table_info(watchlist)")?;
        let exists = stmt
            .query_map([], |row| row.get::<_, String>(1))?
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

- [ ] **Step 5: 读路径带上新列**

`get_watchlist()` 整体替换为：

```rust
    pub fn get_watchlist(&self) -> SqliteResult<Vec<WatchItem>> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn.prepare(
            "SELECT id, code, market, name, sort_order, added_at, ticker_enabled
             FROM watchlist ORDER BY sort_order ASC, id ASC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(WatchItem {
                id: row.get(0)?,
                code: row.get(1)?,
                market: row.get(2)?,
                name: row.get(3)?,
                sort_order: row.get(4)?,
                added_at: row.get(5)?,
                ticker_enabled: row.get(6)?,
            })
        })?;
        rows.collect()
    }
```

- [ ] **Step 6: 写路径显式开启**

`add_watch()` 的 INSERT 改为：

```rust
        conn.execute(
            "INSERT OR IGNORE INTO watchlist (code, market, name, sort_order, added_at, ticker_enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)",
            params![code, market, name, max_sort + 1, now],
        )?;
```

显式写 `1` 而非依赖列默认值——语义明确，且未来默认值变更时此处意图不受影响。

- [ ] **Step 7: `WatchItem` 加字段**

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct WatchItem {
    pub id: i64,
    pub code: String,
    pub market: String,
    pub name: String,
    pub sort_order: i32,
    pub added_at: String,
    /// 是否参与行情条（ticker 窗口）滚动播报。新行默认 true。
    pub ticker_enabled: bool,
}
```

rusqlite 直接把 SQLite 的 `INTEGER` 映射为 `bool`，无需手动转换。

- [ ] **Step 8: 新增 setter**

在 `remove_watch()` 之后新增：

```rust
    pub fn set_watch_ticker_enabled(&self, id: i64, enabled: bool) -> SqliteResult<()> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "UPDATE watchlist SET ticker_enabled = ?1 WHERE id = ?2",
            params![enabled, id],
        )?;
        Ok(())
    }
```

- [ ] **Step 9: 运行测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml db::tests`
Expected: PASS，4 个测试全绿（`fresh_db_add_watch_defaults_ticker_enabled`、`legacy_db_migrates_and_defaults_enabled`、`ticker_enabled_migration_is_idempotent`、`set_ticker_enabled_persists_across_reopen`）。

- [ ] **Step 10: 提交**

```bash
git add src-tauri/src/db/mod.rs
git commit -m "feat: watchlist 表新增 ticker_enabled 列及幂等迁移"
```

---

### Task 2: IPC 命令 set_watch_ticker_enabled

**Files:**
- Modify: `src-tauri/src/commands/watchlist.rs`（`remove_watch()` 后，约 L36 之后）
- Modify: `src-tauri/src/lib.rs:618`（`invoke_handler` 列表）

**Interfaces:**
- Consumes: `Database::set_watch_ticker_enabled(id: i64, enabled: bool) -> SqliteResult<()>`（Task 1）
- Produces: Tauri 命令 `set_watch_ticker_enabled`，前端调用形式 `invoke('set_watch_ticker_enabled', { id, enabled })`，参数名 `id: number` / `enabled: boolean`，无返回值

- [ ] **Step 1: 新增命令**

在 `src-tauri/src/commands/watchlist.rs` 的 `remove_watch()` 之后新增：

```rust
#[tauri::command]
pub fn set_watch_ticker_enabled(
    app_handle: tauri::AppHandle,
    db: State<'_, Arc<Database>>,
    id: i64,
    enabled: bool,
) -> Result<(), String> {
    db.set_watch_ticker_enabled(id, enabled)
        .map_err(|e| e.to_string())?;
    // 复用已有的 watchlist-changed 事件：行情条窗口正是靠它刷新列表，
    // 因此开关一拨即在行情条生效，无需新增事件。
    let _ = app_handle.emit("watchlist-changed", ());
    Ok(())
}
```

- [ ] **Step 2: 注册命令**

在 `src-tauri/src/lib.rs` 的 `invoke_handler` 列表中，`commands::watchlist::remove_watch,` 之后插入一行：

```rust
            commands::watchlist::set_watch_ticker_enabled,
```

- [ ] **Step 3: 编译并跑全部测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 编译通过，全部测试 PASS。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/commands/watchlist.rs src-tauri/src/lib.rs
git commit -m "feat: 新增 set_watch_ticker_enabled IPC 命令"
```

---

### Task 3: 前端类型与 store action

**Files:**
- Modify: `src/types/index.ts:35-42`
- Modify: `src/stores/watchlist.ts`

**Interfaces:**
- Consumes: IPC 命令 `set_watch_ticker_enabled`（Task 2）
- Produces:
  - `WatchItem.ticker_enabled: boolean`
  - `useWatchlistStore().setTickerEnabled(id: number, enabled: boolean): Promise<void>`

- [ ] **Step 1: 类型加字段**

`src/types/index.ts` 的 `WatchItem` 改为：

```ts
export interface WatchItem {
  id: number;
  code: string;
  market: string;
  name: string;
  sort_order: number;
  added_at: string;
  /** 是否参与行情条滚动播报。新增自选默认 true。 */
  ticker_enabled: boolean;
}
```

- [ ] **Step 2: store 新增 action**

在 `src/stores/watchlist.ts` 的 `removeStock()` 之后新增，并把 `setTickerEnabled` 加入 return：

```ts
  /**
   * 切换某个自选的行情条播报开关。
   *
   * 乐观更新：先改本地再发 IPC，避免拨动开关时有可见延迟；失败回滚。
   * 不复用 `error` 字段 —— 该字段会让整张自选表被错误态替换
   * （WatchlistTable 的 `v-if="watchlist.error"`），单次开关失败不值得
   * 清空表格，因此只回滚 + 记日志。
   *
   * 按 id 查找而不是接收行对象引用，避免依赖 naive-ui 是否原样透传
   * data 中的响应式代理。
   */
  async function setTickerEnabled(id: number, enabled: boolean) {
    const item = items.value.find((i) => i.id === id);
    if (!item) return;
    const prev = item.ticker_enabled;
    item.ticker_enabled = enabled;
    try {
      await invoke('set_watch_ticker_enabled', { id, enabled });
    } catch (e) {
      item.ticker_enabled = prev;
      console.error('[watchlist] setTickerEnabled failed:', e);
    }
  }
```

return 语句改为：

```ts
  return { items, loading, error, fetchWatchlist, addStock, removeStock, setTickerEnabled };
```

- [ ] **Step 3: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add src/types/index.ts src/stores/watchlist.ts
git commit -m "feat: WatchItem 增加 ticker_enabled 类型与 store action"
```

---

### Task 4: 自选列表「行情条播报」开关列

**Files:**
- Modify: `src/components/watchlist/WatchlistTable.vue`（import 约 L2、`columns` 数组末尾约 L233、`<style scoped>` 末尾）

**Interfaces:**
- Consumes: `WatchItem.ticker_enabled`、`watchlist.setTickerEnabled(id, enabled)`（Task 3）
- Produces: 无（叶子改动）

- [ ] **Step 1: 引入 NSwitch**

`src/components/watchlist/WatchlistTable.vue` 第 2 行改为：

```ts
import { NButton, NDataTable, NDropdown, NSwitch } from 'naive-ui';
```

- [ ] **Step 2: 追加列定义**

在 `columns` 数组末尾（`换手率` 列对象的 `},` 之后、数组闭合 `];` 之前）追加：

```ts
  {
    title: '行情条播报', key: 'ticker_enabled', width: 96,
    render(row) {
      // 包一层 div 并阻止冒泡：表格行的 onClick 会展开/收起详情面板，
      // 不拦截的话拨开关会连带触发。
      return h(
        'div',
        {
          class: 'ticker-toggle-cell',
          onClick: (e: MouseEvent) => e.stopPropagation(),
        },
        [
          h(NSwitch, {
            value: row.ticker_enabled,
            size: 'small',
            'aria-label': `${row.name} 行情条播报`,
            'onUpdate:value': (v: boolean) => {
              // store 内部已 try/catch 并回滚，不会 reject，这里无需再兜错。
              void watchlist.setTickerEnabled(row.id, v);
            },
          }),
        ],
      );
    }
  },
```

- [ ] **Step 3: 加单元格样式**

在 `<style scoped>` 末尾追加（列内容由 NDataTable 挂载，scoped 样式须用 `:deep()`）：

```css
:deep(.ticker-toggle-cell) {
  display: flex;
  align-items: center;
  height: 100%;
}
```

- [ ] **Step 4: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/components/watchlist/WatchlistTable.vue
git commit -m "feat: 自选列表新增行情条播报开关列"
```

---

### Task 5: 行情条按开关过滤

**Files:**
- Modify: `src/components/ticker/TickerBar.vue`（import 约 L2、`tickerItems` computed 约 L90-100）

**Interfaces:**
- Consumes: `WatchItem.ticker_enabled`（Task 3）
- Produces: 无（叶子改动）

- [ ] **Step 1: 引入 watch**

`src/components/ticker/TickerBar.vue` 第 2 行改为：

```ts
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
```

- [ ] **Step 2: tickerItems 过滤**

把 `tickerItems` 的 `computed` 替换为：

```ts
const tickerItems = computed(() =>
  watchlist.items
    .filter((item) => item.ticker_enabled)
    .map((item) => {
      const q = quoteStore.getQuote(item.code, item.market);
      return {
        name: item.name,
        code: item.code,
        price: q?.price ?? null,
        changePct: q?.change_pct ?? null,
      };
    })
);
```

- [ ] **Step 3: 数量变化时归零 page**

紧接其后新增：

```ts
// 可见集合变化时回到第一屏，避免列表变短后观众从半截开始看。
//
// 必须监听 length 而不是 tickerItems 本身：tickerItems 依赖 quote store，
// 行情每次轮询都会重算，直接监听它会每 2 秒重置一次 page，翻页将永远
// 停在第一屏。
watch(
  () => tickerItems.value.length,
  () => {
    page.value = 0;
  }
);
```

- [ ] **Step 4: 检查空态分支**

确认 [TickerBar.vue:230](../../src/components/ticker/TickerBar.vue#L230) 已有的 `<div v-else class="ticker-empty">暂无自选</div>` 无需改动——全部关闭时 `visibleItems` 为空数组，自然落入该分支。此步无需改代码，仅确认。

- [ ] **Step 5: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/components/ticker/TickerBar.vue
git commit -m "feat: 行情条按 ticker_enabled 过滤播报标的"
```

---

### Task 6: 端到端验证（含老库升级路径）

**Files:** 无代码改动

**Interfaces:**
- Consumes: Task 1-5 的全部产出
- Produces: 验证结论

- [ ] **Step 1: 备份现有数据库（在启动 dev 之前）**

必须在启动前备份，否则迁移已经跑完，就无法真正验证老库升级路径了。

**路径不是由 Tauri identifier 推导的。** `src-tauri/src/lib.rs:110-126` 用的是 `dirs::data_dir().join("quant-desktop")`，所以真机路径是 `%APPDATA%\quant-desktop\quant-desktop.db`——`tauri.conf.json` 里的 `identifier`（`com.leaderxin.quant-desktop`）只影响别处，那个目录根本不存在。若可执行文件旁存在 `portable.dat`，路径改为 `<exe目录>/data/quant-desktop.db`。

```bash
cp "$APPDATA/quant-desktop/quant-desktop.db" \
   "$APPDATA/quant-desktop/quant-desktop.db.bak"
```

最权威的确认方式是启动日志：`src-tauri/src/lib.rs:147` 会打印 `Data directory: <路径> (portable: ...)`。若与你备份的路径不一致，以日志为准重新备份。

若该文件确实不存在（本机从未运行过打包版），才可跳过 Step 2 的老库升级检查——该路径已由 Task 1 的 `legacy_db_migrates_and_defaults_enabled` 单元测试覆盖。**不要因为 identifier 路径不存在就跳过**，那是本步骤最初踩过的坑。

- [ ] **Step 2: 验证老库迁移**

Run: `npm run tauri dev`

从启动日志 (`src-tauri/src/lib.rs:147` 会打印 `Data directory: <路径> (portable: ...)`) 确认路径与 Step 1 备份的一致，且：

- 出现 `Migration: added watchlist.ticker_enabled`（仅当确实是老库时）。
- **没有** `Failed to open database`、没有 `duplicate column name` 之类的报错。
- 主窗口正常显示全部历史自选，数量与备份时一致。

- [ ] **Step 3: 验证新列 UI**

主窗口自选列表最右侧出现「行情条播报」列，每行一个开关。检查：

- 所有历史自选的开关均为**开启**状态。
- 点击某行开关，**不会**连带展开/收起该行的详情面板。
- 点击该行其他位置，详情面板仍正常展开/收起。

- [ ] **Step 4: 验证播报联动**

把行情条窗口拖到可见位置（托盘菜单 → 切换行情条），确认：

- 关闭某只股票的开关后，行情条在 3 秒内不再播报该股票（`watchlist-changed` 事件触发重新拉取）。
- 重新开启后 3 秒内恢复播报。
- 把开关**全部关闭**，行情条显示「暂无自选」。
- 在「全部关闭」状态下让行情条停留 10 秒以上（覆盖 3 次以上翻页周期），确认没有报错、文案稳定不闪烁。

- [ ] **Step 5: 验证新增自选默认开启**

点击「添加自选」，搜索并添加一只新股票，确认新行的开关为**开启**状态，且立即出现在行情条中。

- [ ] **Step 6: 验证持久化**

完全退出应用（托盘菜单 → 退出），重新 `npm run tauri dev`，确认此前关闭的开关仍为关闭状态。

- [ ] **Step 7: 清理备份**

确认无误后删除备份（若 Step 1 未产生备份则跳过）：

```bash
rm -f "$APPDATA/quant-desktop/quant-desktop.db.bak"
```

- [ ] **Step 8: 更新文档**

在 `CLAUDE.md` 的「Frontend (`src/`)」章节中，把 `WatchlistTable.vue (NDataTable: sortable columns, right-click context menu, row-click expands detail)` 一行补充为提及行情条播报开关列；在「Ticker bar」段落补一句「仅播报 `ticker_enabled` 为 true 的标的」。同时在 `docs/superpowers/specs/2026-09-14-ticker-broadcast-toggle-design.md` 顶部的状态行把「已批准，待实现」改为「已实现」。

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-14-ticker-broadcast-toggle-design.md
git commit -m "docs: 补充行情条播报开关说明"
```
