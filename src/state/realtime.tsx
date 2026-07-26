import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

type RealtimeContextValue = {
  state: ConnectionState;
  reconnects: number;
};

const RealtimeContext = createContext<RealtimeContextValue>({ state: "offline", reconnects: 0 });

export function createRefreshCoalescer(
  refresh: () => void | Promise<void>,
  options: { cancelActive?: () => void | Promise<void> } = {},
) {
  let active: Promise<void> | null = null;
  let cancellation: Promise<void> | null = null;
  let trailing = false;
  let disposed = false;

  const drain = async () => {
    let finalError: unknown;
    do {
      trailing = false;
      try {
        await refresh();
        finalError = undefined;
      } catch (error) {
        // Query state owns the visible error; the caller still needs failure
        // semantics so it cannot re-enable actions against stale data.
        finalError = error;
      }
      if (!disposed && trailing && cancellation) {
        await cancellation;
        cancellation = null;
      }
    } while (!disposed && trailing);
    if (finalError !== undefined) throw finalError;
  };

  return {
    request(): Promise<void> {
      if (disposed) return Promise.resolve();
      if (active) {
        trailing = true;
        cancellation ??= Promise.resolve(options.cancelActive?.()).then(() => undefined, () => undefined);
        return active;
      }
      active = drain().finally(() => {
        active = null;
      });
      return active;
    },
    dispose(): void {
      disposed = true;
      trailing = false;
      cancellation ??= Promise.resolve(options.cancelActive?.()).then(() => undefined, () => undefined);
    },
  };
}

export function useRefreshCoalescer(
  refresh: () => void | Promise<void>,
  cancelActive?: () => void | Promise<void>,
): () => Promise<void> {
  const refreshRef = useRef(refresh);
  const cancelActiveRef = useRef(cancelActive);
  refreshRef.current = refresh;
  cancelActiveRef.current = cancelActive;
  const scheduler = useMemo(
    () => createRefreshCoalescer(
      () => refreshRef.current(),
      { cancelActive: () => cancelActiveRef.current?.() },
    ),
    [],
  );
  useEffect(() => () => scheduler.dispose(), [scheduler]);
  return useCallback(() => scheduler.request(), [scheduler]);
}

export function RealtimeProvider({
  enabled,
  onChange,
  children,
}: {
  enabled: boolean;
  onChange: () => void | Promise<void>;
  children: ReactNode | ((value: RealtimeContextValue) => ReactNode);
}) {
  const [state, setState] = useState<ConnectionState>(enabled ? "connecting" : "offline");
  const [reconnects, setReconnects] = useState(0);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!enabled) {
      setState("offline");
      setReconnects(0);
      return;
    }

    let disposed = false;
    const events = new EventSource("/api/events");
    setState((current) => {
      if (current === "offline") return "connecting";
      if (current === "live") return "reconnecting";
      return current;
    });

    const refreshAndConfirm = () => {
      if (disposed) return;
      setState("reconnecting");
      void (async () => {
        try {
          await onChangeRef.current();
          if (!disposed) setState("live");
        } catch {
          if (!disposed) setState("reconnecting");
        }
      })();
    };
    events.addEventListener("ready", refreshAndConfirm);
    events.addEventListener("change", refreshAndConfirm);
    events.onerror = () => {
      if (disposed) return;
      setState("reconnecting");
      setReconnects((current) => current + 1);
    };

    return () => {
      disposed = true;
      events.close();
    };
  }, [enabled]);

  const value = useMemo(() => ({ state, reconnects }), [state, reconnects]);
  return (
    <RealtimeContext.Provider value={value}>
      {typeof children === "function" ? children(value) : children}
    </RealtimeContext.Provider>
  );
}

export function useRealtime() {
  return useContext(RealtimeContext);
}
