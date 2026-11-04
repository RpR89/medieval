-- Partite multigiocatore a due: una riga per partita, una riga di stato per giocatore.
-- Applicare con: supabase db push  (oppure incollarlo nel SQL Editor di Supabase)

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  preset text not null default 'classica' check (preset in ('classica', 'pianura', 'montana', 'costa', 'valle')),
  seed integer not null,
  host_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  host_name text not null default '',
  guest_id uuid references auth.users (id) on delete set null,
  guest_name text,
  status text not null default 'waiting' check (status in ('waiting', 'active')),
  day double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists matches_open_idx on public.matches (status, created_at desc) where guest_id is null;

alter table public.matches enable row level security;

-- Si vedono le proprie partite e quelle aperte in attesa di un avversario
create policy "Vedi le tue partite e quelle aperte"
  on public.matches for select to authenticated
  using (
    (select auth.uid()) in (host_id, guest_id)
    or (status = 'waiting' and guest_id is null)
  );

create policy "Crea una partita come host"
  on public.matches for insert to authenticated
  with check (host_id = (select auth.uid()) and guest_id is null and status = 'waiting');

-- L'host aggiorna la sua partita (giorno, nome)
create policy "L'host aggiorna la partita"
  on public.matches for update to authenticated
  using (host_id = (select auth.uid()))
  with check (host_id = (select auth.uid()));

-- Unirsi: solo a una partita aperta, e solo come se stessi
create policy "Unisciti a una partita aperta"
  on public.matches for update to authenticated
  using (guest_id is null and status = 'waiting' and host_id <> (select auth.uid()))
  with check (guest_id = (select auth.uid()));

create policy "L'ospite aggiorna la partita"
  on public.matches for update to authenticated
  using (guest_id = (select auth.uid()))
  with check (guest_id = (select auth.uid()));

create policy "L'host elimina la partita"
  on public.matches for delete to authenticated
  using (host_id = (select auth.uid()));

-- Campi che non devono cambiare dopo la creazione (le policy non vedono il valore precedente)
create or replace function public.matches_guard()
returns trigger
language plpgsql
as $$
begin
  if new.host_id <> old.host_id or new.seed <> old.seed or new.preset <> old.preset or new.created_at <> old.created_at then
    raise exception 'Campi della partita non modificabili';
  end if;
  if old.guest_id is not null and new.guest_id is distinct from old.guest_id then
    raise exception 'La partita ha già un avversario';
  end if;
  -- Solo l'host fa avanzare il giorno della partita
  if new.day <> old.day and (select auth.uid()) <> old.host_id then
    raise exception 'Solo chi ha creato la partita ne tiene il tempo';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists matches_guard on public.matches;
create trigger matches_guard before update on public.matches
  for each row execute function public.matches_guard();

-- Stato del castello di ciascun giocatore nella partita
create table if not exists public.match_players (
  match_id uuid not null references public.matches (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

alter table public.match_players enable row level security;

create or replace function public.is_match_member(m uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.matches
    where id = m and (select auth.uid()) in (host_id, guest_id)
  );
$$;

create policy "I membri vedono gli stati della partita"
  on public.match_players for select to authenticated
  using (public.is_match_member(match_id));

create policy "Salva il tuo stato"
  on public.match_players for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_match_member(match_id));

create policy "Aggiorna il tuo stato"
  on public.match_players for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.is_match_member(match_id));
