/** Calendario di gioco: 1 secondo reale a velocità 1x = 1 giorno. */
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
