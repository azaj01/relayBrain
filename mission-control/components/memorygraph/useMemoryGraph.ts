"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/api";

export type QueryResult<T = Record<string, unknown>> = {
  ok?: boolean;
  reason?: string;
  hint?: string;
  query?: string;
  summary?: string;
  cypher?: string;
  rows?: T[];
  source?: string;
};

export type GraphNode = { id: string; kind: "file" | "agent" | "session" | "prompt" | "contention" | "decision"; label: string; props: Record<string, unknown> };
export type GraphEdge = { from: string; to: string; type: string };
export type Neighborhood = QueryResult & { focus: string | null; nodes: GraphNode[]; edges: GraphEdge[] };
export type Brief = QueryResult & { markdown?: string };

export type Health = {
  enabled: boolean;
  url: string | null;
  breaker: { state: string; lastError: string | null } | null;
  projects: Record<string, { lastIngestAt: number | null; lastError: string | null }>;
};

export async function graphQuery<T = Record<string, unknown>>(projectId: string, name: string, params: Record<string, string | number | undefined> = {}) {
  const qs = new URLSearchParams({ projectId });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const res = await fetch(apiUrl(`/api/graph/query/${name}?${qs}`), { cache: "no-store" });
  return (await res.json()) as QueryResult<T> & Record<string, unknown>;
}

export async function graphHealth(): Promise<Health | null> {
  try {
    const res = await fetch(apiUrl("/api/graph/health"), { cache: "no-store" });
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

/** Bumps whenever the backend reports a memory-graph write for this project (debounced). */
export function useGraphTick(projectId: string | null) {
  const [tick, setTick] = useState(0);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!projectId) return;
    const ev = new EventSource(apiUrl(`/api/events?projectId=${projectId}`));
    const bump = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data.workspaceId && data.workspaceId !== projectId) return;
      } catch {
        /* still refresh */
      }
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setTick((t) => t + 1), 800);
    };
    ev.addEventListener("memory-graph", bump as EventListener);
    return () => {
      ev.close();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [projectId]);
  return tick;
}

/** Runs a named query, re-running when deps or the graph tick change. */
export function useQuery<T = Record<string, unknown>>(
  projectId: string | null,
  name: string | null,
  params: Record<string, string | number | undefined>,
  tick: number
) {
  const [data, setData] = useState<(QueryResult<T> & Record<string, unknown>) | null>(null);
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify(params);
  const run = useCallback(async () => {
    if (!projectId || !name) return;
    setLoading(true);
    try {
      setData(await graphQuery<T>(projectId, name, JSON.parse(key)));
    } catch (err) {
      setData({ ok: false, reason: String((err as Error).message || err) });
    } finally {
      setLoading(false);
    }
  }, [projectId, name, key]);
  useEffect(() => {
    run();
  }, [run, tick]);
  return { data, loading, reload: run };
}
