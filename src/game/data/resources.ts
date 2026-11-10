/** Tutte le risorse gestite dal castello. */
export const RESOURCE_IDS = [
  'coins',
  'wood',
  'stone',
  'gold',
  'charcoal',
  'lime',
  'grain',
  'vegetables',
  'hay',
  'meat',
  'milk',
  'cheese',
  'fish',
  'hides',
  'wool',
  'flour',
  'bread',
  'cloth',
  'iron',
  'weapons',
] as const;

export type ResourceId = (typeof RESOURCE_IDS)[number];
export type Resources = Record<ResourceId, number>;

export interface ResourceDef {
  id: ResourceId;
  name: string;
  icon: string;
  /** Prezzo base al mercato, in monete per unità. */
  basePrice: number;
  /** Se vero, è un cibo che la popolazione può mangiare. */
  food?: boolean;
  /** Frazione persa ogni giorno (deperibilità). */
  spoilage?: number;
}

export const RESOURCES: Record<ResourceId, ResourceDef> = {
  coins: { id: 'coins', name: 'Monete', icon: '🪙', basePrice: 1 },
  wood: { id: 'wood', name: 'Legna', icon: '🪵', basePrice: 4 },
  stone: { id: 'stone', name: 'Pietra', icon: '🪨', basePrice: 10 },
  gold: { id: 'gold', name: 'Oro', icon: '✨', basePrice: 40 },
  charcoal: { id: 'charcoal', name: 'Carbone', icon: '⚫', basePrice: 6 },
  lime: { id: 'lime', name: 'Calce', icon: '⚪', basePrice: 14 },
  grain: { id: 'grain', name: 'Grano', icon: '🌾', basePrice: 2, food: true, spoilage: 0.0005 },
  vegetables: { id: 'vegetables', name: 'Ortaggi', icon: '🥬', basePrice: 2, food: true, spoilage: 0.004 },
  hay: { id: 'hay', name: 'Fieno', icon: '🌿', basePrice: 1, spoilage: 0.001 },
  meat: { id: 'meat', name: 'Carne', icon: '🍖', basePrice: 5, food: true, spoilage: 0.006 },
  milk: { id: 'milk', name: 'Latte', icon: '🥛', basePrice: 2, food: true, spoilage: 0.02 },
  cheese: { id: 'cheese', name: 'Formaggio', icon: '🧀', basePrice: 6, food: true, spoilage: 0.001 },
  fish: { id: 'fish', name: 'Pesce', icon: '🐟', basePrice: 3, food: true, spoilage: 0.01 },
  hides: { id: 'hides', name: 'Pelli', icon: '🟫', basePrice: 5 },
  wool: { id: 'wool', name: 'Lana', icon: '🧶', basePrice: 4 },
  flour: { id: 'flour', name: 'Farina', icon: '🥣', basePrice: 3, spoilage: 0.002 },
  bread: { id: 'bread', name: 'Pane', icon: '🍞', basePrice: 5, food: true, spoilage: 0.012 },
  cloth: { id: 'cloth', name: 'Tessuto', icon: '🧵', basePrice: 9 },
  iron: { id: 'iron', name: 'Ferro', icon: '⛓️', basePrice: 12 },
  weapons: { id: 'weapons', name: 'Armi', icon: '🗡️', basePrice: 18 },
};

/** Risorse della filiera: nella barra compaiono solo quando servono (o se ne hai). */
export const CHAIN_IDS: ResourceId[] = ['flour', 'bread', 'cloth', 'iron', 'weapons'];

export const FOOD_IDS = RESOURCE_IDS.filter((id) => RESOURCES[id].food);

export function emptyResources(): Resources {
  return Object.fromEntries(RESOURCE_IDS.map((id) => [id, 0])) as Resources;
}

export type Cost = Partial<Resources>;

export function canAfford(stock: Resources, cost: Cost): boolean {
  return Object.entries(cost).every(([id, n]) => stock[id as ResourceId] >= (n ?? 0));
}

export function pay(stock: Resources, cost: Cost): void {
  for (const [id, n] of Object.entries(cost)) stock[id as ResourceId] -= n ?? 0;
}

export function formatCost(cost: Cost): string {
  return Object.entries(cost)
    .map(([id, n]) => `${RESOURCES[id as ResourceId].icon}${n}`)
    .join(' ');
}

/** Livelli di tassazione: moltiplicatore del gettito ed effetto sul contento della popolazione. */
export const TAX_LEVELS = [
  { id: 'none', name: 'Nessuna', icon: '🕊️', mul: 0, mood: 18 },
  { id: 'low', name: 'Bassa', icon: '🙂', mul: 0.5, mood: 8 },
  { id: 'normal', name: 'Normale', icon: '⚖️', mul: 1, mood: 0 },
  { id: 'high', name: 'Alta', icon: '💰', mul: 1.6, mood: -14 },
  { id: 'harsh', name: 'Esosa', icon: '🗡️', mul: 2.4, mood: -32 },
] as const;
