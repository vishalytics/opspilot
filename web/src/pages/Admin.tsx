import { useEffect, useMemo, useState } from "react";
import { inr, supabase } from "../supabase";

interface Log {
  id: number; created_at: string; channel: string; question_redacted: string; answer_redacted: string | null; route: string | null;
  model: string | null; prompt_version: number | null; input_tokens: number; output_tokens: number; embed_tokens: number;
  cost_inr: number; retrieval_ms: number; llm_ms: number; latency_ms: number; guardrail_flags: string[]; feedback: number | null;
  tool_calls: { name: string }[];
}
interface Run { id: number; created_at: string; label: string | null; config: Record<string, unknown>; questions: number; retrieval_hit_rate: number | null; answer_accuracy: number | null; avg_latency_ms: number | null; p95_latency_ms: number | null; total_cost_inr: number | null }

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : "—");
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

function Bars({ data }: { data: [string, number][] }) {
  const max = Math.max(1, ...data.map((d) => d[1]));
  return (
    <div className="bars">
      {data.map(([k, v]) => (
        <div key={k} className="bar-row">
          <span className="bar-label">{k}</span>
          <span className="bar"><span style={{ width: `${(100 * v) / max}%` }} /></span>
          <span className="bar-value">{v}</span>
        </div>
      ))}
      {!data.length && <p className="muted small">No data yet.</p>}
    </div>
  );
}

export default function Admin() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [days, setDays] = useState(30);

  useEffect(() => {
    const since = new Date(Date.now() - days * 864e5).toISOString();
    supabase.from("query_logs").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(2000)
      .then(({ data }) => setLogs((data ?? []) as Log[]));
    supabase.from("eval_runs").select("*").order("created_at", { ascending: false }).limit(20)
      .then(({ data }) => setRuns((data ?? []) as Run[]));
  }, [days]);

  const m = useMemo(() => {
    const live = logs.filter((l) => l.channel !== "eval");
    const lat = live.map((l) => l.latency_ms);
    const cost = live.reduce((a, l) => a + Number(l.cost_inr), 0);
    const byDay = new Map<string, number>();
    live.forEach((l) => { const d = l.created_at.slice(5, 10); byDay.set(d, (byDay.get(d) ?? 0) + 1); });
    const flags = new Map<string, number>();
    live.forEach((l) => l.guardrail_flags.forEach((f) => flags.set(f, (flags.get(f) ?? 0) + 1)));
    const tools = new Map<string, number>();
    live.forEach((l) => l.tool_calls.forEach((t) => tools.set(t.name, (tools.get(t.name) ?? 0) + 1)));
    const routes = new Map<string, number>();
    live.forEach((l) => routes.set(l.route ?? "?", (routes.get(l.route ?? "?") ?? 0) + 1));
    return {
      live, n: live.length, cost, avgCost: live.length ? cost / live.length : 0,
      p50: quantile(lat, 0.5), p95: quantile(lat, 0.95),
      p95Retrieval: quantile(live.map((l) => l.retrieval_ms), 0.95), p95Llm: quantile(live.map((l) => l.llm_ms), 0.95),
      noAnswer: live.filter((l) => l.route === "refused").length,
      down: live.filter((l) => l.feedback === -1).length, up: live.filter((l) => l.feedback === 1).length,
      tokens: live.reduce((a, l) => a + l.input_tokens + l.output_tokens, 0),
      slack: live.filter((l) => l.channel === "slack").length,
      byDay: [...byDay.entries()].sort().slice(-14), flags: [...flags.entries()].sort((a, b) => b[1] - a[1]),
      tools: [...tools.entries()].sort((a, b) => b[1] - a[1]), routes: [...routes.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [logs]);

  const slowest = [...m.live].sort((a, b) => b.latency_ms - a.latency_ms).slice(0, 8);
  const priciest = [...m.live].sort((a, b) => b.cost_inr - a.cost_inr).slice(0, 8);

  return (
    <section className="admin">
      <div className="admin-head">
        <h2>LLMOps</h2>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={1}>Last 24 hours</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={365}>Last year</option>
        </select>
      </div>
      <div className="kpis">
        <div><span>Queries</span><b>{m.n}</b><small>{m.slack} from Slack</small></div>
        <div><span>p50 / p95 latency</span><b>{(m.p50 / 1000).toFixed(1)} / {(m.p95 / 1000).toFixed(1)} s</b><small>p95 retrieval {(m.p95Retrieval / 1000).toFixed(1)} s · LLM {(m.p95Llm / 1000).toFixed(1)} s</small></div>
        <div><span>Cost per query</span><b>{inr(m.avgCost, 4)}</b><small>total {inr(m.cost, 2)} · {m.tokens.toLocaleString("en-IN")} tokens</small></div>
        <div><span>No-answer rate</span><b>{pct(m.noAnswer, m.n)}</b><small>{m.noAnswer} refused or ungrounded</small></div>
        <div><span>Feedback</span><b>{m.up} 👍 · {m.down} 👎</b><small>{pct(m.down, m.up + m.down)} negative</small></div>
      </div>
      {m.cost === 0 && m.n > 0 && <p className="muted small">Cost shows ₹0: set PRICE_IN_PER_M and PRICE_OUT_PER_M in the function secrets (see README).</p>}

      <div className="grid3">
        <div className="panel"><h3>Queries per day</h3><Bars data={m.byDay} /></div>
        <div className="panel"><h3>Routes</h3><Bars data={m.routes} /><h3>Tools called</h3><Bars data={m.tools} /></div>
        <div className="panel"><h3>Guardrail flags</h3><Bars data={m.flags} /></div>
      </div>

      <div className="panel">
        <h3>Evaluation runs <span className="muted small">(npm run eval)</span></h3>
        <table>
          <thead><tr><th>When</th><th>Label</th><th>Config</th><th>Questions</th><th>Retrieval hit</th><th>Answer accuracy</th><th>p95</th><th>Cost</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="small">{new Date(r.created_at).toLocaleString("en-IN")}</td><td>{r.label}</td>
                <td className="small mono">{Object.entries(r.config).map(([k, v]) => `${k}=${v}`).join(" ")}</td>
                <td>{r.questions}</td><td>{r.retrieval_hit_rate ?? "—"}%</td><td><b>{r.answer_accuracy ?? "—"}%</b></td>
                <td>{r.p95_latency_ms ? (r.p95_latency_ms / 1000).toFixed(1) + " s" : "—"}</td><td>{r.total_cost_inr != null ? inr(r.total_cost_inr, 3) : "—"}</td>
              </tr>
            ))}
            {!runs.length && <tr><td colSpan={8} className="muted">No eval runs yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="grid2">
        <div className="panel"><h3>Slowest queries</h3><QueryTable rows={slowest} /></div>
        <div className="panel"><h3>Most expensive queries</h3><QueryTable rows={priciest} /></div>
      </div>
    </section>
  );
}

function QueryTable({ rows }: { rows: Log[] }) {
  return (
    <table>
      <thead><tr><th>Question</th><th>Route</th><th>Latency</th><th>Tokens</th><th>Cost</th></tr></thead>
      <tbody>
        {rows.map((l) => (
          <tr key={l.id} title={l.answer_redacted ?? ""}>
            <td>{l.question_redacted.slice(0, 70)}</td><td>{l.route}</td><td>{(l.latency_ms / 1000).toFixed(1)} s</td>
            <td>{l.input_tokens + l.output_tokens}</td><td>{inr(l.cost_inr, 4)}</td>
          </tr>
        ))}
        {!rows.length && <tr><td colSpan={5} className="muted">No queries yet.</td></tr>}
      </tbody>
    </table>
  );
}
