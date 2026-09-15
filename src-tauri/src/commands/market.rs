use tauri::State;
use std::sync::Arc;
use crate::datasource::market::MarketOverviewClient;
use crate::datasource::market_clock::MarketSession;
use crate::domain::MarketOverview;

/// 市场概览的建议轮询间隔(秒),按时段由 `market_clock` 给出。
///
/// 前端用它决定下一次刷新的排期。为什么不全靠 `market-session-changed` 事件:
/// 该事件只在时段**切换**时推送,应用启动时不会补发,所以需要这个命令做初始种子。
#[tauri::command]
pub fn get_overview_interval() -> u64 {
    MarketSession::current().overview_interval()
}

/// 市场概览聚合:总成交额 + 涨跌家数 + 行业/概念板块排名。
///
/// 四块数据来源独立(新浪成交额 + 东财涨跌家数 + 东财行业/概念板块),
/// 任一失败只降级对应字段,面板整体不因单一数据源失败而消失。
#[tauri::command]
pub async fn get_market_overview(
    direction: String,
    client: State<'_, Arc<MarketOverviewClient>>,
) -> Result<MarketOverview, String> {
    // 1. 总成交额 —— 新浪指数接口(上证指数 + 深证综指)
    let turnover = match client.fetch_total_turnover().await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[market] 成交额获取失败,降级为 0: {}", e);
            0.0
        }
    };

    // 2. 涨跌家数 —— 东财 push2ex 涨跌分布
    let (up, down, flat) = match client.fetch_market_breadth().await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[market] 涨跌家数获取失败,降级为 0: {}", e);
            (0, 0, 0)
        }
    };

    // 3. 行业板块 —— 东财 push2delay clist
    let industry = match client.fetch_sector_ranking("m:90+t:2", &direction).await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[market] 行业板块获取失败,降级为空: {}", e);
            Vec::new()
        }
    };

    // 4. 概念板块 —— 东财 push2delay clist,剔除风格/指数/资金/业绩等非主题概念
    let concept = match client.fetch_concept_ranking(&direction).await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[market] 概念板块获取失败,降级为空: {}", e);
            Vec::new()
        }
    };

    Ok(MarketOverview {
        turnover,
        up,
        down,
        flat,
        industry,
        concept,
    })
}
