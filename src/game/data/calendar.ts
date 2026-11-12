/** Calendario di gioco: a velocità 1× un giorno dura SECONDS_PER_DAY secondi reali. */
/**
 * A velocità 1× una stagione dura un minuto, un anno quattro. Il calendario non è realistico (come i giorni):
 * l'economia è bilanciata per stagione, mentre la marcia degli eserciti è riscalata con TIME_SCALE
 * per avere la stessa velocità in tempo reale.
 */
export const TIME_SCALE = 2.5;
export const SECONDS_PER_DAY = 150 / 90 / TIME_SCALE;
/** Durante un assedio (giocatore singolo) il tempo scorre a questa frazione della velocità scelta. */
export const SIEGE_TIME = 0.5;
export const DAYS_PER_SEASON = 90;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * 4;
export const START_YEAR = 900;

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
  if (d < 10) {
    const n = Math.max(1, Math.round(d));
    return `${n} ${n === 1 ? 'giorno' : 'giorni'}`;
  }
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

export type WeatherId = 'clear' | 'rain' | 'snow';

export const WEATHER: Record<WeatherId, { name: string; icon: string }> = {
  clear: { name: 'Sereno', icon: '' },
  rain: { name: 'Pioggia', icon: '🌧️' },
  snow: { name: 'Neve', icon: '🌨️' },
};

/** Tempo di un giorno: deterministico (uguale per tutti i giocatori), cambia ogni sei giorni. */
export function weatherOf(totalDays: number): WeatherId {
  const n = Math.floor(totalDays / 6);
  const h = Math.sin(n * 12.9898 + 4.1) * 43758.5453;
  const r = h - Math.floor(h);
  const season = SEASONS[Math.floor((totalDays % DAYS_PER_YEAR) / DAYS_PER_SEASON)];
  if (season === 'winter') return r < 0.5 ? 'snow' : 'clear';
  if (season === 'summer') return r < 0.1 ? 'rain' : 'clear';
  return r < 0.38 ? 'rain' : 'clear';
}
