-- OpsPilot core schema: users, documents, chunks, purchase orders.
-- Access model: every user has a list of departments. Row-level security (RLS)
-- compares a row's departments with the caller's, so the database decides what
-- can be retrieved, not the prompt.

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text unique not null,
  full_name text,
  role text not null default 'member' check (role in ('admin', 'member')),
  departments text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- Departments the current caller may read. Admins see everything.
-- security definer so it can read profiles without tripping profiles' own RLS.
create or replace function public.my_departments()
returns text[]
language sql stable security definer
set search_path = public
as $$
  select case when p.role = 'admin'
              then array['procurement', 'finance', 'warehouse']
              else p.departments end
  from public.profiles p
  where p.id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
$$;

-- New auth users get a profile with no departments (no access until assigned).
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
create policy "read own profile or admin" on public.profiles
  for select using (id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- Documents and chunks
-- ---------------------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_file text not null,                 -- original file name, used for citations and eval matching
  kind text not null check (kind in ('policy', 'sop', 'contract', 'correspondence', 'po')),
  departments text[] not null,
  storage_path text not null,
  checksum text,
  status text not null default 'queued'
    check (status in ('queued', 'parsing', 'embedding', 'live', 'failed')),
  error text,
  chunk_count int not null default 0,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index documents_checksum_idx on public.documents (checksum);

create table public.chunks (
  id bigint generated always as identity primary key,
  document_id uuid not null references public.documents (id) on delete cascade,
  departments text[] not null,               -- copied from the document so RLS needs no join
  chunk_index int not null,
  heading text,
  content text not null,
  token_count int,
  embedding extensions.vector(768),
  fts tsvector generated always as
    (to_tsvector('english', coalesce(heading, '') || ' ' || content)) stored,
  flagged_injection boolean not null default false
);
create index chunks_embedding_idx on public.chunks using hnsw (embedding extensions.vector_cosine_ops);
create index chunks_fts_idx on public.chunks using gin (fts);
create index chunks_document_idx on public.chunks (document_id);

alter table public.documents enable row level security;
alter table public.chunks enable row level security;

create policy "read documents in my departments" on public.documents
  for select using (departments && public.my_departments());

-- Uploads: admins and procurement users can register a new document for ingestion.
create policy "procurement can queue uploads" on public.documents
  for insert with check (
    status = 'queued'
    and created_by = auth.uid()
    and (public.is_admin() or 'procurement' = any (public.my_departments()))
  );

create policy "read chunks in my departments" on public.chunks
  for select using (departments && public.my_departments());
-- No insert/update policies on chunks: only the ingest function (service role) writes them.

-- ---------------------------------------------------------------------------
-- Purchase orders (structured data extracted from Excel POs)
-- ---------------------------------------------------------------------------
create table public.purchase_orders (
  po_number text not null,
  revision text not null default '',          -- '' for the original, 'R1', 'R2' for revisions
  po_date date,
  vendor_name text,
  vendor_gstin text,
  warehouse text,                             -- MNS (Manesar) or BWD (Bhiwandi)
  status text not null default 'Open' check (status in ('Open', 'Cancelled', 'Superseded')),
  subtotal numeric(14, 2),
  tax numeric(14, 2),
  total numeric(14, 2),                       -- computed from lines + tax
  header_total numeric(14, 2),                -- as typed in the file (may disagree)
  approval_text text,
  approval_level text check (approval_level in ('L1', 'L2', 'L3')),
  template text,
  document_id uuid references public.documents (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (po_number, revision)
);

create table public.po_lines (
  id bigint generated always as identity primary key,
  po_number text not null,
  revision text not null default '',
  line_no int not null,
  item_code text,
  description text,
  hsn text,
  qty numeric(14, 3),
  uom text,
  rate numeric(14, 2),
  gst_pct numeric(5, 2),
  line_value numeric(14, 2),                  -- qty x rate, excluding GST
  foreign key (po_number, revision) references public.purchase_orders (po_number, revision) on delete cascade
);
create index po_lines_item_idx on public.po_lines (item_code);

create table public.rate_contracts (
  id bigint generated always as identity primary key,
  vendor_name text not null,
  item_code text not null,
  rate numeric(14, 2) not null,
  valid_from date not null,
  valid_to date not null,
  source_file text
);

create table public.ingestion_exceptions (
  id bigint generated always as identity primary key,
  document_id uuid references public.documents (id) on delete cascade,
  source_file text,
  code text not null check (code in ('ITEM_TABLE_NOT_FOUND', 'TOTAL_MISMATCH', 'SUPERSEDED_REVISION', 'UNKNOWN_TEMPLATE', 'PARSE_ERROR', 'DUPLICATE')),
  detail text,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.purchase_orders enable row level security;
alter table public.po_lines enable row level security;
alter table public.rate_contracts enable row level security;
alter table public.ingestion_exceptions enable row level security;

-- Prices and PO values are visible only to procurement and finance (and admins).
create policy "procurement and finance read POs" on public.purchase_orders
  for select using (public.my_departments() && array['procurement', 'finance']);
create policy "procurement and finance read PO lines" on public.po_lines
  for select using (public.my_departments() && array['procurement', 'finance']);
create policy "procurement and finance read contracts" on public.rate_contracts
  for select using (public.my_departments() && array['procurement', 'finance']);
create policy "procurement and admins read exceptions" on public.ingestion_exceptions
  for select using (public.is_admin() or 'procurement' = any (public.my_departments()));
