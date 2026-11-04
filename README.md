# Medieval — il castello dal 900 al 1400

Gestionale in tempo reale, in 3D nel browser. Costruisci e governa un castello medievale
attraverso cinque secoli: dalle motte con palizzate in legno ai castelli concentrici in pietra.

**Stack:** Vite + TypeScript + Three.js · Supabase (account, salvataggi, multiplayer Realtime) · Vercel (hosting).

## Cosa c'è già

- **Mappa 3D procedurale** (64×64): terreno continuo con rilievi, boschi misti, roccia con vene d'oro, fiume e mare.
- **Grafica**: texture generate dal codice (conci di pietra, assi, paglia, coppi, intonaco), modelli dettagliati e fusi in poche mesh, cielo fisico con riflessi, acqua con profondità e schiuma sulle rive, vento su alberi, erba e grano, ombre delle nuvole, neve che si posa su tetti e merli, occlusione ambientale e bloom. Qualità **Alta / Media / Bassa** dal pulsante 🎨.
- **Calendario e stagioni**: 1 secondo = 1 giorno a velocità 1×, con 4 stagioni da 90 giorni. Il paesaggio cambia colore e d'inverno nevica.
- **Epoche storiche** che sbloccano le tecniche: motte (900), mastio in pietra (1050), cinte murarie (1150), castello concentrico (1250), tardo Medioevo (1350).
- **Fortificazioni**: palizzate, mura in pietra (si collegano da sole ai vicini), torri lignee, quadrate e circolari, porte, corpo di guardia, fossati, motta e mastio. Mura e fossati si costruiscono trascinando.
- **Agricoltura stagionale**: grano (raccolto in estate), orti, prati da fieno.
- **Allevamento**: bovini, suini e caprini. Si riproducono in primavera, mangiano fieno o grano d'inverno e a inizio inverno si macellano. Il caseificio fa formaggio.
- **Raccolta**: taglialegna, caccia, pesca di fiume o di mare, cava di pietra, miniera d'oro, carbonaie.
- **Economia**: popolazione, alloggi, posti di lavoro, cibo (si consuma prima quello che deperisce), magazzini, tasse, deperimento delle merci.
- **Mercato**: prezzi che cambiano con le stagioni.
- **Esercito di base**: fanteria, arcieri (rendono di più con le torri) e cavalleria (mangia fieno), con paga giornaliera.
- **Assalti periodici**: ungari, vichinghi, baroni rivali, compagnie di ventura. Le difese sono messe a confronto con la forza del nemico.
- **Account e salvataggi**: login con Supabase e salvataggio nel cloud, oppure gioco da ospite con salvataggio nel browser. Salvataggio automatico ogni 30 secondi.
- **Multiplayer "Regno"** (Supabase Realtime): vedi chi è online, chat, classifica e carovane di merci da inviare agli altri giocatori.

## Comandi

```bash
npm install
npm run dev        # sviluppo su http://localhost:5173
npm test           # test della simulazione
npm run build      # typecheck + build di produzione in dist/
```

Senza variabili d'ambiente il gioco parte **offline**: si gioca come ospite e si salva nel browser.

## Configurazione

### 1. Supabase

1. Crea un progetto su [supabase.com](https://supabase.com).
2. Applica lo schema con uno dei due metodi:
   - incolla `supabase/migrations/20261104000000_init.sql` nel **SQL Editor**, oppure
   - usa la CLI: `supabase link --project-ref <ref>` e poi `supabase db push`.
3. In **Authentication → URL Configuration** imposta il dominio Vercel come *Site URL* e aggiungilo ai *Redirect URLs*.
4. In **Project Settings → API** copia la *Project URL* e la *anon/publishable key*.

La `service_role` key non va **mai** messa nel frontend.

### 2. Variabili d'ambiente

In locale copia `.env.example` in `.env.local`. Su Vercel vanno in **Settings → Environment Variables**:

| Variabile | Valore |
|---|---|
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | la anon/publishable key |

### 3. Vercel

Su vercel.com fai *Add New Project*, importa il repo e lascia le impostazioni rilevate (Vite, output `dist`). Ogni push fa un deploy, e ogni branch ha un'anteprima.

## Architettura

```
src/
  game/data/      dati di gioco: risorse, edifici, animali, unità, epoche, calendario
  game/world/     generazione procedurale del territorio
  game/sim/       simulazione (classe Game) — logica pura, senza grafica, testata
  render/         Three.js: scena, terreno e vegetazione, modelli, texture procedurali, effetti shader
  ui/             HUD, menu costruzioni, pannelli, schermata di accesso
  save/           salvataggi: browser (LocalSaveStore) e cloud (CloudSaveStore)
  net/            multiplayer: interfaccia RealmTransport + implementazione Supabase Realtime
supabase/migrations/   schema del database (profili, salvataggi, RLS)
tests/                 test Vitest della simulazione
```

- La **simulazione è separata dalla grafica**: `Game` si può testare e potrà girare anche su un server.
- I **modelli 3D sono procedurali** e fanno da segnaposto. Per usare modelli GLB (Blender, pacchetti CC0) basta far restituire a `buildModel()` in `src/render/models.ts` un modello caricato con `GLTFLoader`.
- Il **multiplayer** passa dall'interfaccia `RealmTransport`. Oggi ogni giocatore simula il proprio castello e il regno scambia presenza, chat e carovane. Per guerre tra giocatori, o per evitare che qualcuno bari, si aggiunge un server autoritativo (es. Colyseus su Fly.io) come seconda implementazione, perché Vercel non regge connessioni persistenti.

## Prossimi passi possibili

- Tempi di costruzione e cantieri, con lavoratori che si spostano.
- Personaggi animati (contadini, soldati) e percorsi.
- Battaglie visibili sulla mappa, assedi e macchine d'assedio.
- Altri prodotti: mulino e pane, birra, ferro e fabbro, lana e tessitura.
- Mappa condivisa del regno, diplomazia e guerra tra giocatori (server autoritativo).
- Modelli GLB e audio.
