/**
 * Musica medievale generativa con Web Audio: nessun file, nessuna licenza.
 *
 * Compone brani originali nello stile delle estampie del XIII secolo: frasi ripetute con
 * finale "aperto" e "chiuso", su modi antichi (dorico, misolidio, eolio, frigio).
 * Strumenti sintetizzati: bordone di cornamusa, flauto dolce, liuto e tamburello.
 */

export type Mood = 'spring' | 'summer' | 'autumn' | 'winter' | 'danger';

interface MoodDef {
  root: number; // nota MIDI della finale
  mode: number[];
  bpm: number; // battiti (ottavi) al minuto
  bar: number; // ottavi per battuta
  rhythms: number[][]; // figure ritmiche per battuta, in ottavi
  drum: number[]; // colpi di tamburo per battuta (posizioni in ottavi)
  flute: number; // volume del flauto
  lute: boolean;
  dronePitch: number; // semitoni del bordone sopra/sotto la finale
}

const MODES = {
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

const MOODS: Record<Mood, MoodDef> = {
  spring: { root: 62, mode: MODES.mixolydian, bpm: 300, bar: 6, rhythms: [[3, 3], [2, 1, 2, 1], [1, 1, 1, 3], [2, 1, 3]], drum: [0, 3], flute: 0.16, lute: true, dronePitch: -12 },
  summer: { root: 62, mode: MODES.dorian, bpm: 330, bar: 6, rhythms: [[2, 1, 2, 1], [1, 1, 1, 1, 2], [3, 2, 1], [2, 1, 3]], drum: [0, 2, 3, 5], flute: 0.17, lute: true, dronePitch: -12 },
  autumn: { root: 57, mode: MODES.dorian, bpm: 220, bar: 6, rhythms: [[3, 3], [2, 1, 3], [4, 2], [3, 1, 2]], drum: [0], flute: 0.15, lute: true, dronePitch: -12 },
  winter: { root: 64, mode: MODES.aeolian, bpm: 150, bar: 6, rhythms: [[6], [3, 3], [4, 2], [2, 4]], drum: [], flute: 0.13, lute: false, dronePitch: -24 },
  danger: { root: 52, mode: MODES.phrygian, bpm: 260, bar: 4, rhythms: [[1, 1, 2], [2, 2], [1, 1, 1, 1], [3, 1]], drum: [0, 1, 2, 3], flute: 0.12, lute: false, dronePitch: -12 },
};

const freq = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Note {
  deg: number; // grado della scala (0 = finale), anche negativo o oltre l'ottava
  len: number; // durata in ottavi
}

/** Una frase di 4 battute che chiude sul grado indicato (0 = "chiuso", 1 = "aperto"). */
function phrase(r: () => number, m: MoodDef, start: number, end: number): Note[] {
  const notes: Note[] = [];
  let deg = start;
  for (let bar = 0; bar < 4; bar++) {
    const rh = m.rhythms[Math.floor(r() * m.rhythms.length)];
    rh.forEach((len, i) => {
      const last = bar === 3 && i === rh.length - 1;
      if (last) deg = end;
      else {
        // Moto per gradi congiunti, con qualche salto; si torna verso il centro
        const leap = r() < 0.18 ? (r() < 0.5 ? 3 : -2) : r() < 0.5 ? 1 : -1;
        deg += leap;
        if (deg > 8) deg -= 2;
        if (deg < -2) deg += 2;
        // Nell'ultima battuta ci si avvicina alla nota finale
        if (bar === 3) deg = Math.round((deg + end) / 2) + (r() < 0.5 ? 1 : 0);
      }
      notes.push({ deg, len });
    });
  }
  return notes;
}

/** Un'estampie: due "puncta" (A, B), ciascuno ripetuto con finale aperto e chiuso. */
function compose(seed: number, m: MoodDef): Note[] {
  const r = rng(seed);
  const a = phrase(r, m, 4, 0);
  const b = phrase(r, m, 7, 0);
  const ouvert = (p: Note[]) => [...p.slice(0, -1), { deg: 1, len: p[p.length - 1].len }];
  return [...ouvert(a), ...a, ...ouvert(b), ...b, ...a];
}

function midiOf(m: MoodDef, deg: number): number {
  const n = m.mode.length;
  const oct = Math.floor(deg / n);
  const idx = ((deg % n) + n) % n;
  return m.root + oct * 12 + m.mode[idx];
}

export class Music {
  private ctx: BaseAudioContext | null = null;
  private master: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private mood: Mood = 'spring';
  private pending: Mood | null = null;
  private piece: Note[] = [];
  private pos = 0;
  private nextTime = 0;
  private barPos = 0;
  private seed = Math.floor(Math.random() * 1e6);
  private drone: { osc: OscillatorNode[]; gain: GainNode } | null = null;
  private volume = 0.6;
  enabled = true;

  constructor() {
    try {
      const v = localStorage.getItem('medieval.music');
      if (v === 'off') this.enabled = false;
    } catch {
      /* storage non disponibile */
    }
  }

  /** Va chiamato dopo un gesto dell'utente (i browser bloccano l'audio automatico). */
  start() {
    if (!this.enabled) return;
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume * 0.5;
      this.reverb = this.makeReverb(this.ctx);
      const wet = this.ctx.createGain();
      wet.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
      this.master.connect(this.reverb).connect(wet).connect(this.ctx.destination);
    }
    void (this.ctx as AudioContext).resume();
    if (this.timer) return;
    this.newPiece();
    this.nextTime = this.ctx.currentTime + 0.3;
    this.timer = setInterval(() => this.schedule(), 60);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopDrone();
    void (this.ctx as AudioContext | null)?.suspend();
  }

  /** Rende in memoria alcuni secondi di musica (per anteprime e prove). */
  async renderOffline(seconds: number, mood: Mood): Promise<AudioBuffer> {
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * 44100), 44100);
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume * 0.5;
    this.reverb = this.makeReverb(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.master.connect(ctx.destination);
    this.master.connect(this.reverb).connect(wet).connect(ctx.destination);
    this.mood = mood;
    this.pending = null;
    this.newPiece();
    this.nextTime = 0.2;
    this.scheduleUntil(seconds);
    return ctx.startRendering();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    try {
      localStorage.setItem('medieval.music', on ? 'on' : 'off');
    } catch {
      /* ignora */
    }
    if (on) this.start();
    else this.stop();
  }

  /** Cambia atmosfera: il brano in corso finisce la frase e poi passa al nuovo. */
  setMood(m: Mood) {
    if (m === this.mood && !this.pending) return;
    this.pending = m === this.mood ? null : m;
  }

  private newPiece() {
    if (this.pending) {
      this.mood = this.pending;
      this.pending = null;
    }
    this.seed++;
    this.piece = compose(this.seed, MOODS[this.mood]);
    this.pos = 0;
    this.barPos = 0;
    this.startDrone();
  }

  private makeReverb(ctx: BaseAudioContext): ConvolverNode {
    // Riverbero da sala in pietra: rumore che decade
    const len = ctx.sampleRate * 2.2;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    const c = ctx.createConvolver();
    c.buffer = buf;
    return c;
  }

  private startDrone() {
    const ctx = this.ctx!;
    const m = MOODS[this.mood];
    this.stopDrone();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(this.mood === 'winter' ? 0.035 : 0.05, ctx.currentTime + 2);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    filter.Q.value = 2;
    const oscs: OscillatorNode[] = [];
    for (const [semi, det] of [[m.dronePitch, 0], [m.dronePitch + 7, 3], [m.dronePitch, -4]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq(m.root + semi);
      o.detune.value = det;
      o.connect(filter);
      o.start();
      oscs.push(o);
    }
    filter.connect(gain).connect(this.master!);
    this.drone = { osc: oscs, gain };
  }

  private stopDrone() {
    if (!this.drone || !this.ctx) return;
    const { osc, gain } = this.drone;
    const t = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + 1.5);
    for (const o of osc) o.stop(t + 1.6);
    this.drone = null;
  }

  private schedule() {
    if (this.ctx) this.scheduleUntil(this.ctx.currentTime + 0.25);
  }

  /** Programma le note fino all'istante indicato. */
  private scheduleUntil(limit: number) {
    while (this.nextTime < limit) {
      const m = MOODS[this.mood];
      const eighth = 60 / m.bpm;
      if (this.pos >= this.piece.length) {
        // Pausa tra un brano e l'altro, poi un brano nuovo (eventualmente con un'altra atmosfera)
        this.nextTime += eighth * m.bar * 2;
        this.newPiece();
        continue;
      }
      // Cambio d'atmosfera a fine frase (ogni 4 battute)
      const n = this.piece[this.pos];
      const t = this.nextTime;
      this.flute(freq(midiOf(m, n.deg) + 12), t, n.len * eighth, m.flute);
      // Accompagnamento all'inizio di ogni battuta
      if (this.barPos % m.bar === 0) {
        if (m.lute) {
          const chord = [0, 4, 7].map((d) => midiOf(m, d));
          chord.forEach((c, i) => this.pluck(freq(c), t + i * eighth * 0.5, 0.09));
        }
      }
      for (const d of m.drum) {
        if (this.barPos % m.bar <= d && d < (this.barPos % m.bar) + n.len) {
          this.drum(t + (d - (this.barPos % m.bar)) * eighth, d === 0 ? 0.22 : 0.12);
        }
      }
      this.nextTime += n.len * eighth;
      this.barPos += n.len;
      this.pos++;
      if (this.pending && this.barPos % (m.bar * 4) === 0) {
        this.pos = this.piece.length;
      }
    }
  }

  /** Flauto dolce: triangolo con vibrato, attacco morbido e un filo di soffio. */
  private flute(f: number, t: number, dur: number, vol: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibG = ctx.createGain();
    vibG.gain.value = f * 0.006;
    vib.connect(vibG).connect(o.frequency);
    const g = ctx.createGain();
    const end = t + Math.max(0.12, dur * 0.95);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.04);
    g.gain.setValueAtTime(vol * 0.85, end - 0.05);
    g.gain.linearRampToValueAtTime(0, end);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    o.connect(lp).connect(g).connect(this.master!);
    o.start(t);
    vib.start(t);
    o.stop(end + 0.05);
    vib.stop(end + 0.05);
  }

  /** Liuto: corda pizzicata (onda ricca filtrata con decadimento rapido). */
  private pluck(f: number, t: number, vol: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(400, t + 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 1.2);
    o.connect(lp).connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + 1.25);
  }

  /** Tamburello: colpo grave + sonagli (rumore filtrato). */
  private drum(t: number, vol: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + 0.3);
    const len = Math.floor(ctx.sampleRate * 0.12);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const nz = ctx.createBufferSource();
    nz.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5000;
    const ng = ctx.createGain();
    ng.gain.value = vol * 0.25;
    nz.connect(hp).connect(ng).connect(this.master!);
    nz.start(t);
  }
}

/** Atmosfera adatta alla situazione di gioco. */
export function moodFor(season: 'spring' | 'summer' | 'autumn' | 'winter', danger: boolean): Mood {
  return danger ? 'danger' : season;
}
