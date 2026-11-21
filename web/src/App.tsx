import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { configured, supabase, type Profile } from "./supabase";
import Login from "./pages/Login";
import Ask from "./pages/Ask";
import Documents from "./pages/Documents";
import Admin from "./pages/Admin";

type Tab = "ask" | "documents" | "admin";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tab, setTab] = useState<Tab>("ask");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setProfile(null); return; }
    supabase.from("profiles").select("id, email, role, departments").eq("id", session.user.id).single()
      .then(({ data }) => setProfile(data as Profile));
  }, [session]);

  if (!configured) {
    return (
      <div className="center-card">
        <h1>OpsPilot</h1>
        <p>Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> (see <code>web/.env.example</code>), then restart.</p>
      </div>
    );
  }
  if (!ready) return null;
  if (!session) return <Login />;

  const isAdmin = profile?.role === "admin";
  const depts = isAdmin ? ["all departments"] : profile?.departments ?? [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">▲</span> OpsPilot
          <span className="tag">Procurement copilot · Prakriti Nutrition (demo)</span>
        </div>
        <nav>
          <button className={tab === "ask" ? "active" : ""} onClick={() => setTab("ask")}>Ask</button>
          <button className={tab === "documents" ? "active" : ""} onClick={() => setTab("documents")}>Documents</button>
          {isAdmin && <button className={tab === "admin" ? "active" : ""} onClick={() => setTab("admin")}>LLMOps</button>}
        </nav>
        <div className="who">
          <span>{profile?.email}</span>
          <span className="pill">{depts.length ? depts.join(", ") : "no access"}</span>
          <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </header>
      <main>
        {tab === "ask" && <Ask />}
        {tab === "documents" && profile && <Documents profile={profile} />}
        {tab === "admin" && isAdmin && <Admin />}
      </main>
    </div>
  );
}
