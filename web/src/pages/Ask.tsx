import { useRef, useState } from "react";
import { inr, supabase, type AskResult } from "../supabase";

interface Turn { question: string; result?: AskResult; error?: string; feedback?: 1 | -1 }

const SUGGESTIONS = [
  "What approvals are needed to release a PO worth ₹3.5 lakh?",
  "What was the last rate we paid for WPC80?",
  "Did we raise any WPC80 PO above the Aarav contract rate?",
  "Are there POs above ₹5 lakh without CFO and CEO approval?",
  "What are the inbound unloading slots?",
  "Which vendor should we prefer for whey protein concentrate?",
];

const ROUTE_LABEL: Record<string, string> = {
  docs: "Documents", po_tool: "PO data", both: "Documents + PO data", refused: "No answer", error: "Error",
};

function AnswerText({ text, onCite }: { text: string; onCite: (label: string) => void }) {
  const parts = text.split(/(\[(?:D|T)\d+\])/g);
  return (
    <p className="answer">
      {parts.map((p, i) => {
        const m = p.match(/^\[((?:D|T)\d+)\]$/);
        return m ? <button key={i} className="cite" onClick={() => onCite(m[1])}>{m[1]}</button> : <span key={i}>{p}</span>;
      })}
    </p>
  );
}

function TurnView({ turn, onFeedback }: { turn: Turn; onFeedback: (v: 1 | -1) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const r = turn.result;
  return (
    <div className="turn">
      <div className="q">{turn.question}</div>
      {!r && !turn.error && <div className="a thinking">Searching documents and PO data…</div>}
      {turn.error && <div className="a error">{turn.error}</div>}
      {r && (
        <div className="a">
          <AnswerText text={r.answer} onCite={(l) => setOpen(open === l ? null : l)} />
          {r.sources.length > 0 && (
            <div className="sources">
              {r.sources.map((s) => (
                <div key={s.label} className={`source ${open === s.label ? "open" : ""}`}>
                  <button className="source-head" onClick={() => setOpen(open === s.label ? null : s.label)}>
                    <span className="cite static">{s.label}</span>
                    <span className="source-title">{s.title}{s.type === "document" && s.heading ? ` › ${s.heading}` : ""}</span>
                    {s.flagged && <span className="pill warn">suspicious instructions</span>}
                  </button>
                  {open === s.label && <pre className="source-body">{s.content}</pre>}
                </div>
              ))}
            </div>
          )}
          <div className="meta">
            <span className={`pill route-${r.route}`}>{ROUTE_LABEL[r.route] ?? r.route}</span>
            <span>{(r.latency_ms / 1000).toFixed(1)} s</span>
            <span>{inr(r.cost_inr, 4)}</span>
            {r.flags.filter((f) => f !== "no_answer").map((f) => <span key={f} className="pill flag">{f}</span>)}
            {r.log_id && (
              <span className="feedback">
                <button className={turn.feedback === 1 ? "on" : ""} onClick={() => onFeedback(1)} title="Helpful">👍</button>
                <button className={turn.feedback === -1 ? "on" : ""} onClick={() => onFeedback(-1)} title="Not helpful">👎</button>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Ask() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  async function ask(q: string) {
    if (!q.trim() || busy) return;
    setBusy(true); setQuestion("");
    const idx = turns.length;
    setTurns((t) => [...t, { question: q }]);
    const { data, error } = await supabase.functions.invoke<AskResult>("ask", { body: { question: q } });
    setTurns((t) => t.map((x, i) => (i === idx ? { ...x, result: data ?? undefined, error: error ? error.message : undefined } : x)));
    setBusy(false);
    setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }

  async function feedback(i: number, v: 1 | -1) {
    const id = turns[i].result?.log_id;
    if (!id) return;
    await supabase.from("query_logs").update({ feedback: v }).eq("id", id);
    setTurns((t) => t.map((x, j) => (j === i ? { ...x, feedback: v } : x)));
  }

  return (
    <section className="ask">
      {turns.length === 0 && (
        <div className="empty">
          <h2>Ask about procurement</h2>
          <p className="muted">Policies, SOPs, contracts and 43 purchase orders (Apr–Sep 2025). Answers cite sources as [D1] for documents and [T1] for PO data.</p>
          <div className="suggestions">
            {SUGGESTIONS.map((s) => <button key={s} onClick={() => ask(s)}>{s}</button>)}
          </div>
        </div>
      )}
      <div className="turns">
        {turns.map((t, i) => <TurnView key={i} turn={t} onFeedback={(v) => feedback(i, v)} />)}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); ask(question); }}>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. What is Kaveri's late-delivery penalty?" maxLength={1000} />
        <button className="primary" disabled={busy || !question.trim()}>{busy ? "…" : "Ask"}</button>
      </form>
    </section>
  );
}
