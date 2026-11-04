-- Fleet Invaders: players, games, visits and the private day report.
--
-- Browsers connect with the publishable key, which acts as the anon role.
-- That role cannot read or write any table here. It can only call the public
-- functions granted at the end of this file, and those functions check input.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------- tables

create table public.app_settings (
  id smallint primary key default 1 check (id = 1),
  time_zone text not null default 'America/Toronto',
  report_secret_hash text
);
insert into public.app_settings (id) values (1);

create table public.players (
  name text primary key,
  avatar text,
  hidden boolean not null default false,
  first_seen timestamptz not null default now()
);

create table public.games (
  id uuid primary key,
  player_name text not null references public.players (name) on update cascade,
  avatar text,
  mode text not null default 'solo' check (mode in ('solo', 'tournament')),
  input text check (input in ('keyboard', 'mouse', 'touch', 'controller')),
  status text not null default 'started' check (status in ('started', 'finished', 'quit')),
  score integer not null default 0 check (score >= 0),
  wave integer not null default 1,
  overdrive integer not null default 0,
  waves_cleared integer not null default 0,
  kills integer not null default 0,
  shots integer not null default 0,
  hits integer not null default 0,
  accuracy integer not null default 0,
  longest_combo integer not null default 0,
  powerups integer not null default 0,
  duration_s integer not null default 0,
  end_reason text,
  was_offline boolean not null default false,
  flagged boolean not null default false,
  flag_reason text,
  hidden boolean not null default false,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index games_started_at_idx on public.games (started_at);
create index games_player_name_idx on public.games (player_name);
create index games_board_idx on public.games (score desc)
  where status = 'finished' and not flagged and not hidden;

create table public.visits (
  id uuid primary key,
  screen text not null default 'own' check (screen in ('shared', 'own')),
  at timestamptz not null default now()
);
create index visits_at_idx on public.visits (at);

create table public.blocked_words (
  word text primary key,
  match text not null default 'contains' check (match in ('contains', 'exact'))
);
insert into public.blocked_words (word, match) values
  ('fuck', 'contains'), ('shit', 'contains'), ('bitch', 'contains'), ('cunt', 'contains'),
  ('nigger', 'contains'), ('nigga', 'contains'), ('faggot', 'contains'), ('whore', 'contains'),
  ('slut', 'contains'), ('rapist', 'contains'), ('nazi', 'contains'), ('hitler', 'contains'),
  ('asshole', 'contains'), ('bastard', 'contains'), ('pussy', 'contains'), ('porn', 'contains'),
  ('retard', 'contains'), ('tranny', 'contains'), ('kike', 'exact'), ('chink', 'exact'),
  ('spic', 'exact'), ('dick', 'exact'), ('cock', 'exact'), ('penis', 'exact'), ('rape', 'exact'),
  ('ass', 'exact'), ('sex', 'exact');

create table public.rate_counters (
  bucket text primary key,
  hits integer not null default 1,
  at timestamptz not null default now()
);

-- Row level security with no policies: nothing gets through without a function.
alter table public.app_settings enable row level security;
alter table public.players enable row level security;
alter table public.games enable row level security;
alter table public.visits enable row level security;
alter table public.blocked_words enable row level security;
alter table public.rate_counters enable row level security;

revoke all on public.app_settings, public.players, public.games, public.visits,
  public.blocked_words, public.rate_counters from anon, authenticated;

-- ------------------------------------------------------- private helpers

create function private.clean_name(p_name text) returns text
language sql immutable set search_path = '' as $$
  select upper(btrim(regexp_replace(normalize(coalesce(p_name, ''), NFC), '\s+', ' ', 'g')));
$$;

-- Returns why a cleaned name is refused, or null when it is fine.
create function private.name_problem(p_name text) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_plain text;
begin
  if char_length(p_name) < 1 then return 'name_missing'; end if;
  if char_length(p_name) > 20 then return 'name_too_long'; end if;
  if p_name ~ '[[:cntrl:]<>&"\\/{}\[\]]' then return 'name_invalid'; end if;
  v_plain := translate(lower(regexp_replace(p_name, '[ ._''’-]', '', 'g')), '013457@$', 'oieastas');
  if exists (
    select 1 from public.blocked_words w
    where (w.match = 'exact' and v_plain = w.word)
       or (w.match = 'contains' and position(w.word in v_plain) > 0)
  ) then
    return 'name_not_allowed';
  end if;
  return null;
end;
$$;

create function private.time_zone() returns text
language sql stable set search_path = '' as $$
  select time_zone from public.app_settings where id = 1;
$$;

create function private.today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone private.time_zone())::date;
$$;

create function private.local_day(p_at timestamptz) returns date
language sql stable set search_path = '' as $$
  select (p_at at time zone private.time_zone())::date;
$$;

-- Limits calls per address per minute. Only a one-way hash of the address is
-- stored, and it is removed within the hour.
create function private.rate_ok(p_action text, p_limit integer) returns boolean
language plpgsql set search_path = '' as $$
declare
  v_ip text;
  v_hits integer;
begin
  v_ip := split_part(coalesce(
    nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1);
  if v_ip = '' then return true; end if;
  insert into public.rate_counters as c (bucket)
  values (encode(sha256(convert_to(p_action || v_ip || to_char(now(), 'YYYYMMDDHH24MI'), 'UTF8')), 'hex'))
  on conflict (bucket) do update set hits = c.hits + 1
  returning hits into v_hits;
  delete from public.rate_counters where at < now() - interval '1 hour';
  return v_hits <= p_limit;
end;
$$;

-- Games that count: finished, not flagged, not hidden.
create function private.visible_games(p_scope text) returns setof public.games
language sql stable set search_path = '' as $$
  select g.*
  from public.games g
  join public.players p on p.name = g.player_name
  where g.status = 'finished' and not g.flagged and not g.hidden and not p.hidden
    and (p_scope <> 'today' or private.local_day(g.started_at) = private.today());
$$;

-- Where a game's player stands on today's board, using their best game today.
create function private.standing(p_id uuid) returns json
language sql stable set search_path = '' as $$
  with me as (
    select * from public.games where id = p_id
  ), best as (
    select distinct on (v.player_name) v.player_name, v.score, v.started_at
    from private.visible_games('today') v
    order by v.player_name, v.score desc, v.started_at asc
  ), ranked as (
    select b.*, row_number() over (order by b.score desc, b.started_at asc) as rank from best b
  ), mine as (
    select r.* from ranked r, me where r.player_name = me.player_name
  ), above as (
    select r.player_name, r.score from ranked r, mine m where r.rank = m.rank - 1
  )
  select json_build_object(
    'ok', true,
    'game_id', p_id,
    'status', (select status from me),
    'flagged', (select flagged from me),
    'score', (select score from me),
    'rank', (select rank from mine),
    'best', (select score from mine),
    'is_best', (select me.score >= mine.score from me, mine),
    'players_today', (select count(*) from ranked),
    'next_name', (select player_name from above),
    'next_score', (select score from above)
  );
$$;

-- Run this once in the SQL editor to create or replace the private report link.
-- It returns the token that goes after /report# in the address.
create function private.rotate_report_secret() returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  update public.app_settings
     set report_secret_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex')
   where id = 1;
  return v_token;
end;
$$;

-- -------------------------------------------------------- public functions

-- Checks a name before a game starts and returns the player's best score.
create function public.check_name(p_name text) returns json
language plpgsql stable security definer set search_path = '' as $$
declare
  v_name text := private.clean_name(p_name);
  v_problem text := private.name_problem(v_name);
  v_best integer;
  v_games bigint;
  v_avatar text;
begin
  if v_problem is not null then
    return json_build_object('ok', false, 'error', v_problem);
  end if;
  select max(score), count(*) into v_best, v_games
    from private.visible_games('all') where player_name = v_name;
  select avatar into v_avatar from public.players where name = v_name and not hidden;
  return json_build_object('ok', true, 'name', v_name, 'best', v_best, 'games', v_games, 'avatar', v_avatar);
end;
$$;

create function public.record_visit(p_id uuid, p_screen text default 'own') returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.rate_ok('visit', 120) then return; end if;
  insert into public.visits (id, screen)
  values (p_id, case when p_screen = 'shared' then 'shared' else 'own' end)
  on conflict (id) do nothing;
end;
$$;

create function public.start_game(
  p_id uuid, p_name text, p_avatar text default null, p_mode text default 'solo', p_input text default null
) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := private.clean_name(p_name);
  v_problem text := private.name_problem(v_name);
  v_avatar text := nullif(left(coalesce(p_avatar, ''), 16), '');
begin
  if v_problem is not null then
    return json_build_object('ok', false, 'error', v_problem);
  end if;
  if not private.rate_ok('start', 60) then
    return json_build_object('ok', false, 'error', 'slow_down');
  end if;
  insert into public.players as pl (name, avatar) values (v_name, v_avatar)
  on conflict (name) do update set avatar = coalesce(excluded.avatar, pl.avatar);
  insert into public.games (id, player_name, avatar, mode, input)
  values (
    p_id, v_name, v_avatar,
    case when p_mode = 'tournament' then 'tournament' else 'solo' end,
    case when p_input in ('keyboard', 'mouse', 'touch', 'controller') then p_input end
  )
  on conflict (id) do nothing;
  return json_build_object('ok', true);
end;
$$;

-- Saves the end of a game. Calling it twice for one game changes nothing.
-- Games with impossible numbers are kept but flagged, which hides them.
create function public.finish_game(
  p_id uuid,
  p_status text default 'finished',
  p_score integer default 0,
  p_wave integer default 1,
  p_overdrive integer default 0,
  p_waves_cleared integer default 0,
  p_kills integer default 0,
  p_shots integer default 0,
  p_hits integer default 0,
  p_longest_combo integer default 0,
  p_powerups integer default 0,
  p_duration_s integer default 0,
  p_end_reason text default null,
  p_input text default null,
  p_was_offline boolean default false
) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_game public.games;
  v_score integer := greatest(coalesce(p_score, 0), 0);
  v_kills integer := greatest(coalesce(p_kills, 0), 0);
  v_shots integer := greatest(coalesce(p_shots, 0), 0);
  v_hits integer := greatest(coalesce(p_hits, 0), 0);
  v_combo integer := greatest(coalesce(p_longest_combo, 0), 0);
  v_duration integer := greatest(coalesce(p_duration_s, 0), 0);
  v_elapsed integer;
  v_reason text;
begin
  select * into v_game from public.games where id = p_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'unknown_game');
  end if;
  if v_game.status <> 'started' then
    return private.standing(p_id);
  end if;

  v_elapsed := extract(epoch from now() - v_game.started_at)::integer;
  -- Top value per kill is 40 points times the combo. Boss weak points give 50,
  -- bonus drones give 150 and beating the boss gives 1,500.
  if v_score::bigint > 40::bigint * v_kills * greatest(v_combo, 1)
      + 50::bigint * v_hits + 150::bigint * (v_duration / 5 + 1) + 1500 then
    v_reason := 'score_too_high';
  elsif v_combo > v_kills + 1 then
    v_reason := 'combo_too_high';
  elsif v_kills > greatest(v_duration, 1) * 20 then
    v_reason := 'too_fast';
  elsif v_duration > 21600 then
    v_reason := 'too_long';
  elsif not coalesce(p_was_offline, false) and v_duration > v_elapsed + 60 then
    v_reason := 'time_mismatch';
  end if;

  update public.games set
    status = case when p_status = 'finished' then 'finished' else 'quit' end,
    score = v_score,
    wave = greatest(coalesce(p_wave, 1), 1),
    overdrive = greatest(coalesce(p_overdrive, 0), 0),
    waves_cleared = greatest(coalesce(p_waves_cleared, 0), 0),
    kills = v_kills,
    shots = v_shots,
    hits = v_hits,
    accuracy = case when v_shots > 0 then least(round(v_hits * 100.0 / v_shots)::integer, 100) else 0 end,
    longest_combo = v_combo,
    powerups = greatest(coalesce(p_powerups, 0), 0),
    duration_s = v_duration,
    end_reason = left(p_end_reason, 40),
    input = case when p_input in ('keyboard', 'mouse', 'touch', 'controller') then p_input else input end,
    was_offline = coalesce(p_was_offline, false),
    flagged = v_reason is not null,
    flag_reason = v_reason,
    ended_at = now()
  where id = p_id;

  return private.standing(p_id);
end;
$$;

create function public.get_standing(p_id uuid) returns json
language sql stable security definer set search_path = '' as $$
  select private.standing(p_id);
$$;

-- p_scope: 'today' or 'all'. p_group: 'best' (one row per player) or 'every'.
create function public.get_leaderboard(
  p_scope text default 'today', p_group text default 'best', p_search text default null,
  p_limit integer default 100, p_offset integer default 0
) returns json
language sql stable security definer set search_path = '' as $$
  with v as (
    select * from private.visible_games(p_scope)
  ), picked as (
    select distinct on (case when p_group = 'best' then v.player_name else v.id::text end) v.*
    from v
    order by case when p_group = 'best' then v.player_name else v.id::text end, v.score desc, v.started_at asc
  ), ranked as (
    select p.*, row_number() over (order by p.score desc, p.started_at asc) as rank from picked p
  ), found as (
    select * from ranked r
    where nullif(btrim(coalesce(p_search, '')), '') is null
       or position(private.clean_name(p_search) in r.player_name) > 0
  )
  select json_build_object(
    'total', (select count(*) from found),
    'ranked_total', (select count(*) from ranked),
    'rows', coalesce((
      select json_agg(x order by x.rank) from (
        select f.rank, f.id as game_id, f.player_name as name, f.avatar, f.score, f.wave, f.overdrive,
               f.accuracy, f.longest_combo, f.duration_s, f.started_at
        from found f
        order by f.rank
        limit least(greatest(coalesce(p_limit, 100), 1), 1000) offset greatest(coalesce(p_offset, 0), 0)
      ) x
    ), '[]'::json)
  );
$$;

create function public.get_player_games(p_name text, p_scope text default 'all') returns json
language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(x order by x.started_at desc), '[]'::json) from (
    select v.id as game_id, v.score, v.wave, v.overdrive, v.accuracy, v.longest_combo, v.duration_s, v.started_at
    from private.visible_games(p_scope) v
    where v.player_name = private.clean_name(p_name)
    order by v.started_at desc
    limit 200
  ) x;
$$;

-- The private report. p_day is a calendar day in the report's time zone; leave
-- it null for today. p_all = true covers every day.
create function public.get_day_report(p_secret text, p_day date default null, p_all boolean default false)
returns json
language plpgsql stable security definer set search_path = '' as $$
declare
  v_settings public.app_settings;
  v_day date;
  v_all boolean := coalesce(p_all, false);
  v_result json;
begin
  select * into v_settings from public.app_settings where id = 1;
  if v_settings.report_secret_hash is null or p_secret is null
     or encode(sha256(convert_to(p_secret, 'UTF8')), 'hex') <> v_settings.report_secret_hash then
    return json_build_object('ok', false, 'error', 'bad_link');
  end if;
  v_day := coalesce(p_day, private.today());

  with g as (
    select g.*, g.started_at at time zone v_settings.time_zone as local_at
    from public.games g
    join public.players p on p.name = g.player_name
    where not g.hidden and not g.flagged and not p.hidden
      and (v_all or private.local_day(g.started_at) = v_day)
  ), f as (
    select * from g where status = 'finished'
  ), players as (
    select player_name,
           count(*) filter (where status = 'finished') as finished,
           max(waves_cleared) as cleared
    from g group by player_name
  ), hours as (
    select extract(hour from local_at)::integer as h, count(*) as n, max(score) as best
    from f group by 1
  ), best_each as (
    select distinct on (player_name) player_name, avatar, score
    from f order by player_name, score desc, started_at asc
  ), top_game as (
    select player_name, score from f order by score desc, started_at asc limit 1
  ), top_combo as (
    select player_name, longest_combo from f order by longest_combo desc, started_at asc limit 1
  ), visit_count as (
    select count(*) as n from public.visits v
    where v_all or private.local_day(v.at) = v_day
  )
  select json_build_object(
    'ok', true,
    'scope', case when v_all then 'all' else 'day' end,
    'day', v_day,
    'today', private.today(),
    'time_zone', v_settings.time_zone,
    'days', (
      select coalesce(json_agg(d order by d), '[]'::json) from (
        select distinct private.local_day(started_at) as d from public.games where status = 'finished'
        union select private.today()
      ) days
    ),
    'players', (select count(*) from players),
    'games', (select count(*) from f),
    'quit', (select count(*) from g where status = 'quit'),
    'flagged', (
      select count(*) from public.games x
      where x.flagged and (v_all or private.local_day(x.started_at) = v_day)
    ),
    'visits', greatest((select n from visit_count), (select count(*) from players)),
    'play_seconds', (select coalesce(sum(duration_s), 0) from f),
    'returning', (select count(*) from players where finished > 1),
    'avg_accuracy', (select coalesce(round(avg(accuracy))::integer, 0) from f),
    'kills', (select coalesce(sum(kills), 0) from f),
    'powerups', (select coalesce(sum(powerups), 0) from f),
    'top', (select json_build_object('name', player_name, 'score', score) from top_game),
    'best_combo', (select json_build_object('name', player_name, 'value', longest_combo) from top_combo),
    'hours', (select coalesce(json_agg(json_build_object('h', h, 'n', n, 'best', best) order by h), '[]'::json) from hours),
    'dots', (
      select coalesce(json_agg(json_build_object(
        't', extract(hour from d.local_at)::integer * 60 + extract(minute from d.local_at)::integer,
        's', d.score, 'n', d.player_name)), '[]'::json)
      from (select local_at, score, player_name from f order by score desc limit 3000) d
    ),
    'cleared', (
      select json_agg(k.c order by k.i) from (
        select i, (select count(*) from players where cleared >= i) as c from generate_series(1, 6) as i
      ) k
    ),
    'inputs', json_build_object(
      'keyboard', (select count(*) from f where input in ('keyboard', 'mouse')),
      'touch', (select count(*) from f where input = 'touch'),
      'controller', (select count(*) from f where input = 'controller')
    ),
    'top_players', (
      select coalesce(json_agg(json_build_object('name', t.player_name, 'avatar', t.avatar, 'score', t.score)
             order by t.score desc), '[]'::json)
      from (select * from best_each order by score desc limit 5) t
    )
  ) into v_result;

  return v_result;
end;
$$;

-- ------------------------------------------------------------------ grants

-- Supabase may grant new functions to anon by default, so start from nothing.
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.check_name(text), public.record_visit(uuid, text),
  public.start_game(uuid, text, text, text, text),
  public.finish_game(uuid, text, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer, text, text, boolean),
  public.get_standing(uuid), public.get_leaderboard(text, text, text, integer, integer),
  public.get_player_games(text, text), public.get_day_report(text, date, boolean)
  from public, anon, authenticated;

grant execute on function public.check_name(text), public.record_visit(uuid, text),
  public.start_game(uuid, text, text, text, text),
  public.finish_game(uuid, text, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer, text, text, boolean),
  public.get_standing(uuid), public.get_leaderboard(text, text, text, integer, integer),
  public.get_player_games(text, text), public.get_day_report(text, date, boolean)
  to anon;
