import type { Cost, ResourceId } from './resources';
import type { Season } from './calendar';

export type BuildingCategory =
  | 'fortification'
  | 'housing'
  | 'farming'
  | 'animals'
  | 'gathering'
  | 'industry'
  | 'trade'
  | 'military'
  | 'infrastructure';

export const CATEGORY_NAMES: Record<BuildingCategory, string> = {
  fortification: '🏰 Fortificazioni',
  housing: '🏠 Abitazioni',
  farming: '🌾 Agricoltura',
  animals: '🐄 Allevamento',
  gathering: '🌲 Raccolta',
  industry: '⚒️ Produzione',
  trade: '⚖️ Commercio',
  military: '⚔️ Esercito',
  infrastructure: '🛣️ Strade',
};

/** Dove si può costruire un edificio. */
export type PlacementRule =
  | 'land' // erba o terra battuta
  | 'rock' // tutta la superficie su roccia
  | 'goldVein' // almeno una casella con vena d'oro
  | 'nearForest' // terra, con bosco entro 2 caselle
  | 'nearWater' // terra, con fiume o mare entro 1 casella
  | 'river'; // sopra il fiume (ponti)

export type Species = 'cattle' | 'pigs' | 'goats';

export const SPECIES_NAMES: Record<Species, string> = {
  cattle: 'Bovini',
  pigs: 'Suini',
  goats: 'Caprini',
};

export type UnitType = 'infantry' | 'archers' | 'cavalry';

/** Moltiplicatori stagionali: [primavera, estate, autunno, inverno]. */
export type SeasonalCurve = [number, number, number, number];

export interface BuildingDef {
  id: string;
  name: string;
  category: BuildingCategory;
  description: string;
  /** Ingombro in caselle [larghezza x, profondità z]. */
  size: [number, number];
  cost: Cost;
  /** Anno da cui è disponibile (vedi epoche). */
  minYear: number;
  /** Anno dopo cui non è più costruibile (superato da tecniche migliori). */
  maxYear?: number;
  placement: PlacementRule;
  /** Lavoratori necessari a piena produzione. */
  workers: number;
  /** Posti letto offerti. */
  housing?: number;
  /** Produzione giornaliera a pieno organico. */
  produces?: Partial<Record<ResourceId, number>>;
  /** Consumo giornaliero a pieno organico. */
  consumes?: Partial<Record<ResourceId, number>>;
  seasonal?: SeasonalCurve;
  /** Valore difensivo contro gli assalti. */
  defense?: number;
  /** Punti vita (solo fortificazioni): gli assalti li riducono, si riparano. */
  hp?: number;
  /** Ruolo nella cinta muraria. */
  fort?: 'wall' | 'tower' | 'gate' | 'keep' | 'moat';
  /** Fa parte della rete stradale. */
  road?: boolean;
  /** Capacità di magazzino aggiunta a ogni risorsa. */
  storage?: number;
  /** Recinto per animali. */
  herd?: { species: Species; capacity: number; start: number };
  /** Abilita l'addestramento di questa unità. */
  trains?: UnitType;
  /** Abilita il mercato. */
  market?: boolean;
  /** Si può costruire una sola volta. */
  unique?: boolean;
  /** Si può "trascinare" per costruire file (mura, fossati). */
  draggable?: boolean;
  /** Tasse: moltiplicatore del gettito fiscale. */
  taxBonus?: number;
}

export const BUILDINGS: BuildingDef[] = [
  // ───── Fortificazioni ─────
  {
    id: 'keep_wood',
    fort: 'keep',
    hp: 300,
    name: 'Motta con torre lignea',
    category: 'fortification',
    description: 'Collina artificiale con torre in legno: il cuore del primo castello.',
    size: [3, 3],
    cost: { wood: 120, coins: 50 },
    minYear: 900,
    maxYear: 1150,
    placement: 'land',
    workers: 2,
    housing: 4,
    defense: 12,
    storage: 200,
    unique: true,
  },
  {
    id: 'keep_stone',
    fort: 'keep',
    hp: 1000,
    name: 'Mastio in pietra',
    category: 'fortification',
    description: 'Grande torre quadrata in pietra, residenza del signore e ultimo rifugio.',
    size: [3, 3],
    cost: { stone: 300, wood: 80, coins: 200 },
    minYear: 1050,
    placement: 'land',
    workers: 4,
    housing: 8,
    defense: 40,
    storage: 400,
    unique: true,
  },
  {
    id: 'palisade',
    fort: 'wall',
    hp: 60,
    name: 'Palizzata',
    category: 'fortification',
    description: 'Tronchi appuntiti piantati nel terreno. Economica ma fragile.',
    size: [1, 1],
    cost: { wood: 6 },
    minYear: 900,
    placement: 'land',
    workers: 0,
    defense: 1,
    draggable: true,
  },
  {
    id: 'tower_wood',
    fort: 'tower',
    hp: 140,
    name: 'Torre lignea',
    category: 'fortification',
    description: 'Torre di guardia in legno. Gli arcieri vi combattono meglio.',
    size: [2, 2],
    cost: { wood: 40 },
    minYear: 900,
    placement: 'land',
    workers: 0,
    defense: 5,
  },
  {
    id: 'gate_wood',
    fort: 'gate',
    hp: 90,
    name: 'Porta lignea',
    category: 'fortification',
    description: 'Ingresso fortificato nella palizzata.',
    size: [1, 1],
    cost: { wood: 25 },
    minYear: 900,
    placement: 'land',
    workers: 0,
    defense: 2,
  },
  {
    id: 'moat',
    fort: 'moat',
    name: 'Fossato',
    category: 'fortification',
    description: 'Fossato scavato attorno alle mura. Rallenta gli assalitori.',
    size: [1, 1],
    cost: { coins: 6 },
    minYear: 900,
    placement: 'land',
    workers: 0,
    defense: 1.5,
    draggable: true,
  },
  {
    id: 'wall_stone',
    fort: 'wall',
    hp: 220,
    name: 'Mura in pietra',
    category: 'fortification',
    description: 'Cortina muraria merlata con cammino di ronda.',
    size: [1, 1],
    cost: { stone: 12, coins: 2 },
    minYear: 1150,
    placement: 'land',
    workers: 0,
    defense: 4,
    draggable: true,
  },
  {
    id: 'tower_square',
    fort: 'tower',
    hp: 450,
    name: 'Torre quadrata',
    category: 'fortification',
    description: 'Torre di fiancheggiamento in pietra.',
    size: [2, 2],
    cost: { stone: 80, wood: 10 },
    minYear: 1150,
    placement: 'land',
    workers: 0,
    defense: 15,
  },
  {
    id: 'gate_stone',
    fort: 'gate',
    hp: 320,
    name: 'Porta in pietra',
    category: 'fortification',
    description: 'Arco in pietra con saracinesca.',
    size: [1, 1],
    cost: { stone: 30, wood: 15 },
    minYear: 1150,
    placement: 'land',
    workers: 0,
    defense: 6,
  },
  {
    id: 'tower_round',
    fort: 'tower',
    hp: 560,
    name: 'Torre circolare',
    category: 'fortification',
    description: 'Senza angoli morti, resiste meglio a scavi e arieti.',
    size: [2, 2],
    cost: { stone: 110, wood: 10 },
    minYear: 1250,
    placement: 'land',
    workers: 0,
    defense: 22,
  },
  {
    id: 'gatehouse',
    fort: 'gate',
    hp: 650,
    name: 'Corpo di guardia',
    category: 'fortification',
    description: 'Porta monumentale tra due torri, con caditoie e doppia saracinesca.',
    size: [2, 2],
    cost: { stone: 160, wood: 40, coins: 60 },
    minYear: 1250,
    placement: 'land',
    workers: 2,
    defense: 30,
  },

  // ───── Abitazioni ─────
  {
    id: 'hut',
    name: 'Capanna',
    category: 'housing',
    description: 'Abitazione contadina in legno e paglia.',
    size: [1, 1],
    cost: { wood: 15 },
    minYear: 900,
    placement: 'land',
    workers: 0,
    housing: 5,
  },
  {
    id: 'house',
    name: 'Casa in muratura',
    category: 'housing',
    description: 'Casa in pietra e legno con tetto in coppi.',
    size: [2, 1],
    cost: { stone: 30, wood: 20 },
    minYear: 1150,
    placement: 'land',
    workers: 0,
    housing: 12,
  },

  // ───── Agricoltura ─────
  {
    id: 'field_grain',
    name: 'Campo di grano',
    category: 'farming',
    description: 'Si raccoglie in estate. In inverno il campo riposa.',
    size: [3, 3],
    cost: { wood: 10, coins: 10 },
    minYear: 900,
    placement: 'land',
    workers: 4,
    produces: { grain: 2.4 },
    seasonal: [0.1, 1.8, 0.6, 0],
  },
  {
    id: 'field_vegetables',
    name: 'Orto',
    category: 'farming',
    description: 'Rape, cavoli, fave e cipolle: produce quasi tutto l\'anno.',
    size: [2, 2],
    cost: { wood: 8 },
    minYear: 900,
    placement: 'land',
    workers: 2,
    produces: { vegetables: 1.2 },
    seasonal: [0.8, 1.2, 1, 0.15],
  },
  {
    id: 'hay_meadow',
    name: 'Prato da fieno',
    category: 'farming',
    description: 'Fienagione in estate: il fieno nutre gli animali d\'inverno.',
    size: [3, 2],
    cost: { coins: 8 },
    minYear: 900,
    placement: 'land',
    workers: 2,
    produces: { hay: 3 },
    seasonal: [0.4, 2, 0.6, 0],
  },

  // ───── Allevamento ─────
  {
    id: 'pasture_cattle',
    name: 'Pascolo bovino',
    category: 'animals',
    description: 'Vacche e buoi: latte, carne e pelli. D\'inverno mangiano molto fieno.',
    size: [3, 3],
    cost: { wood: 30, coins: 60 },
    minYear: 900,
    placement: 'land',
    workers: 2,
    herd: { species: 'cattle', capacity: 10, start: 4 },
  },
  {
    id: 'pasture_pigs',
    name: 'Porcile',
    category: 'animals',
    description: 'I maiali si ingrassano in autunno nel bosco e si macellano a inizio inverno.',
    size: [2, 2],
    cost: { wood: 20, coins: 30 },
    minYear: 900,
    placement: 'land',
    workers: 1,
    herd: { species: 'pigs', capacity: 14, start: 5 },
  },
  {
    id: 'pasture_goats',
    name: 'Recinto caprino',
    category: 'animals',
    description: 'Capre robuste: latte e pelo, poche pretese.',
    size: [2, 2],
    cost: { wood: 15, coins: 25 },
    minYear: 900,
    placement: 'land',
    workers: 1,
    herd: { species: 'goats', capacity: 16, start: 6 },
  },
  {
    id: 'dairy',
    name: 'Caseificio',
    category: 'animals',
    description: 'Trasforma il latte deperibile in formaggio che si conserva.',
    size: [1, 1],
    cost: { wood: 25, stone: 10 },
    minYear: 900,
    placement: 'land',
    workers: 1,
    consumes: { milk: 2 },
    produces: { cheese: 0.5 },
  },

  // ───── Raccolta ─────
  {
    id: 'woodcutter',
    name: 'Taglialegna',
    category: 'gathering',
    description: 'Abbatte alberi nel bosco vicino.',
    size: [1, 1],
    cost: { wood: 10, coins: 5 },
    minYear: 900,
    placement: 'nearForest',
    workers: 2,
    produces: { wood: 2.5 },
    seasonal: [1, 1, 1.1, 0.8],
  },
  {
    id: 'hunter',
    name: 'Capanno del cacciatore',
    category: 'gathering',
    description: 'Caccia a cervi e cinghiali: carne e pelli. Meglio in autunno.',
    size: [1, 1],
    cost: { wood: 15 },
    minYear: 900,
    placement: 'nearForest',
    workers: 1,
    produces: { meat: 0.6, hides: 0.15 },
    seasonal: [0.7, 0.8, 1.4, 1],
  },
  {
    id: 'fisher',
    name: 'Capanno del pescatore',
    category: 'gathering',
    description: 'Pesca di fiume o di mare. D\'inverno si esce poco.',
    size: [1, 1],
    cost: { wood: 20 },
    minYear: 900,
    placement: 'nearWater',
    workers: 2,
    produces: { fish: 1.6 },
    seasonal: [1, 1.2, 1, 0.4],
  },
  {
    id: 'quarry',
    name: 'Cava di pietra',
    category: 'gathering',
    description: 'Estrae blocchi da costruzione. Va costruita sulla roccia.',
    size: [2, 2],
    cost: { wood: 30, coins: 20 },
    minYear: 900,
    placement: 'rock',
    workers: 4,
    produces: { stone: 2 },
    seasonal: [1, 1.1, 1, 0.6],
  },
  {
    id: 'gold_mine',
    name: 'Miniera d\'oro',
    category: 'gathering',
    description: 'Scavata su una vena aurifera. Consuma carbone per lampade e fusione.',
    size: [2, 2],
    cost: { wood: 60, stone: 40, coins: 80 },
    minYear: 900,
    placement: 'goldVein',
    workers: 5,
    consumes: { charcoal: 0.6 },
    produces: { gold: 0.25 },
  },

  // ───── Produzione ─────
  {
    id: 'charcoal_kiln',
    name: 'Carbonaia',
    category: 'industry',
    description: 'Cumulo di legna che brucia lentamente: legna → carbone.',
    size: [1, 1],
    cost: { wood: 20 },
    minYear: 900,
    placement: 'nearForest',
    workers: 1,
    consumes: { wood: 2 },
    produces: { charcoal: 0.8 },
  },
  {
    id: 'granary',
    name: 'Granaio',
    category: 'industry',
    description: 'Aumenta la capacità dei magazzini.',
    size: [2, 2],
    cost: { wood: 50, stone: 20 },
    minYear: 900,
    placement: 'land',
    workers: 1,
    storage: 400,
  },

  // ───── Commercio ─────
  {
    id: 'market',
    name: 'Mercato',
    category: 'trade',
    description: 'Permette di comprare e vendere merci e aumenta le tasse.',
    size: [2, 2],
    cost: { wood: 60, coins: 50 },
    minYear: 900,
    placement: 'land',
    workers: 2,
    market: true,
    taxBonus: 0.5,
    unique: true,
  },

  // ───── Esercito ─────
  {
    id: 'barracks',
    name: 'Caserma',
    category: 'military',
    description: 'Addestra la fanteria.',
    size: [2, 2],
    cost: { wood: 60, coins: 40 },
    minYear: 900,
    placement: 'land',
    workers: 1,
    trains: 'infantry',
  },
  {
    id: 'archery',
    name: 'Campo degli arcieri',
    category: 'military',
    description: 'Addestra gli arcieri, che difendono meglio dalle torri.',
    size: [2, 2],
    cost: { wood: 50, coins: 40 },
    minYear: 900,
    placement: 'land',
    workers: 1,
    trains: 'archers',
  },
  {
    id: 'stable',
    name: 'Scuderia',
    category: 'military',
    description: 'Addestra la cavalleria. I cavalli mangiano fieno.',
    size: [3, 2],
    cost: { wood: 80, stone: 20, coins: 80 },
    minYear: 900,
    placement: 'land',
    workers: 2,
    trains: 'cavalry',
  },

  // ───── Strade ─────
  {
    id: 'road',
    name: 'Strada sterrata',
    category: 'infrastructure',
    description: 'Collega gli edifici al castello o al mercato: chi è collegato produce il 15% in più.',
    size: [1, 1],
    cost: { coins: 1 },
    minYear: 900,
    placement: 'land',
    workers: 0,
    draggable: true,
    road: true,
  },
  {
    id: 'road_paved',
    name: 'Strada lastricata',
    category: 'infrastructure',
    description: 'Selciato in pietra: come la strada sterrata, ma i carri corrono di più (+25%).',
    size: [1, 1],
    cost: { stone: 3, coins: 1 },
    minYear: 1100,
    placement: 'land',
    workers: 0,
    draggable: true,
    road: true,
  },
  {
    id: 'bridge',
    name: 'Ponte in legno',
    category: 'infrastructure',
    description: 'Attraversa il fiume e prosegue la rete stradale.',
    size: [1, 1],
    cost: { wood: 18, coins: 4 },
    minYear: 900,
    placement: 'river',
    workers: 0,
    draggable: true,
    road: true,
  },
];

export const BUILDING_BY_ID: Record<string, BuildingDef> = Object.fromEntries(
  BUILDINGS.map((b) => [b.id, b]),
);

export function getBuilding(id: string): BuildingDef {
  const def = BUILDING_BY_ID[id];
  if (!def) throw new Error(`Edificio sconosciuto: ${id}`);
  return def;
}

export function isAvailable(def: BuildingDef, year: number): boolean {
  return year >= def.minYear && (def.maxYear === undefined || year < def.maxYear);
}

export function seasonIndex(season: Season): number {
  return ['spring', 'summer', 'autumn', 'winter'].indexOf(season);
}
