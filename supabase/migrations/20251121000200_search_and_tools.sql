-- Retrieval and the fixed "tools" the model is allowed to call.
-- Every function here is SECURITY INVOKER: it runs with the caller's rights,
-- so row-level security still decides which rows are visible.

-- ---------------------------------------------------------------------------
-- Hybrid search: full-text + vector, merged with Reciprocal Rank Fusion (RRF)
-- Adapted from https://supabase.com/docs/guides/ai/hybrid-search
-- ---------------------------------------------------------------------------
create or replace function public.hybrid_search(
  query_text text,
  query_embedding extensions.vector(768),
  match_count int default 8,
  full_text_weight float default 1,
  semantic_weight float default 1,
  rrf_k int default 50
)
returns table (
  id bigint,
  document_id uuid,
  title text,
  source_file text,
  heading text,
  content text,
  flagged_injection boolean,
  score float
)
language sql stable security invoker
set search_path = public, extensions
as $$
  with full_text as (
    select c.id,
           row_number() over (order by ts_rank_cd(c.fts, websearch_to_tsquery('english', query_text)) desc) as rank_ix
    from public.chunks c
    where c.fts @@ websearch_to_tsquery('english', query_text)
    order by rank_ix
    limit match_count * 2
  ),
  semantic as (
    select c.id,
           row_number() over (order by c.embedding <=> query_embedding) as rank_ix
    from public.chunks c
    where c.embedding is not null
    order by rank_ix
    limit match_count * 2
  )
  select c.id, c.document_id, d.title, d.source_file, c.heading, c.content, c.flagged_injection,
         coalesce(1.0 / (rrf_k + f.rank_ix), 0.0) * full_text_weight
       + coalesce(1.0 / (rrf_k + s.rank_ix), 0.0) * semantic_weight as score
  from full_text f
  full outer join semantic s on f.id = s.id
  join public.chunks c on c.id = coalesce(f.id, s.id)
  join public.documents d on d.id = c.document_id
  order by score desc
  limit match_count
$$;

-- ---------------------------------------------------------------------------
-- PO tools. "Live" POs exclude Cancelled and Superseded versions.
-- The model chooses a tool and its arguments; it never writes SQL.
-- ---------------------------------------------------------------------------
create or replace view public.live_po_lines
with (security_invoker = true) as
  select l.*, p.po_date, p.vendor_name, p.warehouse, p.total as po_total
  from public.po_lines l
  join public.purchase_orders p using (po_number, revision)
  where p.status = 'Open';

-- Most recent prices paid for an item (matches item code or description).
create or replace function public.last_purchase_rate(p_item text, p_limit int default 3)
returns table (po_number text, revision text, po_date date, vendor_name text,
               item_code text, description text, rate numeric, uom text, qty numeric)
language sql stable security invoker
set search_path = public
as $$
  select l.po_number, l.revision, l.po_date, l.vendor_name, l.item_code, l.description, l.rate, l.uom, l.qty
  from public.live_po_lines l
  where l.item_code ilike '%' || p_item || '%' or l.description ilike '%' || p_item || '%'
  order by l.po_date desc, l.po_number desc
  limit least(greatest(p_limit, 1), 10)
$$;

-- Spend with vendors whose name matches, between two dates (inclusive).
create or replace function public.vendor_spend(p_vendor text, p_from date default '2000-01-01', p_to date default '2100-01-01')
returns table (vendor_name text, po_count bigint, total_ex_gst numeric, total_incl_gst numeric)
language sql stable security invoker
set search_path = public
as $$
  select p.vendor_name, count(*), sum(p.subtotal), sum(p.total)
  from public.purchase_orders p
  where p.status = 'Open'
    and p.vendor_name ilike '%' || p_vendor || '%'
    and p.po_date between p_from and p_to
  group by p.vendor_name
$$;

-- Number of POs raised between two dates. A revision is not a new PO.
create or replace function public.po_count(p_from date, p_to date)
returns table (po_count bigint, open_count bigint, cancelled_count bigint)
language sql stable security invoker
set search_path = public
as $$
  select count(*) filter (where revision = ''),
         count(*) filter (where status = 'Open'),
         count(*) filter (where status = 'Cancelled')
  from public.purchase_orders
  where po_date between p_from and p_to
$$;

create or replace function public.largest_pos(p_limit int default 5)
returns table (po_number text, revision text, po_date date, vendor_name text, total_incl_gst numeric, approval_level text)
language sql stable security invoker
set search_path = public
as $$
  select po_number, revision, po_date, vendor_name, total, approval_level
  from public.purchase_orders
  where status = 'Open'
  order by total desc nulls last
  limit least(greatest(p_limit, 1), 20)
$$;

-- Quantity-weighted average rate for an item between two dates.
create or replace function public.average_rate(p_item text, p_from date, p_to date)
returns table (item_code text, description text, weighted_avg_rate numeric, total_qty numeric, po_lines bigint)
language sql stable security invoker
set search_path = public
as $$
  select l.item_code, min(l.description), round(sum(l.qty * l.rate) / nullif(sum(l.qty), 0), 2), sum(l.qty), count(*)
  from public.live_po_lines l
  where (l.item_code ilike '%' || p_item || '%' or l.description ilike '%' || p_item || '%')
    and l.po_date between p_from and p_to
  group by l.item_code
$$;

-- PO lines priced above a valid rate contract for the same vendor and item.
create or replace function public.contract_rate_breaches()
returns table (po_number text, revision text, po_date date, vendor_name text, item_code text,
               po_rate numeric, contract_rate numeric, excess_per_unit numeric, qty numeric, excess_value numeric)
language sql stable security invoker
set search_path = public
as $$
  select l.po_number, l.revision, l.po_date, l.vendor_name, l.item_code,
         l.rate, c.rate, l.rate - c.rate, l.qty, round((l.rate - c.rate) * l.qty, 2)
  from public.live_po_lines l
  join public.rate_contracts c
    on c.item_code = l.item_code
   and l.vendor_name ilike c.vendor_name
   and l.po_date between c.valid_from and c.valid_to
  where l.rate > c.rate
  order by l.po_date
$$;

-- POs whose recorded approval is below what the Procurement Policy requires
-- (L1 up to 1 lakh, L2 up to 5 lakh, L3 above 5 lakh, on total incl. GST).
create or replace function public.approval_violations()
returns table (po_number text, revision text, po_date date, vendor_name text, total_incl_gst numeric,
               recorded_level text, required_level text, approval_text text)
language sql stable security invoker
set search_path = public
as $$
  select * from (
    select po_number, revision, po_date, vendor_name, total, approval_level,
           case when total <= 100000 then 'L1' when total <= 500000 then 'L2' else 'L3' end as required_level,
           approval_text
    from public.purchase_orders
    where status = 'Open'
  ) x
  where x.approval_level is null or x.approval_level < x.required_level
  order by po_date
$$;

create or replace function public.list_ingestion_exceptions()
returns table (source_file text, code text, detail text, resolved boolean, created_at timestamptz)
language sql stable security invoker
set search_path = public
as $$
  select source_file, code, detail, resolved, created_at
  from public.ingestion_exceptions
  order by created_at desc
  limit 50
$$;
