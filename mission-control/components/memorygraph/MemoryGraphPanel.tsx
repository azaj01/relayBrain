"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, useReactFlow,
  type Node, type Edge, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useRelay } from "@/lib/RelayContext";
import { MarkdownView } from "@/lib/markdown";
import { graphHealth, useGraphTick, useQuery, type Brief, type GraphNode, type Health, type Neighborhood, type QueryResult } from "./useMemoryGraph";
import m from "./memorygraph.module.css";

type Row = Record<string, unknown>;

function agentLogo(label: string) {
  const l = String(label || "").toLowerCase();
  if (l.includes("cursor")) return "/agents/cursor.png";
  if (l.includes("claude")) return "/agents/claude.png";
  if (l.includes("codex")) return "/agents/codex.png";
  if (l.includes("copilot")) return "/agents/copilot.png";
  if (l.includes("antigravity")) return "/agents/antigravity.png";
  return null;
}

function ago(ts: unknown) {
  const n = Number(ts);
  if (!n) return "";
  const mins = Math.round((Date.now() - n) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

const s = (v: unknown) => (v == null ? "" : String(v));

/* ------------------------------- nodes ------------------------------- */

function AgentNode({ data }: NodeProps) {
  const d = data as { label: string; person: string };
  const logo = agentLogo(d.label);
  return (
    <div className={m.nAgent}>
      {logo ? <img src={logo} alt="" className={m.logo} /> : <span className={m.logoFallback}>{d.label[0]}</span>}
      <div>
        <div className={m.nTitle}>{d.label}</div>
        <div className={m.nSub}>@{d.person}</div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function SessionNode({ data }: NodeProps) {
  const d = data as { title: string; intent: string; prompts: string[] };
  return (
    <div className={m.nSession}>
      <Handle type="target" position={Position.Left} />
      <div className={m.nKicker}>session</div>
      <div className={m.nTitle} title={d.title}>{d.title}</div>
      {d.prompts.slice(0, 2).map((p, i) => (
        <div key={i} className={m.nPrompt} title={p}>“{p}”</div>
      ))}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function FileNode({ data }: NodeProps) {
  const d = data as { label: string; focus: boolean; rank?: number; weight?: number };
  return (
    <div className={`${m.nFile} ${d.focus ? m.nFocus : m.nClickable}`} title={d.focus ? d.label : `Open ${d.label}`}>
      <Handle type="target" position={Position.Left} />
      <div className={m.nKicker}>{d.focus ? "file" : `co-edited ×${d.weight ?? 1}`}</div>
      <div className={m.nTitle}>{d.label.split("/").pop()}</div>
      <div className={m.nSub}>{d.label}</div>
      {d.focus && d.rank != null ? <div className={m.nSub}>PageRank {Number(d.rank).toFixed(3)}</div> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ContentionNode({ data }: NodeProps) {
  const d = data as { label: string; props: Row };
  return (
    <div className={m.nContention}>
      <Handle type="target" position={Position.Left} />
      <div className={m.nKicker}>▲ {d.label}</div>
      <div className={m.nSub}>
        {s(d.props.wanterLabel) || "agent"} blocked by {s(d.props.holderLabel) || "holder"}
      </div>
      {d.props.holderIntent ? <div className={m.nPrompt}>holder was: “{s(d.props.holderIntent)}”</div> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function DecisionNode({ data }: NodeProps) {
  const d = data as { label: string; props: Row };
  return (
    <div className={m.nDecision}>
      <Handle type="target" position={Position.Left} />
      <div className={m.nKicker}>◆ decision · {s(d.props.status)}</div>
      <div className={m.nSub}>{d.label}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { agent: AgentNode, session: SessionNode, file: FileNode, contention: ContentionNode, decision: DecisionNode };

const COL: Record<string, number> = { agent: 0, session: 250, file: 570, contention: 870, decision: 870, cofile: 870 };
const ROW_H: Record<string, number> = { agent: 84, session: 132, file: 110, contention: 104, decision: 84, cofile: 90 };
const LABELLED = new Set(["HELD_BY", "WANTED_BY", "ABOUT"]);

function layout(n: Neighborhood | null) {
  if (!n?.nodes?.length) return { nodes: [] as Node[], edges: [] as Edge[] };
  const prompts = new Map<string, string[]>();
  for (const e of n.edges) {
    if (e.type !== "PROMPTED") continue;
    const p = n.nodes.find((x) => x.id === e.from);
    const text = s(p?.props?.text || p?.label);
    if (!text) continue;
    const list = prompts.get(e.to) || [];
    if (!list.includes(text)) list.push(text);
    prompts.set(e.to, list);
  }
  const col = (x: GraphNode) => (x.kind === "file" ? (x.props.focus ? "file" : "cofile") : x.kind);
  // Contentions, decisions and co-edited files share the right column, blocks first.
  const order = ["agent", "session", "file", "contention", "decision", "cofile"];
  const visible = n.nodes.filter((x) => x.kind !== "prompt").sort((a, b) => order.indexOf(col(a)) - order.indexOf(col(b)));
  const counts: Record<string, number> = {};
  const rightStack = { y: 0 };
  const nodes: Node[] = visible.map((x) => {
    const c = col(x);
    let y: number;
    if (c === "contention" || c === "decision" || c === "cofile") {
      y = rightStack.y;
      rightStack.y += ROW_H[c];
    } else {
      y = (counts[c] || 0) * ROW_H[c];
      counts[c] = (counts[c] || 0) + 1;
    }
    const data =
      x.kind === "agent"
        ? { label: s(x.props.label) || x.label, person: s(x.props.person) }
        : x.kind === "session"
          ? { title: x.label, intent: s(x.props.intent), prompts: prompts.get(x.id) || (x.props.intent ? [s(x.props.intent)] : []) }
          : x.kind === "file"
            ? { label: x.label, focus: Boolean(x.props.focus), rank: x.props.rank as number | undefined, weight: x.props.weight as number | undefined }
            : { label: x.label, props: x.props };
    return { id: x.id, type: x.kind, position: { x: COL[c], y }, data: data as Record<string, unknown> };
  });
  const focusRows = Math.max(counts.session || 0, counts.agent || 0, 1);
  const focus = nodes.find((x) => x.type === "file" && (x.data as { focus?: boolean }).focus);
  if (focus) focus.position.y = Math.max(0, ((focusRows - 1) * ROW_H.session) / 2);
  const ids = new Set(nodes.map((x) => x.id));
  const edges: Edge[] = n.edges
    .filter((e) => e.type !== "PROMPTED" && ids.has(e.from) && ids.has(e.to))
    .map((e, i) => ({
      id: `${e.type}-${i}`,
      source: e.from,
      target: e.to,
      label: LABELLED.has(e.type) ? e.type.replace("_", " ").toLowerCase() : undefined,
      labelStyle: { fill: "#bdbdbd", fontSize: 10 },
      labelBgStyle: { fill: "#0b0b0b" },
      labelBgPadding: [4, 2] as [number, number],
      className: e.type === "HELD_BY" || e.type === "WANTED_BY" || e.type === "ON" ? m.eClash : e.type === "ABOUT" ? m.eDecision : m.eBase,
      animated: e.type === "HELD_BY",
    }));
  return { nodes, edges };
}

function Canvas({ data, onOpen }: { data: Neighborhood | null; onOpen: (path: string) => void }) {
  const { nodes, edges } = useMemo(() => layout(data), [data]);
  const rf = useReactFlow();
  useEffect(() => {
    const t = window.setTimeout(() => rf.fitView({ padding: 0.08, duration: 300, maxZoom: 1.1 }), 60);
    return () => window.clearTimeout(t);
  }, [nodes, rf]);
  if (!nodes.length) return <div className={m.emptyCanvas}>Pick a file to see its memory.</div>;
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      proOptions={{ hideAttribution: true }}
      minZoom={0.2}
      maxZoom={1.6}
      nodesConnectable={false}
      onNodeClick={(_, n) => {
        const d = n.data as { focus?: boolean; label?: string };
        if (n.type === "file" && !d.focus && d.label) onOpen(d.label);
      }}
    >
      <Background color="#161616" gap={22} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/* ------------------------------- side panels ------------------------------- */

function CypherNote({ r }: { r: QueryResult | null }) {
  if (!r?.cypher) return null;
  return (
    <details className={m.cypher}>
      <summary>Cypher · {r.summary}</summary>
      <pre>{r.cypher}</pre>
    </details>
  );
}

function Problem({ r }: { r: QueryResult | null }) {
  if (!r || r.ok !== false) return null;
  return <p className={m.problem}>{r.reason === "falkor_disabled" ? "Memory graph is off on this machine." : r.reason}{r.hint ? ` (${r.hint})` : ""}</p>;
}

const EXPLAIN = [
  { id: "file_story", label: "Why it looks like this" },
  { id: "contention_trace", label: "Blocks" },
  { id: "who_to_ask", label: "Who to ask" },
  { id: "decision_trace", label: "Decisions" },
  { id: "session_brief", label: "What agents are told" },
] as const;

function ExplainRows({ name, rows }: { name: string; rows: Row[] }) {
  if (!rows.length) return <p className={m.muted}>Nothing recorded yet.</p>;
  if (name === "file_story")
    return (
      <ul className={m.list}>
        {rows.map((r, i) => (
          <li key={i}>
            <div className={m.liHead}>
              <b>{s(r.agent)}</b> <span className={m.muted}>@{s(r.person)} · {ago(r.ts)} · +{s(r.added)} −{s(r.removed)}{r.source === "patch" ? " · patch" : ""}</span>
            </div>
            <div className={m.quote}>“{s(r.prompt) || "no prompt recorded"}”{r.via ? <span className={m.muted}> (continued with “{s(r.via)}”)</span> : null}</div>
            {r.agentSaid ? <div className={m.muted}>Agent: {s(r.agentSaid).replace(/\s*\[REDACTED\]\s*$/i, "").slice(0, 200)}</div> : null}
          </li>
        ))}
      </ul>
    );
  if (name === "contention_trace")
    return (
      <ul className={m.list}>
        {rows.map((r, i) => (
          <li key={i} className={m.liClash}>
            <div className={m.liHead}>
              <b>{s(r.wanter)}</b> was blocked on <code>{s(r.file)}</code> by <b>{s(r.holder)}</b>{" "}
              <span className={m.muted}>· {ago(r.ts)} · {s(r.attempts)} attempt(s)</span>
            </div>
            {r.holderWasDoing ? <div className={m.quote}>Holder was working on: “{s(r.holderWasDoing)}”</div> : null}
            {r.wanterWasDoing ? <div className={m.muted}>Blocked agent wanted to: “{s(r.wanterWasDoing)}”</div> : null}
          </li>
        ))}
      </ul>
    );
  if (name === "who_to_ask")
    return (
      <ul className={m.list}>
        {rows.map((r, i) => (
          <li key={i}>
            <b>@{s(r.person)}</b> <span className={m.muted}>· {s(r.edits)} edits via {(r.via as string[] | undefined)?.join(", ")} · last {ago(r.lastAt)}</span>
          </li>
        ))}
      </ul>
    );
  if (name === "decision_trace")
    return (
      <ul className={m.list}>
        {rows.map((r, i) => (
          <li key={i} className={m.liDecision}>
            <div className={m.liHead}>
              <b>{s(r.decision)}</b> <span className={m.muted}>· {s(r.status)} · {ago(r.updatedAt)}</span>
            </div>
            <div className={m.muted}>
              by {s(r.agent) || "unknown agent"}
              {r.person ? ` (@${s(r.person)})` : ""}
              {r.session ? ` · during “${s(r.session)}” (${s(r.sessionConfidence)})` : ""}
            </div>
          </li>
        ))}
      </ul>
    );
  return null;
}

function Explain({ projectId, path, tick }: { projectId: string; path: string; tick: number }) {
  const [tab, setTab] = useState<(typeof EXPLAIN)[number]["id"]>("file_story");
  const params = tab === "session_brief" ? { paths: path } : { path, limit: 12 };
  const { data, loading } = useQuery<Row>(projectId, tab, params, tick);
  const brief = data as Brief | null;
  return (
    <section className={m.explain}>
      <nav className={m.tabs}>
        {EXPLAIN.map((t) => (
          <button key={t.id} className={`${m.tab} ${tab === t.id ? m.tabOn : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        {loading ? <span className={m.muted}>…</span> : null}
      </nav>
      <Problem r={data} />
      {tab === "session_brief" ? (
        <div className={m.brief}>
          <p className={m.muted}>
            This is exactly what <code>relay_session_brief</code> returns to any agent (Claude Code, Cursor, Codex, Copilot, Antigravity) before it touches this file.
          </p>
          <MarkdownView text={brief?.markdown || ""} />
        </div>
      ) : (
        <ExplainRows name={tab} rows={(data?.rows as Row[]) || []} />
      )}
      <CypherNote r={data} />
    </section>
  );
}

function Search({ projectId, tick, onOpen }: { projectId: string; tick: number; onOpen: (p: string) => void }) {
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const { data } = useQuery<Row>(projectId, q ? "search_memory" : null, { q, limit: 8 }, tick);
  return (
    <div className={m.block}>
      <h4>Search every agent conversation</h4>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQ(draft.trim());
        }}
      >
        <input className={m.input} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. jwt refresh, dark theme…" />
      </form>
      {q ? <Problem r={data} /> : null}
      <ul className={m.list}>
        {((q && (data?.rows as Row[])) || []).map((r, i) => (
          <li key={i}>
            <div className={m.liHead}>
              <b>{s(r.agent)}</b> <span className={m.muted}>@{s(r.person)} · {s(r.role)} · {ago(r.ts)}</span>
            </div>
            <div className={m.quote}>{s(r.text).slice(0, 220)}</div>
          </li>
        ))}
      </ul>
      {q ? <CypherNote r={data} /> : null}
      <OpenHint onOpen={onOpen} />
    </div>
  );
}

function OpenHint({ onOpen }: { onOpen: (p: string) => void }) {
  const [p, setP] = useState("");
  return (
    <form
      className={m.openForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (p.trim()) onOpen(p.trim());
      }}
    >
      <input className={m.input} value={p} onChange={(e) => setP(e.target.value)} placeholder="open a file by path…" />
    </form>
  );
}

/* ------------------------------- panel ------------------------------- */

function Panel() {
  const { selectedProjectId } = useRelay();
  const projectId = selectedProjectId || null;
  const tick = useGraphTick(projectId);
  const [health, setHealth] = useState<Health | null>(null);
  const [file, setFile] = useState<string | null>(null);

  useEffect(() => {
    graphHealth().then(setHealth);
  }, [tick]);

  const overview = useQuery<{ label: string; count: number }>(projectId, "overview", {}, tick);
  const hotspots = useQuery<Row>(projectId, "hotspots", { limit: 12 }, tick);
  const blocks = useQuery<Row>(projectId, "contention_trace", { limit: 4 }, tick);
  const neighborhood = useQuery<Row>(projectId, "neighborhood", { path: file || undefined }, tick);
  const hood = neighborhood.data as unknown as Neighborhood | null;

  useEffect(() => {
    setFile(null);
  }, [projectId]);
  useEffect(() => {
    if (!file && hood?.focus) setFile(hood.focus);
  }, [file, hood?.focus]);

  if (!projectId) return null;
  const counts = Object.fromEntries(((overview.data?.rows as { label: string; count: number }[]) || []).map((r) => [r.label, r.count]));
  const off = overview.data?.ok === false;
  const focusPath = (hood?.nodes || []).find((n) => n.kind === "file" && n.props.focus)?.label || file;

  return (
    <div className={m.wrap}>
      <div className={m.caption}>
        <div>
          <b>Project memory graph</b> <span className={m.muted}>· FalkorDB · {health?.breaker?.state === "closed" ? "live" : health?.enabled ? health?.breaker?.state || "connecting" : "off"}</span>
        </div>
        {!off ? (
          <div className={m.stats}>
            {["Session", "Turn", "Edit", "File", "Contention", "Overlap", "Decision"].map((k) => (
              <span key={k}>
                <b>{counts[k] || 0}</b> {k === "Turn" ? "turns" : k.toLowerCase() + "s"}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {off ? (
        <div className={m.off}>
          <p>
            <b>The memory graph is not enabled on this relay.</b>
          </p>
          <p className={m.muted}>
            Start FalkorDB with <code>npm run falkor:up</code>, then restart <code>relay serve</code> with <code>RELAY_FALKOR_URL=falkor://localhost:6379</code>. Existing history is
            imported with <code>npm run falkor:rebuild -- &lt;projectId&gt;</code>.
          </p>
        </div>
      ) : (
        <>
          {(blocks.data?.rows as Row[] | undefined)?.length ? (
            <div className={m.alerts}>
              {(blocks.data?.rows as Row[]).map((b, i) => (
                <button key={i} className={m.alert} onClick={() => setFile(s(b.file))}>
                  ▲ <b>{s(b.wanter)}</b> was blocked on <code>{s(b.file)}</code> by <b>{s(b.holder)}</b>
                  {b.holderWasDoing ? <> while it worked on “{s(b.holderWasDoing).slice(0, 80)}”</> : null} <span className={m.muted}>· {ago(b.ts)}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className={m.grid}>
            <aside className={m.rail}>
              <div className={m.block}>
                <h4>Hotspots · PageRank over co-edits</h4>
                <ul className={m.hot}>
                  {((hotspots.data?.rows as Row[]) || []).map((h) => (
                    <li key={s(h.file)}>
                      <button className={`${m.hotBtn} ${focusPath === h.file ? m.hotOn : ""}`} onClick={() => setFile(s(h.file))}>
                        <span className={m.hotName}>{s(h.file)}</span>
                        <span className={m.hotMeta}>
                          {s(h.edits)} edits · {s(h.agents)} agents
                          {Number(h.overlaps) ? ` · ${s(h.overlaps)} overlaps` : ""}
                          {Number(h.contentions) ? ` · ${s(h.contentions)} blocks` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <CypherNote r={hotspots.data} />
              </div>
              <Search projectId={projectId} tick={tick} onOpen={setFile} />
            </aside>

            <div className={m.main}>
              <div className={m.canvas}>
                <ReactFlowProvider>
                  <Canvas data={hood} onOpen={setFile} />
                </ReactFlowProvider>
              </div>
              {focusPath ? <Explain projectId={projectId} path={focusPath} tick={tick} /> : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function MemoryGraphPanel() {
  return <Panel />;
}
