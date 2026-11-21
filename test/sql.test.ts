// Runs the real migrations in an in-memory Postgres (PGlite + pgvector) and proves
// the access rules: a warehouse user cannot read prices or contracts, while a
// procurement user can. Supabase's auth schema is stubbed with the same shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

const MIGRATIONS = [
  "supabase/migrations/20251121000100_core_schema.sql",
  "supabase/migrations/20251121000200_search_and_tools.sql",
  "supabase/migrations/20251121000300_llmops.sql",
  // 000400_platform.sql needs Supabase's storage, pg_net and realtime; not available here.
  // Its trigger function is stubbed below so 000500 (grants) can run unchanged.
  "supabase/migrations/20251121000500_api_grants.sql",
];

const SUPABASE_STUB = `
  create schema if not exists extensions;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
`;

const users = {
  admin: "00000000-0000-0000-0000-000000000001",
  buyer: "00000000-0000-0000-0000-000000000002",
  warehouse: "00000000-0000-0000-0000-000000000003",
};

async function setup() {
  const db = new PGlite({ extensions: { vector } });
  await db.exec(SUPABASE_STUB);
  for (const file of MIGRATIONS) {
    if (file.endsWith("000500_api_grants.sql")) {
      await db.exec(`create function public.notify_ingest() returns trigger language plpgsql as $$ begin return new; end $$;`);
    }
    await db.exec(readFileSync(file, "utf8"));
  }
  await db.exec(`
    -- Supabase grants this by default; everything else comes from the 000500 migration.
    grant usage on schema extensions to authenticated;
    insert into auth.users values
      ('${users.admin}', 'admin@prakriti.demo'),
      ('${users.buyer}', 'buyer@prakriti.demo'),
      ('${users.warehouse}', 'warehouse@prakriti.demo');
    update public.profiles set role = 'admin' where id = '${users.admin}';
    update public.profiles set departments = '{procurement}' where id = '${users.buyer}';
    update public.profiles set departments = '{warehouse}' where id = '${users.warehouse}';

    insert into public.documents (id, title, source_file, kind, departments, storage_path, status) values
      ('10000000-0000-0000-0000-000000000001', 'Rate Contract Aarav', 'Rate_Contract_Aarav.pdf', 'contract', '{procurement,finance}', 'x', 'live'),
      ('10000000-0000-0000-0000-000000000002', 'Slot Booking SOP', 'SOP-WH-01.docx', 'sop', '{procurement,warehouse}', 'y', 'live');
    insert into public.chunks (document_id, departments, chunk_index, heading, content, embedding) values
      ('10000000-0000-0000-0000-000000000001', '{procurement,finance}', 0, 'Rate', 'Contract rate for WPC80 is 1950 per kg', array_fill(0.1, array[768])::extensions.vector),
      ('10000000-0000-0000-0000-000000000002', '{procurement,warehouse}', 0, 'Slots', 'Slot A 09:00 to 13:00 and Slot B 14:00 to 18:00; book 24 hours ahead', array_fill(0.2, array[768])::extensions.vector);

    insert into public.purchase_orders (po_number, revision, po_date, vendor_name, status, subtotal, tax, total, approval_level) values
      ('PO-1', '', '2025-08-19', 'Aarav Ingredients LLP', 'Open', 100, 18, 7000000, 'L2'),
      ('PO-2', '', '2025-05-07', 'Kaveri Packaging Pvt. Ltd.', 'Cancelled', 100, 18, 118, 'L1'),
      ('PO-3', '', '2025-09-02', 'Orbit Labels & Print', 'Superseded', 100, 18, 118, 'L1'),
      ('PO-3', 'R1', '2025-09-02', 'Orbit Labels & Print', 'Open', 200, 36, 236, 'L1');
    insert into public.po_lines (po_number, revision, line_no, item_code, description, qty, uom, rate, gst_pct, line_value) values
      ('PO-1', '', 1, 'RM-WPC80', 'Whey Protein Concentrate 80%', 3000, 'KG', 2020, 18, 6060000),
      ('PO-2', '', 1, 'PM-JAR2K', 'HDPE Jar', 1000, 'PCS', 18.5, 18, 18500);
    insert into public.rate_contracts (vendor_name, item_code, rate, valid_from, valid_to) values
      ('Aarav Ingredients LLP', 'RM-WPC80', 1950, '2025-07-01', '2025-12-31');
  `);
  return db;
}

async function as<T = Record<string, unknown>>(db: PGlite, userId: string, sql: string) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${userId}', false);`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

const db = await setup();

test("warehouse user cannot see contract chunks or PO data", async () => {
  const chunks = await as(db, users.warehouse, "select content from chunks");
  assert.equal(chunks.length, 1);
  assert.match(String(chunks[0].content), /Slot A/);
  assert.equal((await as(db, users.warehouse, "select * from purchase_orders")).length, 0);
  assert.equal((await as(db, users.warehouse, "select * from rate_contracts")).length, 0);
  assert.equal((await as(db, users.warehouse, "select * from contract_rate_breaches()")).length, 0);
});

test("procurement user sees both documents and PO data", async () => {
  assert.equal((await as(db, users.buyer, "select * from chunks")).length, 2);
  assert.equal((await as(db, users.buyer, "select * from purchase_orders")).length, 4);
});

test("hybrid_search respects RLS and returns titles", async () => {
  const emb = `array_fill(0.2, array[768])::extensions.vector`;
  const wh = await as(db, users.warehouse, `select title from hybrid_search('contract rate WPC80', ${emb}, 5)`);
  assert.deepEqual(wh.map((r) => r.title), ["Slot Booking SOP"]);
  const buyer = await as(db, users.buyer, `select title from hybrid_search('contract rate WPC80', ${emb}, 5)`);
  assert.equal(buyer.length, 2);
  assert.equal(buyer[0].title, "Rate Contract Aarav", "keyword match should rank the contract first");
});

test("PO tools exclude cancelled and superseded POs and find breaches", async () => {
  const breaches = await as(db, users.buyer, "select po_number, po_rate, contract_rate from contract_rate_breaches()");
  assert.deepEqual(breaches.map((b) => [b.po_number, Number(b.po_rate), Number(b.contract_rate)]), [["PO-1", 2020, 1950]]);
  const viol = await as(db, users.buyer, "select po_number, required_level from approval_violations()");
  assert.deepEqual(viol.map((v) => [v.po_number, v.required_level]), [["PO-1", "L3"]]);
  const spend = await as(db, users.buyer, "select * from vendor_spend('Kaveri')");
  assert.equal(spend.length, 0, "cancelled PO must not count as spend");
  const count = await as(db, users.buyer, "select * from po_count('2025-09-01', '2025-09-30')");
  assert.equal(Number(count[0].po_count), 1, "a revision is not a new PO");
  const rate = await as(db, users.buyer, "select po_number, rate from last_purchase_rate('WPC80')");
  assert.deepEqual(rate.map((r) => r.po_number), ["PO-1"]);
});

test("users can log their own queries but not read others'", async () => {
  await as(db, users.buyer, `insert into query_logs (user_id, channel, question_redacted) values ('${users.buyer}', 'web', 'q1')`);
  await assert.rejects(
    as(db, users.buyer, `insert into query_logs (user_id, channel, question_redacted) values ('${users.warehouse}', 'web', 'q2')`),
  );
  assert.equal((await as(db, users.warehouse, "select * from query_logs")).length, 0);
  assert.equal((await as(db, users.admin, "select * from query_logs")).length, 1);
});

test("only procurement or admins can queue uploads", async () => {
  await assert.rejects(as(db, users.warehouse,
    `insert into documents (title, source_file, kind, departments, storage_path, created_by)
     values ('x', 'x.pdf', 'sop', '{warehouse}', 'p', '${users.warehouse}')`));
  await as(db, users.buyer,
    `insert into documents (title, source_file, kind, departments, storage_path, created_by)
     values ('y', 'y.pdf', 'sop', '{procurement}', 'p', '${users.buyer}')`);
});

test("grants: no one reads app_config through the API, anon reads nothing", async () => {
  await db.exec(`insert into app_config values ('webhook_secret', 's3cret')`);
  await assert.rejects(as(db, users.admin, "select * from app_config"), /permission denied/);
  await db.exec(`set role anon;`);
  try {
    await assert.rejects(db.query("select * from chunks"), /permission denied/);
  } finally {
    await db.exec(`reset role;`);
  }
});

test("users may set feedback on their own logs but not rewrite answers", async () => {
  await as(db, users.buyer, "update query_logs set feedback = 1 where question_redacted = 'q1'");
  await assert.rejects(as(db, users.buyer, "update query_logs set answer_redacted = 'x'"), /permission denied/);
});

test("one active prompt per name is seeded", async () => {
  const rows = await as(db, users.buyer, "select name, version from prompts where is_active order by name");
  assert.deepEqual(rows.map((r) => r.name), ["answer", "judge"]);
});
