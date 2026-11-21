-- Supabase platform wiring: storage bucket, ingestion webhook, realtime.
-- Kept separate from the core schema because it depends on Supabase-only
-- schemas (storage, net, realtime publication).

-- ---------------------------------------------------------------------------
-- Private storage bucket for uploaded files
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('docs', 'docs', false)
on conflict (id) do nothing;

create policy "procurement and admins upload docs" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'docs'
    and (public.is_admin() or 'procurement' = any (public.my_departments()))
  );

-- ---------------------------------------------------------------------------
-- Event-driven ingestion: a new documents row calls the 'ingest' Edge Function.
-- The URL and shared secret live in app_config (set by scripts/seed.ts).
-- pg_net sends the request asynchronously, so the insert never waits for it.
-- ---------------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;

create or replace function public.notify_ingest()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  select value into v_url from public.app_config where key = 'ingest_url';
  select value into v_secret from public.app_config where key = 'webhook_secret';
  if v_url is null or v_secret is null then
    return new;  -- not configured yet; scripts/reingest.ts can process queued documents later
  end if;
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('document_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
    timeout_milliseconds := 10000
  );
  return new;
end $$;

create trigger documents_notify_ingest
  after insert on public.documents
  for each row execute function public.notify_ingest();

-- Live status updates in the Documents page.
alter publication supabase_realtime add table public.documents;
