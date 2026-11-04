/**
 * Epoche storiche: sbloccano tecniche costruttive in modo plausibile
 * per l'Europa occidentale tra il 900 e il 1400.
 */
export interface Era {
  id: string;
  name: string;
  fromYear: number;
  description: string;
}

export const ERAS: Era[] = [
  {
    id: 'motte',
    name: 'Motte e palizzate',
    fromYear: 900,
    description: 'Castelli in legno e terra: palizzate, torri lignee, fossati scavati a mano.',
  },
  {
    id: 'stone_keep',
    name: 'Mastio in pietra',
    fromYear: 1050,
    description: 'Compaiono i grandi masti quadrati in pietra e le prime cinte murarie.',
  },
  {
    id: 'curtain',
    name: 'Cinte murarie',
    fromYear: 1150,
    description: 'Mura in pietra con torri di fiancheggiamento e porte fortificate.',
  },
  {
    id: 'concentric',
    name: 'Castello concentrico',
    fromYear: 1250,
    description: 'Torri circolari, doppie cinte, corpi di guardia (gatehouse) e barbacani.',
  },
  {
    id: 'late',
    name: 'Tardo Medioevo',
    fromYear: 1350,
    description: 'Mura più spesse e basse, prime difese contro la polvere da sparo.',
  },
];

export function eraForYear(year: number): Era {
  let current = ERAS[0];
  for (const era of ERAS) if (year >= era.fromYear) current = era;
  return current;
}
