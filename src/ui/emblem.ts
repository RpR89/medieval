import { FACTIONS, type FactionDef, type FactionId } from '../game/data/factions';
import { escapeHtml } from './dom';

/** Piccolo scudo con i colori e il simbolo dello schieramento. */
export function emblemHtml(id: FactionId | undefined, size = 22): string {
  const f: FactionDef | undefined = id ? FACTIONS[id] : undefined;
  if (!f) return '';
  const [a, b] = f.colors;
  return `<span class="emblem" style="--a:${a};--b:${b};width:${size}px;height:${Math.round(size * 1.15)}px;font-size:${Math.round(size * 0.55)}px" title="${escapeHtml(f.name)}">${f.symbol}</span>`;
}

/** Riepilogo di bonus e malus. */
export function factionTraitsHtml(f: FactionDef): string {
  return `<ul class="traits">${f.bonus.map((t) => `<li class="good">＋ ${escapeHtml(t)}</li>`).join('')}${f.malus
    .map((t) => `<li class="bad">－ ${escapeHtml(t)}</li>`)
    .join('')}</ul>`;
}
