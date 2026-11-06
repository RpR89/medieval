/** Tipi di mappa: cambiano rilievi, boschi, rocce, acque e posizione dei castelli. */
export type PresetId = 'classica' | 'pianura' | 'montana' | 'costa' | 'valle';

export interface MapPreset {
  id: PresetId;
  name: string;
  icon: string;
  description: string;
  /** Soglia del rumore oltre cui c'è bosco: più bassa = più boschi. */
  forest: number;
  /** Numero di affioramenti rocciosi [min, max] e raggio medio. */
  rocks: [number, number];
  rockRadius: number;
  /** Probabilità che un affioramento abbia una vena d'oro. */
  gold: number;
  sea: 'east' | 'south' | 'none';
  river: 'ns' | 'wide' | 'none';
  /** Ampiezza delle colline (0 = piatto). */
  hills: number;
}

export const PRESETS: Record<PresetId, MapPreset> = {
  classica: {
    id: 'classica',
    name: 'Terre di confine',
    icon: '🏰',
    description: 'Boschi, un fiume e il mare a est: la mappa equilibrata.',
    forest: 0.56,
    rocks: [3, 4],
    rockRadius: 2.6,
    gold: 0.35,
    sea: 'east',
    river: 'ns',
    hills: 0.04,
  },
  pianura: {
    id: 'pianura',
    name: 'Pianura',
    icon: '🌾',
    description: 'Campi aperti e pochi boschi: ottima per l\'agricoltura, poca pietra, difficile da difendere.',
    forest: 0.63,
    rocks: [2, 3],
    rockRadius: 2.2,
    gold: 0.25,
    sea: 'none',
    river: 'ns',
    hills: 0.02,
  },
  montana: {
    id: 'montana',
    name: 'Montana',
    icon: '⛰️',
    description: 'Rilievi, pietra e oro in abbondanza, boschi di conifere fitti: si costruiscono rocche formidabili.',
    forest: 0.5,
    rocks: [8, 11],
    rockRadius: 3.6,
    gold: 0.6,
    sea: 'none',
    river: 'ns',
    hills: 0.3,
  },
  costa: {
    id: 'costa',
    name: 'Costa',
    icon: '🌊',
    description: 'Il mare a sud: pesca abbondante e una barriera naturale alle spalle.',
    forest: 0.57,
    rocks: [3, 4],
    rockRadius: 2.5,
    gold: 0.35,
    sea: 'south',
    river: 'ns',
    hills: 0.05,
  },
  valle: {
    id: 'valle',
    name: 'Valle fluviale',
    icon: '🏞️',
    description: 'Un grande fiume divide le terre: servono ponti, e l\'acqua è un ottimo fossato.',
    forest: 0.56,
    rocks: [4, 5],
    rockRadius: 2.6,
    gold: 0.4,
    sea: 'none',
    river: 'wide',
    hills: 0.08,
  },
};

export const PRESET_LIST = Object.values(PRESETS);

/** Lato della mappa secondo il numero di castelli (giocatori e signori). */
export function mapSize(sites: number): number {
  // Mappe ampie: tra un castello e l'altro c'è spazio per campi, boschi ed esplorazione
  if (sites <= 1) return 112;
  if (sites === 2) return 128;
  if (sites === 3) return 144;
  if (sites === 4) return 160;
  return 176;
}

/** Centri dei siti dei castelli: due ai lati, tre o più in cerchio (il primo è il giocatore, a sud). */
export function siteCenters(size: number, sites: number): Array<[number, number]> {
  if (sites <= 1) return [[Math.round(size / 2), Math.round(size / 2)]];
  if (sites === 2) {
    return [
      [Math.round(size * 0.27), Math.round(size / 2)],
      [Math.round(size * 0.73), Math.round(size / 2)],
    ];
  }
  const r = size * 0.32;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < sites; i++) {
    const a = Math.PI / 2 + (i / sites) * Math.PI * 2;
    out.push([Math.round(size / 2 + Math.cos(a) * r), Math.round(size / 2 + Math.sin(a) * r)]);
  }
  return out;
}
