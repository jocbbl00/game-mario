-- ============================================================
-- Mario Runner — Supabase Database Setup
-- Run this in your Supabase SQL editor.
-- ============================================================

-- Sessions table
-- Written only by the start-session Edge Function (service role).
-- Never directly accessible by anon clients.
create table if not exists public.mario_sessions (
  id          uuid    primary key,
  seed        bigint  not null,
  max_score   integer not null check (max_score > 0),
  coin_count  integer not null check (coin_count >= 0),
  enemy_count integer not null check (enemy_count >= 0),
  issued_at   bigint  not null,
  token       text    not null,
  used        boolean not null default false
);

-- Scores table
-- Written only by the submit-score Edge Function (service role).
-- Anon clients can only SELECT (for leaderboard display).
create table if not exists public.mario_scores (
  id               bigint  generated always as identity primary key,
  name             text    not null check (char_length(name) between 1 and 12),
  score            integer not null check (score >= 0),
  coins_collected  integer not null default 0 check (coins_collected >= 0),
  enemies_defeated integer not null default 0 check (enemies_defeated >= 0),
  won              boolean not null default false,
  play_time_ms     integer not null default 0,
  session_id       uuid    references public.mario_sessions(id),
  created_at       bigint  not null
);

create index if not exists mario_scores_score_idx on public.mario_scores (score desc);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.mario_sessions enable row level security;
alter table public.mario_scores    enable row level security;

-- Sessions: zero direct access from clients
-- Only the Edge Function (service role key) can read/write.
drop policy if exists "sessions_no_direct_access" on public.mario_sessions;
create policy "sessions_no_direct_access"
  on public.mario_sessions for all
  to anon, authenticated
  using (false) with check (false);

-- Scores: public read only — no direct writes ever
drop policy if exists "scores_public_read"     on public.mario_scores;
drop policy if exists "scores_no_direct_insert" on public.mario_scores;
drop policy if exists "scores_no_direct_update" on public.mario_scores;
drop policy if exists "scores_no_direct_delete" on public.mario_scores;

create policy "scores_public_read"
  on public.mario_scores for select
  to anon, authenticated using (true);

create policy "scores_no_direct_insert"
  on public.mario_scores for insert
  to anon, authenticated with check (false);

create policy "scores_no_direct_update"
  on public.mario_scores for update
  to anon, authenticated using (false) with check (false);

create policy "scores_no_direct_delete"
  on public.mario_scores for delete
  to anon, authenticated using (false);

-- ============================================================
-- Keep leaderboard table bounded (top 1000 scores by score, then recency)
-- Called by submit-score Edge Function after each insert.
-- ============================================================
create or replace function public.trim_mario_scores_to_max()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.mario_scores
  where id in (
    select id from (
      select id,
        row_number() over (order by score desc, created_at desc) as rn
      from public.mario_scores
    ) t
    where rn > 1000
  );
$$;

grant execute on function public.trim_mario_scores_to_max() to service_role;

-- ============================================================
-- SESSION_SECRET setup (run in Supabase dashboard > Edge Functions > Secrets)
-- supabase secrets set SESSION_SECRET="your-random-64-char-string-here"
--
-- Generate one with:  openssl rand -hex 32
-- ============================================================
