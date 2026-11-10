import { UPGRADE_BY_ID } from '../data/upgrades';

/**
 * Simulazione dell'assedio, pura e deterministica (dato il generatore casuale).
 * È pensata per essere eseguita anche su un server, per gli attacchi tra giocatori.
 *
 * Fasi: bombardamento (trabucchi) → avvicinamento sotto il tiro (fossato) →
 * assalto al punto più debole → battaglia nella breccia → ultima resistenza nel mastio.
 * Un castello ben costruito moltiplica la forza della guarnigione: difendere costa meno che attaccare.
 */

export type FortRole = 'wall' | 'tower' | 'gate' | 'keep';

export interface SiegeSegment {
  uid: number;
  defId: string;
  role: FortRole;
  hp: number;
  maxHp: number;
  upgrades: string[];
  /** Difesa base dell'edificio. */
  defense: number;
  /** Porta con un fossato davanti (per il ponte levatoio). */
  moatAhead?: boolean;
}

export interface Troops {
  infantry: number;
  archers: number;
  cavalry: number;
}

export interface DefenderSnapshot {
  segments: SiegeSegment[];
  /** La cinta muraria è chiusa attorno al mastio. */
  closed: boolean;
  /** Fossati: caselle, copertura del perimetro (0-1), profondità media (1-3), quota allagata e con pali (0-1). */
  moat: { tiles: number; coverage: number; depth: number; flooded: number; stakes: number };
  army: Troops;
  armory: boolean;
  /** Assedio a fasi: scale preparate (facilitano la scalata) e giorni di fame dei difensori. */
  ladders?: number;
  starving?: number;
  /** Moltiplicatori dello schieramento: forza della guarnigione e tiro degli arcieri. */
  defenseMul?: number;
  archerMul?: number;
  cistern: boolean;
  charcoal: number;
}

export interface AttackerArmy extends Troops {
  name: string;
  rams: number;
  trebuchets: number;
  /** Quota di perdite oltre la quale l'esercito si ritira (0-1). */
  morale: number;
  /** Formazione: quota di perdite da frecce subite (Testuggine = 0,5) e forza in mischia. */
  arrows?: number;
  melee?: number;
  /** Anno: decide quali tecniche d'assedio conosce l'esercito. */
  year?: number;
}

/** Tecniche d'assedio dell'attaccante, secondo epoca ed esercito. */
export function tacticsFor(a: AttackerArmy) {
  const year = a.year ?? 900;
  return {
    sappers: year >= 1000 && a.infantry >= 10,
    fire: year >= 1050 && a.archers >= 6,
    tower: year >= 1150 && a.infantry >= 20,
  };
}

/** Strutture di legno: le frecce incendiarie le bruciano. */
const WOODEN = new Set(['palisade', 'palisade_double', 'gate_wood', 'tower_wood', 'keep_wood', 'gate_strong']);

export type SiegeOutcome = 'repelled' | 'held' | 'sacked';

export interface SiegeResult {
  outcome: SiegeOutcome;
  rounds: number;
  log: string[];
  attackerLosses: Troops;
  defenderLosses: Troops;
  /** Nuovi punti vita dei segmenti danneggiati. */
  damage: Map<number, number>;
  charcoalUsed: number;
  breachUid?: number;
  /** Forze iniziali stimate, per il rapporto. */
  attackerPower: number;
  defenderPower: number;
}

const UNIT_HP = { infantry: 10, archers: 8, cavalry: 14 };
const MELEE = { infantry: 3, archers: 1.5, cavalry: 6 };
const GUARD = { infantry: 4, archers: 2, cavalry: 5 };

const has = (s: SiegeSegment, id: string) => s.upgrades.includes(id);

/** Quanto danno fa ogni fante, per turno, ai diversi materiali (la pietra si scalfisce appena). */
const INFANTRY_BREACH: Record<string, number> = {
  palisade: 1.0,
  palisade_double: 0.6,
  gate_strong: 0.45,
  wall_rubble: 0.25,
  wall_curtain: 0.07,
  wall_bastion: 0.04,
  tower_bastion: 0.05,
  gate_wood: 0.7,
  tower_wood: 0.6,
  wall_stone: 0.12,
  gate_stone: 0.2,
  gatehouse: 0.15,
  tower_square: 0.1,
  tower_round: 0.1,
};
/** Danno per turno di ogni ariete (micidiale sulle porte). */
const RAM_BREACH: Record<string, number> = {
  palisade: 10,
  palisade_double: 8,
  gate_strong: 13,
  wall_rubble: 6,
  wall_curtain: 3.5,
  wall_bastion: 2,
  tower_bastion: 1.5,
  gate_wood: 16,
  gate_stone: 14,
  gatehouse: 12,
  tower_wood: 8,
  wall_stone: 5,
  tower_square: 3,
  tower_round: 2,
};
const upFire = (s: SiegeSegment) => s.upgrades.reduce((a, u) => a + (UPGRADE_BY_ID[u]?.fire ?? 0), 0);
const upResist = (s: SiegeSegment) => s.upgrades.reduce((a, u) => a * (UPGRADE_BY_ID[u]?.resist ?? 1), 1);
const health = (s: SiegeSegment) => (s.maxHp > 0 ? Math.max(0, s.hp) / s.maxHp : 0);

function total(t: Troops) {
  return t.infantry + t.archers + t.cavalry;
}

function melee(t: Troops, cavalryFactor = 1) {
  return t.infantry * MELEE.infantry + t.archers * MELEE.archers + t.cavalry * MELEE.cavalry * cavalryFactor;
}

function guard(t: Troops) {
  return t.infantry * GUARD.infantry + t.archers * GUARD.archers + t.cavalry * GUARD.cavalry;
}

/** Applica `dmg` punti di danno alle truppe, in proporzione al numero di soldati. */
function casualties(t: Troops, dmg: number, losses: Troops) {
  const n = total(t);
  if (n <= 0 || dmg <= 0) return;
  for (const k of ['infantry', 'archers', 'cavalry'] as const) {
    if (!t[k]) continue;
    const share = (dmg * t[k]) / n;
    const dead = Math.min(t[k], share / UNIT_HP[k]);
    t[k] -= dead;
    losses[k] += dead;
  }
}

/** Esito di uno scontro diretto (legge del quadrato di Lanchester). Restituisce la quota sopravvissuta del vincitore. */
function battle(a: number, b: number): { aWins: boolean; survivors: number } {
  if (a <= 0) return { aWins: false, survivors: b > 0 ? 1 : 0 };
  if (b <= 0) return { aWins: true, survivors: 1 };
  const aWins = a >= b;
  const w = aWins ? a : b;
  const l = aWins ? b : a;
  return { aWins, survivors: Math.sqrt(w * w - l * l) / w };
}

export function resolveSiege(def: DefenderSnapshot, atkIn: AttackerArmy, rand: () => number): SiegeResult {
  const log: string[] = [];
  const atk: Troops = { infantry: atkIn.infantry, archers: atkIn.archers, cavalry: atkIn.cavalry };
  const gar: Troops = { ...def.army };
  const atkLoss: Troops = { infantry: 0, archers: 0, cavalry: 0 };
  const defLoss: Troops = { infantry: 0, archers: 0, cavalry: 0 };
  const segs = def.segments.map((s) => ({ ...s }));
  const damage = new Map<number, number>();
  const hit = (s: SiegeSegment, d: number) => {
    s.hp = Math.max(0, s.hp - d);
    damage.set(s.uid, s.hp);
  };
  const atkStart = total(atk);
  // La fame indebolisce i difensori
  const armoryMul = (def.armory ? 1.2 : 1) * (def.defenseMul ?? 1) * Math.max(0.5, 1 - (def.starving ?? 0) * 0.02);
  const arrowsF = atkIn.arrows ?? 1;
  const meleeF = atkIn.melee ?? 1;
  let charcoal = def.charcoal;
  let charcoalUsed = 0;
  let rounds = 0;

  const tac = tacticsFor(atkIn);
  const walls = () => segs.filter((s) => s.role === 'wall' && s.hp > 0);
  const towers = () => segs.filter((s) => s.role === 'tower' && s.hp > 0);
  const gates = () => segs.filter((s) => s.role === 'gate' && s.hp > 0);
  const keep = segs.find((s) => s.role === 'keep');

  const attackerPower = melee(atk) + atk.archers * 2 + atkIn.rams * 15 + atkIn.trebuchets * 25;
  const defenderPower = guard(gar) * armoryMul;
  log.push(`${atkIn.name}: ${Math.round(atk.infantry)} fanti, ${Math.round(atk.archers)} arcieri, ${Math.round(atk.cavalry)} cavalieri` +
    (atkIn.rams ? `, ${atkIn.rams} arieti` : '') + (atkIn.trebuchets ? `, ${atkIn.trebuchets} trabucchi` : '') + '.');

  const broken = () => total(atk) <= atkStart * (1 - atkIn.morale);

  /** Potenza di tiro dei difensori per turno. */
  const firepower = (atBase: boolean) => {
    const walkways = walls().filter((w) => has(w, 'walkway') || has(w, 'walkway_wood')).length;
    const wallShare = walls().length ? walkways / walls().length : 0;
    const tw = towers();
    const height = 1 + 0.5 * wallShare + Math.min(1, tw.length * 0.1);
    let f = gar.archers * 1.0 * height * armoryMul * (def.archerMul ?? 1) + gar.infantry * 0.25;
    for (const t of tw) f += (2 + upFire(t)) * health(t);
    // Le difese delle mura servono solo se ci sono uomini a presidiarle
    let structural = 0;
    for (const w of walls()) structural += upFire(w) * health(w);
    for (const g of gates()) if (!has(g, 'pitch')) structural += upFire(g) * health(g);
    f += Math.min(structural, (gar.archers + gar.infantry) * 0.6);
    if (atBase) f *= 1.15; // alla base delle mura si è più esposti
    return f;
  };

  // ───── 1. Bombardamento ─────
  if (atkIn.trebuchets > 0 && def.closed) {
    const targets = [...walls(), ...towers()];
    for (let r = 0; r < 3 && targets.length; r++) {
      for (let i = 0; i < atkIn.trebuchets; i++) {
        const t = targets[Math.floor(rand() * targets.length)];
        hit(t, 30 / upResist(t));
      }
    }
    log.push(`I trabucchi bersagliano le mura per tre giorni.`);
  }

  if (!def.closed) {
    // ───── Cinta aperta: si entra dal varco ─────
    log.push('La cinta muraria non è chiusa: il nemico entra dal varco senza dover assaltare le mura.');
    for (let r = 0; r < 2; r++) {
      rounds++;
      casualties(atk, firepower(false) * 0.6 * arrowsF, atkLoss);
    }
    if (broken()) {
      log.push('Le perdite sono troppe: il nemico si ritira.');
      return finish('repelled');
    }
  } else {
    // ───── 2. Avvicinamento sotto il tiro ─────
    const cov = def.moat.coverage;
    const exposure = 1 + cov * (0.25 + 0.25 * (def.moat.depth - 1) + 0.5 * def.moat.flooded + 0.3 * def.moat.stakes);
    const breachRate = (s: SiegeSegment) =>
      (atk.infantry * (INFANTRY_BREACH[s.defId] ?? 0.12) + atkIn.rams * (RAM_BREACH[s.defId] ?? 3) + atkIn.trebuchets * 10) / upResist(s);
    // Il nemico sceglie il punto che crolla prima
    const effective = (s: SiegeSegment) => {
      let e = s.hp / Math.max(0.1, breachRate(s));
      if (s.role === 'gate' && has(s, 'drawbridge') && s.moatAhead) e *= 1.5;
      return e;
    };
    const candidates = [...walls(), ...gates()];
    if (!candidates.length) candidates.push(...towers());
    const target = candidates.reduce((a, b) => (effective(b) < effective(a) ? b : a), candidates[0]);
    const drawbridge = target && target.role === 'gate' && has(target, 'drawbridge') && target.moatAhead;
    const approach = 2 + Math.round(cov * (def.moat.depth + (def.moat.flooded > 0.5 ? 1 : 0))) + (drawbridge ? 2 : 0);
    log.push(
      def.moat.tiles > 0
        ? `Il nemico attraversa il fossato${def.moat.flooded > 0.5 ? ' allagato' : ''} sotto il tiro (${approach} turni).`
        : `Il nemico avanza verso le mura sotto il tiro (${approach} turni).`,
    );
    const wooden = segs.filter((x) => WOODEN.has(x.defId) && x.role !== 'keep' && x.hp > 0);
    if (tac.fire && wooden.length) {
      log.push(def.cistern ? 'Gli arcieri nemici scagliano frecce incendiarie: le secchiate della cisterna spengono i focolai.' : 'Gli arcieri nemici scagliano frecce incendiarie: le strutture di legno prendono fuoco!');
    }
    for (let r = 0; r < approach && !broken(); r++) {
      rounds++;
      casualties(atk, firepower(false) * exposure * arrowsF, atkLoss);
      if (tac.fire) for (const w of wooden) hit(w, (atk.archers * 0.7 * (def.cistern ? 0.35 : 1)) / upResist(w));
      const cover = walls().some((w) => has(w, 'walkway')) ? 0.65 : 0.35;
      casualties(gar, atk.archers * 0.5 * (1 - cover), defLoss);
    }

    // ───── 3. Assalto al punto più debole ─────
    if (!broken() && target) {
      log.push(`L'assalto si concentra su: ${segmentName(target)}.`);
      if (tac.sappers && target.role !== 'gate') {
        if (def.moat.flooded > 0.5) log.push('I minatori vorrebbero scavare sotto le mura, ma il fossato allagato inonda le gallerie.');
        else if (segs.some((x) => x.hp > 0 && has(x, 'countermine'))) {
          log.push('I minatori scavano sotto le mura, ma le gallerie di contromina li intercettano: la mina crolla addosso a loro.');
          casualties(atk, total(atk) * UNIT_HP.infantry * 0.06, atkLoss);
        } else {
          log.push(`I minatori scavano una galleria sotto ${segmentName(target)} e ne danno fuoco ai puntelli: il tratto cede!`);
          hit(target, target.hp * 0.55);
        }
      }
      let pitchRounds = 0;
      if (target.role === 'gate' && has(target, 'pitch') && charcoal >= 10) {
        charcoal -= 10;
        charcoalUsed += 10;
        pitchRounds = 3;
        log.push('Dalle caditoie della porta si versa la pece bollente!');
      }
      for (let r = 0; r < 18 && target.hp > 0 && !broken(); r++) {
        rounds++;
        let f = firepower(true);
        if (pitchRounds > 0) {
          f += 15;
          pitchRounds--;
        }
        casualties(atk, f * arrowsF, atkLoss);
        hit(target, breachRate(target));
        casualties(gar, atk.archers * 0.3, defLoss);
      }
      if (target.hp <= 0) log.push(`Breccia aperta: ${segmentName(target)} crolla!`);
    }
    if (broken() || !target) {
      log.push(`Le perdite sono troppe: il nemico si ritira.`);
      return finish('repelled');
    }
    if (target.hp > 0) {
      // ───── Scalata con le scale: possibile, ma i difensori in alto hanno un grande vantaggio
      log.push('Le mura reggono: il nemico tenta la scalata con le scale.');
      rounds++;
      const walk = walls().length ? walls().filter((w) => has(w, 'walkway') || has(w, 'walkway_wood')).length / walls().length : 0;
      const height = 1.6 + 0.6 * walk + Math.min(0.6, towers().length * 0.1);
      // Salire sulle scale sotto il tiro costa caro prima ancora di arrivare in cima
      casualties(atk, total(atk) * UNIT_HP.infantry * (0.15 + 0.1 * walk), atkLoss);
      const d = guard(gar) * armoryMul * height + firepower(true);
      // Tante scale preparate durante l'assedio: si sale in più punti insieme
      let a = melee(atk, 0.2) * 0.6 * meleeF * (1 + Math.min(0.5, (def.ladders ?? 0) * 0.025));
      if (tac.tower) {
        if (def.moat.coverage >= 0.6 && def.moat.depth >= 2) log.push('La torre d\'assedio resta impantanata nel fossato profondo: non arriva alle mura.');
        else {
          log.push('Una torre d\'assedio mobile viene spinta fino alle mura: i fanti salgono al coperto.');
          a *= 1.5;
        }
      }
      const b = battle(d, a);
      if (b.aWins) {
        casualties(atk, total(atk) * UNIT_HP.infantry * 0.7, atkLoss);
        casualties(gar, total(gar) * UNIT_HP.infantry * (1 - b.survivors) * 0.6, defLoss);
        log.push('Gli assalitori vengono ricacciati giù dalle scale: il nemico si ritira.');
        return finish('repelled');
      }
      casualties(gar, total(gar) * UNIT_HP.infantry * 0.8, defLoss);
      casualties(atk, total(atk) * UNIT_HP.infantry * (1 - b.survivors), atkLoss);
      log.push('Il nemico conquista un tratto di mura e scende nella corte!');
      return breachFight(target.uid);
    }
    return breachFight(target.uid);
  }
  return breachFight(undefined);

  function breachFight(breachUid: number | undefined): SiegeResult {
    // ───── 4. Battaglia nella breccia (o nel varco) ─────
    const narrow = breachUid !== undefined ? 1.4 : 1.0;
    const d = guard(gar) * armoryMul * narrow;
    const a = melee(atk, breachUid !== undefined ? 0.5 : 1) * meleeF;
    const b = battle(d, a);
    rounds++;
    if (b.aWins) {
      const lostA = 1;
      casualties(atk, total(atk) * UNIT_HP.infantry * lostA, atkLoss);
      casualties(gar, total(gar) * UNIT_HP.infantry * (1 - b.survivors), defLoss);
      log.push('La guarnigione respinge il nemico nella mischia!');
      return finish('repelled', breachUid);
    }
    casualties(gar, total(gar) * 20, defLoss);
    casualties(atk, total(atk) * UNIT_HP.infantry * (1 - b.survivors), atkLoss);
    // ───── 5. Ultima resistenza nel mastio ─────
    if (keep && keep.hp > 0) {
      const keepPower = (keep.defense + keep.upgrades.length * 6) * health(keep) * 2;
      if (melee(atk, 0.3) < keepPower) {
        log.push('Il borgo è saccheggiato, ma il mastio resiste: il nemico se ne va con il bottino.');
        hit(keep, melee(atk) * 0.5);
        return finish('held', breachUid);
      }
      hit(keep, keep.hp * 0.7);
    }
    log.push('Il castello è stato espugnato!');
    return finish('sacked', breachUid);
  }

  function finish(outcome: SiegeOutcome, breachUid?: number): SiegeResult {
    const round = (t: Troops) => ({ infantry: Math.round(t.infantry), archers: Math.round(t.archers), cavalry: Math.round(t.cavalry) });
    return {
      outcome,
      rounds,
      log,
      attackerLosses: round(atkLoss),
      defenderLosses: round(defLoss),
      damage,
      charcoalUsed,
      breachUid,
      attackerPower: Math.round(attackerPower),
      defenderPower: Math.round(defenderPower),
    };
  }
}

const NAMES: Record<string, string> = {
  palisade: 'la palizzata',
  palisade_double: 'la doppia palizzata',
  gate_strong: 'la porta ferrata',
  wall_rubble: 'il muro in pietrame',
  wall_curtain: 'la cortina',
  wall_bastion: 'le mura bastionate',
  tower_bastion: 'il torrione',
  wall_stone: 'le mura',
  gate_wood: 'la porta lignea',
  gate_stone: 'la porta in pietra',
  gatehouse: 'il corpo di guardia',
  tower_wood: 'la torre lignea',
  tower_square: 'la torre quadrata',
  tower_round: 'la torre circolare',
  keep_wood: 'la motta',
  keep_stone: 'il mastio',
};

function segmentName(s: SiegeSegment) {
  return NAMES[s.defId] ?? s.defId;
}
