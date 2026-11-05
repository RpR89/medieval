/** Calendario di gioco: a velocità 1× un giorno dura SECONDS_PER_DAY secondi reali. */
/** Una stagione (90 giorni) dura 2,5 minuti a velocità 1×. */
export const SECONDS_PER_DAY = 150 / 90;
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

/** L'anno di gioco comincia in primavera: marzo è il primo mese. */
export const MONTHS = ['Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre', 'Gennaio', 'Febbraio'];

export function monthName(date: GameDate): string {
  return MONTHS[Math.min(11, Math.floor(date.dayOfYear / 30))];
}

export function formatDate(date: GameDate): string {
  return `${SEASON_ICONS[date.season]} ${SEASON_NAMES[date.season]} · ${monthName(date)} ${date.year}`;
}

/** Durata leggibile: giorni se brevissima, poi settimane, poi mesi. */
export function formatDuration(days: number): string {
  const d = Math.max(0, days);
  if (d < 10) return `${Math.max(1, Math.round(d))} ${Math.round(d) === 1 ? 'giorno' : 'giorni'}`;
  if (d < 45) return `${Math.round(d / 7)} settimane`;
  if (d >= 720) {
    const y = Math.round(d / 360);
    return `${y} anni`;
  }
  const m = Math.round(d / 30);
  return `${m} ${m === 1 ? 'mese' : 'mesi'}`;
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
