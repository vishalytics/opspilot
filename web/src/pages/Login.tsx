import { useState } from "react";
import { supabase } from "../supabase";

const DEMO = [
  ["admin@prakriti.demo", "Admin: every department + LLMOps dashboard"],
  ["buyer@prakriti.demo", "Procurement: policies, contracts, PO data, uploads"],
  ["finance@prakriti.demo", "Finance: payment policy, contracts, PO data"],
  ["warehouse@prakriti.demo", "Warehouse: SOPs only, no prices"],
];

export default function Login() {
  const [email, setEmail] = useState("buyer@prakriti.demo");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setBusy(false);
  }

  return (
    <div className="center-card">
      <h1><span className="logo">▲</span> OpsPilot</h1>
      <p className="muted">Ask procurement policies, contracts and PO data. Every answer cites its source and respects your department's access.</p>
      <form onSubmit={signIn}>
        <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required /></label>
        <label>Password<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required /></label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <div className="demo-users">
        <p className="muted small">Demo users (password = DEMO_PASSWORD from your setup):</p>
        {DEMO.map(([e, d]) => (
          <button key={e} className="demo" onClick={() => setEmail(e)}><b>{e}</b><span>{d}</span></button>
        ))}
      </div>
    </div>
  );
}
