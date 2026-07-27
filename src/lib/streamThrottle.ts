export interface StreamThrottleOptions<T> {
  commit: (value: T) => void;
  schedule: (callback: () => void, delay: number) => number;
  cancel: (id: number) => void;
  delayForNextCommit: () => number;
}

/**
 * 把模型的高频 token 合并成低频 UI 提交。
 *
 * 上游网关可能一秒送来数百个很小的增量；每个 token 都重建整张 Card、重新解析
 * Markdown、重新布局关系图，会直接把 WebView 主线程拖住。这个节流器始终保留最新
 * 的完整正文，前台按较短间隔刷新，后台按较长间隔刷新，结束/停止时再强制 flush。
 */
export function createStreamThrottle<T>(options: StreamThrottleOptions<T>) {
  let latest: T | undefined;
  let committed: T | undefined;
  let timer: number | null = null;

  const flush = () => {
    if (timer !== null) {
      options.cancel(timer);
      timer = null;
    }
    if (latest === undefined || Object.is(latest, committed)) return;
    committed = latest;
    options.commit(latest);
  };

  const push = (value: T) => {
    latest = value;
    if (timer !== null) return;
    timer = options.schedule(() => {
      timer = null;
      if (latest === undefined || Object.is(latest, committed)) return;
      committed = latest;
      options.commit(latest);
    }, options.delayForNextCommit());
  };

  const dispose = () => {
    if (timer !== null) options.cancel(timer);
    timer = null;
  };

  return { push, flush, dispose };
}
