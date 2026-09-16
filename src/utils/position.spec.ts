import { describe, expect, it } from 'vitest';
import { positionProfit, formatProfit } from './position';
import { tickerPage, tickerRows } from './ticker';

describe('持仓盈亏', () => {
  it('计算持仓总盈亏，不使用当日涨跌额', () => {
    expect(positionProfit(12.34, 10, 200)).toBe(468);
    expect(positionProfit(8.12, 10, 300)).toBe(-564);
    expect(positionProfit(10, 10, 100)).toBe(0);
    expect(positionProfit(10, 0, 100)).toBe(1000);
    expect(positionProfit(10, 12, 0)).toBe(0);
  });
  it('缺失成本、持仓或有效行情时不制造盈亏', () => {
    expect(positionProfit(10, null, null)).toBeNull();
    expect(positionProfit(undefined, 10, 100)).toBeNull();
    expect(positionProfit(0, 10, 100)).toBeNull();
    expect(positionProfit(NaN, 10, 100)).toBeNull();
  });
  it('金额保留两位，悬浮窗的大额采用万/亿', () => {
    expect(formatProfit(null)).toBe('--');
    expect(formatProfit(468)).toBe('+468.00');
    expect(formatProfit(-564)).toBe('-564.00');
    expect(formatProfit(-0)).toBe('0.00');
    expect(formatProfit(123456, true)).toBe('+12.35万');
    expect(formatProfit(-123456789, true)).toBe('-1.23亿');
    expect(formatProfit(9999.999, true)).toBe('+1.00万');
    expect(formatProfit(99999999.9, true)).toBe('+1.00亿');
    expect(formatProfit(1e12, true)).toBe('+1.00万亿');
    expect(formatProfit(1e21, true)).toBe('+1.00e+21');
    expect(formatProfit(1e21)).toBe('+1000000000000000000000.00');
  });
});

describe('悬浮窗行数及翻页', () => {
  it('保持原有 38px 两行高度，每 15px 增加一行', () => {
    expect(tickerRows(0)).toBe(2);
    expect(tickerRows(38)).toBe(2);
    expect(tickerRows(53)).toBe(3);
    expect(tickerRows(68)).toBe(4);
  });
  it('不足一屏不重复，最后一屏循环补齐', () => {
    expect(tickerPage([], 0, 3)).toEqual([]);
    expect(tickerPage(['a'], 0, 3)).toEqual(['a']);
    expect(tickerPage(['a', 'b', 'c', 'd', 'e'], 3, 3)).toEqual(['d', 'e', 'a']);
    expect(tickerPage(['a', 'b', 'c'], 0, 4)).toEqual(['a', 'b', 'c']);
  });
});
