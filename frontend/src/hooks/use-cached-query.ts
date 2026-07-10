import { useCallback, useEffect, useRef, useState } from 'react';

import { getCached, setCached } from '@/lib/db';

/**
 * T57 统一的 SQLite 缓存优先加载（stale-while-revalidate）：
 *
 * 1. key 就绪/变化 → 先读 SQLite：命中立即渲染（loading=false，不转圈）；
 *    未命中保持 loading（骨架/spinner），避免上一个 key 的数据顶着新 key 的标签渲染。
 * 2. 随后后台请求 API → 写缓存 → 静默更新 UI。
 * 3. 请求失败：有数据可展示则用户无感知；无数据才置 error。
 *
 * key=null 表示未就绪（如 token 还没恢复），不发起任何加载。
 * - refetch()：静默后台刷新（Tab 激活时调用），同 key 并发去重。
 * - refresh()：下拉刷新，带 refreshing 态。
 * - mutate(next, persist?)：本地直写数据（如 PUT 成功回填）；persist=false 只更内存不落缓存
 *   （乐观更新场景，服务端未确认的值不进缓存）。
 */
export function useCachedQuery<T>(key: string | null, fetcher: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  // fetcher 每次渲染都是新函数，走 ref 避免它触发重加载
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  // key 切换后，旧 key 的迟到响应直接丢弃（竞态防护）
  const keyRef = useRef(key);
  keyRef.current = key;
  const inflightRef = useRef<string | null>(null);

  const fetchAndCache = useCallback(async (k: string) => {
    if (inflightRef.current === k) return; // 同 key 并发去重（挂载 + Tab 激活双触发）
    inflightRef.current = k;
    try {
      const fresh = await fetcherRef.current();
      if (keyRef.current !== k) return;
      await setCached(k, fresh);
      setData(fresh);
      setError(false);
    } catch {
      if (keyRef.current === k) setError(true);
    } finally {
      if (inflightRef.current === k) inflightRef.current = null;
      if (keyRef.current === k) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    setError(false);
    setLoading(true);
    void (async () => {
      const cached = await getCached<T>(key);
      if (cancelled || keyRef.current !== key) return;
      if (cached != null) {
        setData(cached);
        setLoading(false);
      } else {
        setData(null); // 新 key 无缓存：清掉旧 key 数据，loading 兜底渲染
      }
      void fetchAndCache(key);
    })();
    return () => { cancelled = true; };
  }, [key, fetchAndCache]);

  const refetch = useCallback(() => {
    if (keyRef.current) void fetchAndCache(keyRef.current);
  }, [fetchAndCache]);

  const refresh = useCallback(() => {
    if (!keyRef.current) return;
    setRefreshing(true);
    void fetchAndCache(keyRef.current);
  }, [fetchAndCache]);

  const mutate = useCallback((next: T, persist = true) => {
    setData(next);
    if (persist && keyRef.current) void setCached(keyRef.current, next);
  }, []);

  return { data, loading, refreshing, error, refetch, refresh, mutate };
}
