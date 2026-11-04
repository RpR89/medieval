-- Schema iniziale: profili giocatore e salvataggi.
-- Applicare con: supabase db push  (oppure incollarlo nel SQL Editor di Supabase)

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Profili visibili a tutti gli utenti autenticati"
  on public.profiles for select to authenticated using (true);

create policy "Ognuno modifica il proprio profilo"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- Crea il profilo alla registrazione, col nome passato in options.data.username
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table if not exists public.saves (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  slot smallint not null default 1 check (slot between 1 and 5),
  castle_name text not null default '',
  game_year integer not null default 900,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  unique (user_id, slot)
);

alter table public.saves enable row level security;

create policy "Leggi i tuoi salvataggi"
  on public.saves for select to authenticated using ((select auth.uid()) = user_id);
create policy "Crea i tuoi salvataggi"
  on public.saves for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Aggiorna i tuoi salvataggi"
  on public.saves for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Elimina i tuoi salvataggi"
  on public.saves for delete to authenticated using ((select auth.uid()) = user_id);
