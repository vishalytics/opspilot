import { useEffect, useState } from "react";
import { supabase, type Profile } from "../supabase";

interface Doc { id: string; title: string; source_file: string; kind: string; departments: string[]; status: string; error: string | null; chunk_count: number; updated_at: string }
interface Exc { id: number; source_file: string; code: string; detail: string; created_at: string }

const KINDS = ["policy", "sop", "contract", "correspondence", "po"];
const DEPTS = ["procurement", "finance", "warehouse"];

async function sha256(file: File) {
  const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function Documents({ profile }: { profile: Profile }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [exceptions, setExceptions] = useState<Exc[]>([]);
  const [view, setView] = useState<"docs" | "pos" | "exceptions">("docs");
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState("sop");
  const [depts, setDepts] = useState<string[]>(["procurement"]);
  const [msg, setMsg] = useState("");
  const canUpload = profile.role === "admin" || profile.departments.includes("procurement");

  async function load() {
    const { data } = await supabase.from("documents").select("id, title, source_file, kind, departments, status, error, chunk_count, updated_at").order("created_at", { ascending: false });
    setDocs((data ?? []) as Doc[]);
    const { data: ex } = await supabase.from("ingestion_exceptions").select("id, source_file, code, detail, created_at").order("created_at", { ascending: false });
    setExceptions((ex ?? []) as Exc[]);
  }

  useEffect(() => {
    load();
    // Live status: queued -> parsing -> embedding -> live
    const ch = supabase.channel("documents-status")
      .on("postgres_changes", { event: "*", schema: "public", table: "documents" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setMsg("Uploading…");
    const checksum = await sha256(file);
    const { data: dup } = await supabase.from("documents").select("title").eq("checksum", checksum).limit(1);
    if (dup?.length) { setMsg(`Already uploaded as "${dup[0].title}".`); return; }
    const path = `${crypto.randomUUID()}/${file.name}`;
    const { error: upErr } = await supabase.storage.from("docs").upload(path, file);
    if (upErr) { setMsg(`Upload failed: ${upErr.message}`); return; }
    const departments = kind === "po" ? ["procurement", "finance"] : depts;
    const title = file.name.replace(/\.[^.]+$/, "").replace(/_/g, " ");
    const { error } = await supabase.from("documents").insert({
      title, source_file: file.name, kind, departments, storage_path: path, checksum, created_by: profile.id,
    });
    setMsg(error ? `Could not queue: ${error.message}` : "Queued. Watch the status change below.");
    setFile(null);
    load();
  }

  async function retry(id: string) {
    const { error } = await supabase.functions.invoke("ingest", { body: { document_id: id } });
    setMsg(error ? `Retry failed: ${error.message}` : "Re-ingesting…");
  }

  const textDocs = docs.filter((d) => d.kind !== "po");
  const poDocs = docs.filter((d) => d.kind === "po");
  const shown = view === "pos" ? poDocs : textDocs;
  const count = (s: string) => docs.filter((d) => d.status === s).length;

  return (
    <section className="documents">
      <div className="stats">
        <div><b>{textDocs.length}</b><span>documents</span></div>
        <div><b>{poDocs.length}</b><span>PO files</span></div>
        <div><b>{count("live")}</b><span>live</span></div>
        <div><b>{count("queued") + count("parsing") + count("embedding")}</b><span>processing</span></div>
        <div><b>{count("failed")}</b><span>failed</span></div>
        <div><b>{exceptions.length}</b><span>exceptions</span></div>
      </div>

      {canUpload && (
        <form className="upload" onSubmit={upload}>
          <input type="file" accept=".pdf,.docx,.xlsx,.xls,.txt,.md" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <select value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
          {kind !== "po" && DEPTS.map((d) => (
            <label key={d} className="check">
              <input type="checkbox" checked={depts.includes(d)} onChange={(e) => setDepts(e.target.checked ? [...depts, d] : depts.filter((x) => x !== d))} />{d}
            </label>
          ))}
          <button className="primary" disabled={!file || (kind !== "po" && !depts.length)}>Upload</button>
          {msg && <span className="muted small">{msg}</span>}
        </form>
      )}

      <div className="subtabs">
        <button className={view === "docs" ? "active" : ""} onClick={() => setView("docs")}>Documents</button>
        <button className={view === "pos" ? "active" : ""} onClick={() => setView("pos")}>Purchase orders</button>
        <button className={view === "exceptions" ? "active" : ""} onClick={() => setView("exceptions")}>Exceptions ({exceptions.length})</button>
      </div>

      {view !== "exceptions" ? (
        <table>
          <thead><tr><th>Title</th><th>Kind</th><th>Visible to</th><th>Status</th><th>Chunks</th><th>Updated</th>{profile.role === "admin" && <th></th>}</tr></thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.id}>
                <td title={d.source_file}>{d.title}</td>
                <td>{d.kind}</td>
                <td>{d.departments.join(", ")}</td>
                <td><span className={`pill status-${d.status}`}>{d.status}</span>{d.error && <div className="error small">{d.error}</div>}</td>
                <td>{d.kind === "po" ? "—" : d.chunk_count}</td>
                <td className="small">{new Date(d.updated_at).toLocaleString("en-IN")}</td>
                {profile.role === "admin" && <td><button className="link" onClick={() => retry(d.id)}>Re-run</button></td>}
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={7} className="muted">Nothing here that you can access.</td></tr>}
          </tbody>
        </table>
      ) : (
        <table>
          <thead><tr><th>File</th><th>Problem</th><th>Detail</th></tr></thead>
          <tbody>
            {exceptions.map((x) => (
              <tr key={x.id}><td>{x.source_file}</td><td><span className="pill warn">{x.code}</span></td><td>{x.detail}</td></tr>
            ))}
            {!exceptions.length && <tr><td colSpan={3} className="muted">No exceptions (or you don't have access to them).</td></tr>}
          </tbody>
        </table>
      )}
    </section>
  );
}
