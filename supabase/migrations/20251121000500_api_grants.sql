-- Explicit Data API privileges.
-- New Supabase projects can be created with "Grant API access to new tables
-- automatically" switched off. In that case the anon/authenticated roles have no
-- table privileges and every query fails with "permission denied", even with RLS
-- policies in place. Granting here makes the project work either way.
-- Privileges only open the door; the RLS policies still decide which rows are visible.

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Signed-in users: read what RLS allows; write only where a policy allows it.
grant select on all tables in schema public to authenticated;
grant insert on public.documents, public.query_logs to authenticated;
grant update (feedback) on public.query_logs to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- app_config holds the webhook secret: never readable through the API.
revoke all on public.app_config from anon, authenticated;

-- Functions: signed-in users may call the search and PO tools (they run as the caller).
grant execute on all functions in schema public to authenticated, service_role;
revoke execute on function public.notify_ingest() from anon, authenticated;
revoke execute on function public.handle_new_user() from anon, authenticated;

-- Anonymous visitors get nothing beyond what Supabase Auth needs.
revoke all on all tables in schema public from anon;
