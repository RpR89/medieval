/** Calendario di gioco: a velocità 1× un giorno dura SECONDS_PER_DAY secondi reali. */
export const SECONDS_PER_DAY = 4;
export const DAYS_PER_SEASON = 90;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * 4;
export const START_YEAR = 900;
export const END_YEAR = 1400;

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

export const SEASON_NAMES: Record<Season, string> = {
  spring: 'Primavera',
  summer: 'Estate',
  autumn: 'Autunno',
  winter: 'Inverno',
};

export const SEASON_ICONS: Record<Season, string> = {
  spring: '🌸',
  summer: '☀️',
  autumn: '🍂',
  winter: '❄️',
};

export interface GameDate {
  year: number;
  season: Season;
  dayOfSeason: number;
  dayOfYear: number;
}

export function dateFromDays(totalDays: number): GameDate {
  const d = Math.floor(totalDays);
  const year = START_YEAR + Math.floor(d / DAYS_PER_YEAR);
  const dayOfYear = d % DAYS_PER_YEAR;
  const season = SEASONS[Math.floor(dayOfYear / DAYS_PER_SEASON)];
  return { year, season, dayOfSeason: dayOfYear % DAYS_PER_SEASON, dayOfYear };
}

export function formatDate(date: GameDate): string {
  return `${SEASON_ICONS[date.season]} ${SEASON_NAMES[date.season]}, giorno ${date.dayOfSeason + 1} — Anno ${date.year}`;
}

/** Giorni finali di ogni stagione in cui si sfuma nella successiva. */
export const SEASON_TRANSITION = 24;

/** Stagione corrente, successiva e quanto si è già passati alla successiva (0-1). */
export interface SeasonMix {
  from: Season;
  to: Season;
  t: number;
}

export function seasonMix(totalDays: number): SeasonMix {
  const doy = ((totalDays % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  const si = Math.min(3, Math.floor(doy / DAYS_PER_SEASON));
  const within = doy - si * DAYS_PER_SEASON;
  const start = DAYS_PER_SEASON - SEASON_TRANSITION;
  const x = within <= start ? 0 : (within - start) / SEASON_TRANSITION;
  return { from: SEASONS[si], to: SEASONS[(si + 1) % 4], t: x * x * (3 - 2 * x) };
}

/** Valore numerico interpolato tra le due stagioni. */
export function mixNumber(m: SeasonMix, table: Record<Season, number>): number {
  return table[m.from] + (table[m.to] - table[m.from]) * m.t;
}
