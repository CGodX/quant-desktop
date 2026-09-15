use chrono::{Utc, FixedOffset, Datelike, NaiveTime, Weekday};

/// A-share market trading session
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MarketSession {
    /// Before 9:30 AM — pre-market
    PreOpen,
    /// 9:30–11:30 AM — morning trading
    MorningTrade,
    /// 11:30 AM–1:00 PM — lunch break
    LunchBreak,
    /// 1:00–3:00 PM — afternoon trading
    AfternoonTrade,
    /// After 3:00 PM or weekend/holiday — closed
    Closed,
}

impl MarketSession {
    /// Determine the current A-share market session (China Standard Time / UTC+8).
    /// Uses a fixed UTC+8 offset instead of the system local timezone so that
    /// session detection is correct regardless of where the user is located.
    pub fn current() -> Self {
        let cst_offset = FixedOffset::east_opt(8 * 3600).expect("UTC+8 is a valid offset");
        let now = Utc::now().with_timezone(&cst_offset);

        // Check weekend
        match now.weekday() {
            Weekday::Sat | Weekday::Sun => return Self::Closed,
            _ => {}
        }

        let time = now.time();

        let morning_start = NaiveTime::from_hms_opt(9, 30, 0).expect("valid time constant");
        let morning_end = NaiveTime::from_hms_opt(11, 30, 0).expect("valid time constant");
        let afternoon_start = NaiveTime::from_hms_opt(13, 0, 0).expect("valid time constant");
        let afternoon_end = NaiveTime::from_hms_opt(15, 0, 0).expect("valid time constant");

        if time < morning_start {
            Self::PreOpen
        } else if time < morning_end {
            Self::MorningTrade
        } else if time < afternoon_start {
            Self::LunchBreak
        } else if time < afternoon_end {
            Self::AfternoonTrade
        } else {
            Self::Closed
        }
    }

    /// Recommended polling interval in seconds for this session
    pub fn recommended_interval(&self) -> u64 {
        match self {
            Self::MorningTrade | Self::AfternoonTrade => 2,
            Self::PreOpen => 5,
            Self::LunchBreak => 10,
            Self::Closed => 30,
        }
    }

    /// 市场概览(成交额 + 涨跌家数 + 板块榜)的建议轮询间隔(秒)。
    ///
    /// 与 `recommended_interval`(个股报价)刻意分开:概览是聚合摘要,不需要 2s 那种
    /// 粒度,且它打的是东财 clist / 涨跌分布接口,有频控。盘中维持 60s 不变;休市
    /// 这几块数据完全不动,退避到 5 分钟,避免夜间和周末整夜空转。
    pub fn overview_interval(&self) -> u64 {
        match self {
            Self::MorningTrade | Self::AfternoonTrade => 60,
            Self::PreOpen => 60,
            Self::LunchBreak => 120,
            Self::Closed => 300,
        }
    }

    /// Human-readable session name
    pub fn name(&self) -> &str {
        match self {
            Self::PreOpen => "盘前",
            Self::MorningTrade => "早盘",
            Self::LunchBreak => "午休",
            Self::AfternoonTrade => "午盘",
            Self::Closed => "休市",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overview_interval_backs_off_outside_trading() {
        assert_eq!(MarketSession::MorningTrade.overview_interval(), 60);
        assert_eq!(MarketSession::AfternoonTrade.overview_interval(), 60);
        assert_eq!(MarketSession::PreOpen.overview_interval(), 60);
        assert_eq!(MarketSession::LunchBreak.overview_interval(), 120);
        assert_eq!(MarketSession::Closed.overview_interval(), 300);
    }

    /// 概览间隔必须比同期的个股报价间隔慢 —— 它是聚合摘要,且打的接口有频控。
    #[test]
    fn overview_interval_is_slower_than_quote_interval() {
        for s in [
            MarketSession::PreOpen,
            MarketSession::MorningTrade,
            MarketSession::LunchBreak,
            MarketSession::AfternoonTrade,
            MarketSession::Closed,
        ] {
            assert!(
                s.overview_interval() > s.recommended_interval(),
                "{:?}: overview {} 应慢于 quote {}",
                s,
                s.overview_interval(),
                s.recommended_interval()
            );
        }
    }
}
