import { useEffect, useState, type DependencyList } from 'react';
import { errorMessage } from './api/client';

export type AsyncState<T> = { loading: true; data?: undefined; error?: undefined } | { loading: false; data: T; error?: undefined } | { loading: false; data?: undefined; error: string };

/** Run a promise-returning function when deps change; ignores stale results. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ loading: true });
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    fn().then(
      (data) => live && setState({ loading: false, data }),
      (err: unknown) => live && setState({ loading: false, error: errorMessage(err) }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
