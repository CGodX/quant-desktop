import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { MarketOverview } from '@/types';

/**
 * market store 的刷新调度与竞态测试。
 *
 * 只 mock 掉 Tauri 边界(invoke / listen),pinia 与 store 本体都是真的 ——
 * 要验的正是「在途请求 + 时段轮询 + 方向切换」这三者交错时的排期正确性。
 *
 * 背景:tauri 的 invoke 无法中止(InvokeOptions 只有 headers),所以「取消在途请求」
 * 在本项目里只能做到两件事:过期响应不落地 + 在途结束后立刻补拉。下面的用例锁的就是这两条。
 */

const { invokeMock, sessionListeners } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  sessionListeners: [] as Array<(event: { payload: unknown }) => void>,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
    if (event === 'market-session-changed') sessionListeners.push(handler);
    return () => {
      const i = sessionListeners.indexOf(handler);
      if (i >= 0) sessionListeners.splice(i, 1);
    };
  },
}));

import { useMarketStore } from './market';

const OVERVIEW_CMD = 'get_market_overview';
const INTERVAL_CMD = 'get_overview_interval';

/** 用 turnover 当身份标记 —— 构造类型完全合法的概览响应,便于断言「哪一份数据落地了」。 */
function mkOverview(marker: number): MarketOverview {
  return { turnover: marker, up: 0, down: 0, flat: 0, industry: [], concept: [] };
}

const UP_DATA = 1_001;
const DOWN_DATA = 1_002;
const STALE = 1_003;
const OK = 1_004;

/** 每个概览请求一个独立 deferred,便于按序精确控制「谁先返回」。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 跑完当前所有微任务(store 里 await 链较长)。 */
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function emitSession(payload: unknown) {
  sessionListeners.slice().forEach((h) => h({ payload }));
}

type Req = { direction: string; d: ReturnType<typeof deferred<MarketOverview>> };

/** 把每个概览请求都变成可控 deferred,并记录其方向。 */
function controllable() {
  const reqs: Req[] = [];
  const handler = (args: { direction: string }) => {
    const d = deferred<MarketOverview>();
    reqs.push({ direction: args.direction, d });
    return d.promise;
  };
  return { reqs, handler };
}

describe('market store 刷新调度', () => {
  let overviewHandler: (args: { direction: string }) => Promise<MarketOverview>;

  beforeEach(() => {
    setActivePinia(createPinia());
    sessionListeners.length = 0;
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string, args: { direction: string }) => {
      if (cmd === INTERVAL_CMD) return Promise.resolve(60);
      if (cmd === OVERVIEW_CMD) return overviewHandler(args);
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('切换方向时丢弃在途的旧响应,并立刻补拉新方向', async () => {
    const { reqs, handler } = controllable();
    overviewHandler = handler;

    const store = useMarketStore();
    // startRefresh 会 await 首次拉取,而这里首次请求是故意挂起的
    void store.startRefresh();
    await flush();
    expect(reqs.map((r) => r.direction)).toEqual(['up']);

    // 在途期间切到跌幅榜:不应并发再发一个请求
    store.setDirection('down');
    await flush();
    expect(reqs).toHaveLength(1);

    // 旧方向的响应回来 —— 必须被丢弃
    reqs[0].d.resolve(mkOverview(UP_DATA));
    await flush();
    expect(store.overview?.turnover).not.toBe(UP_DATA);
    // 且在途一结束就补拉了新方向,而不是等下一个轮询周期
    expect(reqs.map((r) => r.direction)).toEqual(['up', 'down']);

    reqs[1].d.resolve(mkOverview(DOWN_DATA));
    await flush();
    expect(store.overview?.turnover).toBe(DOWN_DATA);
  });

  it('方向切走又切回时,匹配当前方向的在途响应应当落地', async () => {
    const { reqs, handler } = controllable();
    overviewHandler = handler;

    const store = useMarketStore();
    void store.startRefresh();
    await flush();

    store.setDirection('down');
    store.setDirection('up'); // 又切回来
    reqs[0].d.resolve(mkOverview(UP_DATA));
    await flush();

    // 请求方向 up === 当前方向 up,这份数据是有效的,不该丢
    expect(store.overview?.turnover).toBe(UP_DATA);
  });

  it('连续切换不会并发爆发,且只补拉一次、用最终方向', async () => {
    const { reqs, handler } = controllable();
    overviewHandler = handler;

    const store = useMarketStore();
    void store.startRefresh();
    await flush();
    expect(reqs).toHaveLength(1); // 在途的是 up

    store.setDirection('down');
    store.setDirection('up');
    store.setDirection('down');
    await flush();
    expect(reqs).toHaveLength(1); // 全程只有一个在途

    reqs[0].d.resolve(mkOverview(STALE));
    await flush();
    expect(reqs).toHaveLength(2); // 只补拉一次
    expect(reqs[1].direction).toBe('down'); // 用最终方向
    expect(store.overview?.turnover).not.toBe(STALE);
  });

  it('按后端下发的时段间隔排期,且任意时刻只有一个定时器', async () => {
    overviewHandler = () => Promise.resolve(mkOverview(OK));
    const store = useMarketStore();

    await store.startRefresh();
    await flush();

    expect(vi.getTimerCount()).toBe(1);
    const count = () => invokeMock.mock.calls.filter(([c]) => c === OVERVIEW_CMD).length;
    const atStart = count();

    // 盘中 60s:不到点不拉
    await vi.advanceTimersByTimeAsync(59_999);
    expect(count()).toBe(atStart);

    // 满 60s 拉一次,且仍然只有一个定时器(无重复排期)
    await vi.advanceTimersByTimeAsync(1);
    expect(count()).toBe(atStart + 1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('时段切换事件:立即刷新一次并改用新间隔', async () => {
    overviewHandler = () => Promise.resolve(mkOverview(OK));
    const store = useMarketStore();
    await store.startRefresh();
    await flush();
    const count = () => invokeMock.mock.calls.filter(([c]) => c === OVERVIEW_CMD).length;
    const before = count();

    // 收盘 → 概览退避到 300s
    emitSession({ session: '休市', overview_interval_secs: 300 });
    await flush();
    expect(count()).toBe(before + 1);
    expect(vi.getTimerCount()).toBe(1);

    // 新间隔生效:299s 不拉,300s 才拉
    await vi.advanceTimersByTimeAsync(299_999);
    expect(count()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(count()).toBe(before + 2);
  });

  it('请求失败时记录错误,后续成功则清除', async () => {
    const d = deferred<MarketOverview>();
    overviewHandler = () => d.promise;
    const store = useMarketStore();
    void store.startRefresh();
    await flush();

    d.reject(new Error('boom'));
    await flush();
    expect(store.error).toContain('市场概览加载失败');

    // 下一轮成功应清掉错误,避免错误提示永久挂着
    overviewHandler = () => Promise.resolve(mkOverview(OK));
    store.setDirection('down');
    await flush();
    expect(store.error).toBeNull();
    expect(store.overview?.turnover).toBe(OK);
  });

  it('stopRefresh 之后定时器清空,事件也不再触发请求', async () => {
    overviewHandler = () => Promise.resolve(mkOverview(OK));
    const store = useMarketStore();
    await store.startRefresh();
    await flush();

    store.stopRefresh();
    expect(vi.getTimerCount()).toBe(0);

    const count = () => invokeMock.mock.calls.filter(([c]) => c === OVERVIEW_CMD).length;
    const before = count();
    emitSession({ overview_interval_secs: 60 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(count()).toBe(before);
  });
});
