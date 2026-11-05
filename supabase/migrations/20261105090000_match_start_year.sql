-- Anno di partenza delle partite multigiocatore (epoca scelta da chi crea la partita).
alter table public.matches add column if not exists start_year integer not null default 900
  check (start_year in (900, 1050, 1150, 1250, 1350));
