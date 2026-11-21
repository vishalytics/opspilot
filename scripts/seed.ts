// Seeds config, demo users and rate contracts. Safe to run more than once.
//   npx tsx scripts/seed.ts
import { adminClient, anonClient, need, readCsv, SUPABASE_URL } from "./lib.ts";

const db = adminClient();

async function main() {
  // 1. Where the database trigger should send new documents, and the shared secret.
  const { error: cfgErr } = await db.from("app_config").upsert([
    { key: "ingest_url", value: `${SUPABASE_URL()}/functions/v1/ingest` },
    { key: "webhook_secret", value: need("WEBHOOK_SECRET") },
  ]);
  if (cfgErr) throw cfgErr;
  console.log("✓ app_config set (ingest webhook)");

  // 2. Demo users with departments.
  const password = need("DEMO_PASSWORD");
  const users = readCsv<{ email: string; role: string; departments: string }>("data/seed/demo_users.csv");
  const { data: existing } = await db.auth.admin.listUsers({ perPage: 1000 });
  for (const u of users) {
    let id = existing?.users.find((x) => x.email === u.email)?.id;
    if (id) {
      // Only reset the password if it no longer works: a reset signs the user out everywhere.
      const { error: loginErr } = await anonClient().auth.signInWithPassword({ email: u.email, password });
      if (loginErr) await db.auth.admin.updateUserById(id, { password });
    } else {
      const { data, error } = await db.auth.admin.createUser({ email: u.email, password, email_confirm: true });
      if (error) throw error;
      id = data.user.id;
    }
    const { error } = await db.from("profiles").upsert({
      id, email: u.email, role: u.role, departments: u.role === "admin" ? [] : u.departments.split("|"),
    });
    if (error) throw error;
    console.log(`✓ user ${u.email} (${u.role}, ${u.departments.replace(/\|/g, ", ")})`);
  }

  // 3. Rate contracts, typed from the two contracts in data/documents/contracts.
  await db.from("rate_contracts").delete().gte("id", 0);
  const { error: rcErr } = await db.from("rate_contracts").insert([
    { vendor_name: "Aarav Ingredients LLP", item_code: "RM-WPC80", rate: 1950, valid_from: "2025-07-01", valid_to: "2025-12-31", source_file: "Rate_Contract_Aarav_Ingredients_WPC80.pdf" },
    { vendor_name: "Kaveri Packaging Pvt. Ltd.", item_code: "PM-JAR2K", rate: 18.5, valid_from: "2025-04-01", valid_to: "2025-12-31", source_file: "Supply_Agreement_Kaveri_Packaging.docx" },
    { vendor_name: "Kaveri Packaging Pvt. Ltd.", item_code: "PM-SCP30", rate: 1.2, valid_from: "2025-04-01", valid_to: "2025-12-31", source_file: "Supply_Agreement_Kaveri_Packaging.docx" },
  ]);
  if (rcErr) throw rcErr;
  console.log("✓ rate contracts seeded (3)");
}

main().catch((e) => { console.error("Seed failed:", e.message ?? e); process.exit(1); });
