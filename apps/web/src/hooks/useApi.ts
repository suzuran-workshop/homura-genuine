/**
 * 轻量数据请求 hook（裸 fetch 方案的配套，不引 tanstack-query）。
 *
 * useQuery：挂载即拉、返回 data/loading/error 与手动 refresh。
 * useAction：包装写操作（POST/PUT/PATCH），返回 run + pending + error，成功后可选刷新某个 query。
 *
 * 约定：所有错误统一成 ApiError（见 lib/api.ts）；组件层据 kind 分流展示。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/lib/api'

interface QueryState<T> {
  data: T | null
  loading: boolean
  error: ApiError | null
}

/**
 * 拉取型请求。fn 应是幂等的读操作（如 () => api.listProducts()）。
 * deps 变化时重新拉取；refresh() 手动重拉。
 */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<QueryState<T>>({ data: null, loading: true, error: null })
  // 用 ref 记住最新 fn，避免把 fn 本身放进 deps 造成无限重拉
  const fnRef = useRef(fn)
  fnRef.current = fn
  // 竞态守卫：只认最后一次请求的结果
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const data = await fnRef.current()
      if (seq === seqRef.current) setState({ data, loading: false, error: null })
    } catch (err) {
      if (seq === seqRef.current) {
        setState({
          data: null,
          loading: false,
          error: err instanceof ApiError ? err : new ApiError(0, 'unknown', '', String(err)),
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { ...state, refresh: load }
}

interface ActionState {
  pending: boolean
  error: ApiError | null
}

/**
 * 写操作包装。run(args) 执行 fn 并管理 pending/error；成功后调 onSuccess（通常刷新列表）。
 */
export function useAction<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  onSuccess?: (result: R) => void,
) {
  const [state, setState] = useState<ActionState>({ pending: false, error: null })
  const fnRef = useRef(fn)
  fnRef.current = fn
  const onSuccessRef = useRef(onSuccess)
  onSuccessRef.current = onSuccess

  const run = useCallback(async (...args: A): Promise<R | null> => {
    setState({ pending: true, error: null })
    try {
      const result = await fnRef.current(...args)
      setState({ pending: false, error: null })
      onSuccessRef.current?.(result)
      return result
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError(0, 'unknown', '', String(err))
      setState({ pending: false, error: apiErr })
      return null
    }
  }, [])

  return { ...state, run, clearError: () => setState((s) => ({ ...s, error: null })) }
}
