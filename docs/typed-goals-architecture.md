# Evaluare arhitecturală: goal-uri tipizate (timer / journal / quiz / ...)

## Context

Vrem să atribuim un **tip per goal**, astfel încât pe lângă goal-urile de timer actuale să existe
goal-uri de journal (forțează un journal entry), goal-uri de quiz și altele. Întrebarea a fost: e
complicat de integrat, și dacă le-am trata ca pași intermediari între goal-uri?

Acest document este **doar o evaluare arhitecturală** — recomandarea de modelare plus riscurile de
urmărit. Nu conține pași de implementare.

## Concluzie scurtă

Nu e complicat din punct de vedere structural — **arhitectura existentă suportă deja conceptul aproape gratuit.**
Întregul cost real e în *semantica de completare per tip* și în *features-urile noi* (subsistemul quiz),
nu în "typing"-ul goal-urilor.

Observația cheie: **leaf-urile sunt deja o secvență liniară cu gating** (prev/next + verificarea că
predecesorul are `end_date` înainte de a putea porni următorul). Deci un **leaf tipizat ESTE deja un
pas intermediar** — nu trebuie inventată nicio entitate nouă. Cele două framing-uri din întrebare se
suprapun: un journal/quiz goal e pur și simplu un leaf cu alt tip, inserat în lanțul existent.

```
leaf A (timer) → leaf B (journal) → leaf C (timer)
                      ^ B e deja un pas intermediar gated, fără infrastructură nouă
```

## Recomandare de modelare: leaf tipizat (NU entitate pe muchie)

Adăugăm un discriminator `goal_type` pe `Goal`-ul existent (`c/ne/goal/goal-util.h:51-87`),
cu `GOAL_TYPE_TIMER = 0`. Motive pentru care asta câștigă net față de o entitate separată pe muchie:

- **Gating-ul există deja pe leaf-uri.** `EndGoalFromGoal` (goal.c) parcurge predecesorii și cere
  `end_date` pe fiecare. Un leaf tipizat moștenește gating-ul gratuit.
- **O singură cale de (de)serializare.** `SerializeGoalList` (`goal-util.c:198`) și field-loop-ul din
  `LoadJourneyFromBuffer` (`journey.c:339-382`) sunt singurele două locuri unde starea trece de disc.
  Un câmp nou atinge exact aceste două funcții.
- **Choke-point-ul de completare e deja centralizat și deja face validare condiționată.**
  `handle_post_goal_status_action` (`goal-handlers.c:361`) e singura intrare server pentru "end" și deja
  ramifică pe `goal_ended` cu precondiții (409 dacă nepornit / deja complet). Regulile per-tip intră
  direct aici — **nu e nevoie de infrastructură nouă de enforcement.**
- **Rendering-ul deosebește deja leaf vs non-leaf.** Un leaf tipizat rămâne un nod în `PathCanvas`,
  doar cu alt glyph/interacțiune.

O entitate pe muchie ar trebui filetată prin `GetLeafDueGoals`, schedule-system, central-server și
modelul `Goal` din React — fără niciun beneficiu, fiindcă pasul nu trebuie să existe independent de
poziția lui în lanț (adică exact ce e deja un leaf).

## Riscuri de urmărit (rankate)

### R1 — Bypass la completare / enforcement server-side (CEL MAI MARE)
Azi `EndGoalFromGoal` doar ștampilează `end_date`; singura validare e secvențierea. Un client ar putea
chema `/goal/end` pe un journal goal fără să fi scris vreodată un entry, sau pe un quiz fără răspuns.
- Enforcement-ul trebuie la **nivel de handler** (`handle_post_goal_status_action`), nu în goal core:
  pentru `JOURNAL` respinge "end" dacă goal-ul nu poartă un id de entry valid; pentru `QUIZ` dacă nu
  există înregistrare de răspuns/scor.
- **Capcană de layering:** goal core (`c/ne/goal/`) NU depinde acum de `c/journal/`. A pune un
  `JournalEntryExists()` acolo riscă include circular. Verificarea se face la nivel de handler
  (`goal-handlers.c` are deja acces la ambele lumi via `internal.h`). Goal core rămâne agnostic de tip.
- **Invariant de documentat:** `refresh_goal_completion_from_children_upwards` (`goal.c:371`)
  auto-completează părinții. Leaf-urile tipizate NU trebuie auto-completate niciodată — trebuie să
  treacă mereu prin handler. (E safe azi fiindcă roll-up-ul pornește doar când copiii au deja `end_date`.)

### R2 — Decompose & operații timer-centrice aplicate pe leaf-uri tipizate (MARE)
Trei căi presupun că orice leaf e un timer decompozabil:
- `serialize_goal_children_json` (`goal-handlers.c:227-229`) **auto-decompune la citire** orice leaf cu
  `required_time >= 15min`. Un journal goal cu timp mare ar fi spart silențios în copii timer.
  Trebuie guard: skip auto-decompose când `goal_type != TIMER`.
- `handle_post_goal_decompose` / `DecomposeGoal` (`goal-ai.c`) — trebuie să respingă goal-urile tipizate.
- `ExtendGoalLeaf` (+5-10min) e fără sens pentru journal/quiz; `ReshapeGoalLeaf` nu trebuie să schimbe tipul.
- **Schedule system** (`schedule-system.c`) însumează `required_time` al leaf-urilor. Un leaf tipizat
  are nevoie totuși de un `required_time` (chiar nominal/mic) ca să nu distorsioneze timeline-ul.

### R3 — Backward compatibility (MEDIU, dar ieftin)
Nu există framework de migrare, dar nici nu e nevoie. Loader-ul face `calloc(1, sizeof(Goal))` și setează
câmpuri doar dacă cheia JSON e prezentă (exact ca `assigned_to`, default-at înainte de field-loop).
Cu `GOAL_TYPE_TIMER = 0`, fișierele vechi (fără cheie) deserializează ca TIMER fără migrare. Singura
grijă: alege deliberat 0 = TIMER ca zero-value-ul să fie comportamentul legacy safe.

### R4 — Legătura inversă Goal → Journal (MEDIU)
Sistemul de embed e uni-direcțional (journal embed-uie un snapshot de goal). Avem nevoie de invers: un
journal goal stochează id-ul entry-ului produs. `JournalCreate` (`journal-handlers.c:69`) întoarce deja
`JournalMeta m` cu `m.id` — exact id-ul de stocat înapoi pe goal. Flow: client deschide pasul → creează
entry via `/journal/create` → primește `entry_id` → cheamă `/goal/end` cu `entry_id` → handler-ul
validează și îl scrie pe goal înainte de `end_date`. Astfel "journal goal complet?" == "are un `produced_ref` valid?".

### R5 — Shared journeys (MEDIU)
`assigned_to` leagă fiecare leaf de un participant; `GetLeafDueGoals` filtrează pe participant.
- Entry-ul de journal produs trăiește sub `data/users/<id>/journal/...` al *acelui* participant —
  id-ul invers e rezolvabil doar pentru proprietar. Vizualizarea cross-participant ("ce a scris partenerul")
  trebuie exclusă explicit, altfel scurgi journal-uri private.
- Un journal leaf assigned lui B blochează leaf-ul downstream al lui A (gating existent) — de confirmat ca decizie.
- `PushJourneyToCentral` / `FetchSharedJourney` rulează pe start/end. `goal_type` și `produced_ref`
  TREBUIE incluse în serializarea către central, altfel se pierd la round-trip.

### R6 — Authoring & proveniența conținutului de quiz (MEDIU, decizie de produs)
- Cine inserează leaf-urile tipizate? (a) AI decomposition, (b) user manual, (c) onboarding template.
  Cea mai mică risc e (b) manual + `goal_type` acceptat pe `/goal/create`. Authoring-ul AI (a) e riscant
  fiindcă math-ul de growth-tolerance al decompoziției e calibrat pe durate de timer.
- Conținutul de quiz e greenfield — recomandat stocat **în afara struct-ului Goal** (fișier sibling în
  dir-ul journey-ului, cheiat după id-ul goal-ului, analog cu `meta.json`/`embeds.json` la journal).
  Goal-ul poartă doar `goal_type = QUIZ` + un ref. Așa serializarea de goal rămâne mică.

### R7 — FocusSession e hardcodat pe timer (MIC-MEDIU)
`focus-session.tsx` e un timer full-screen cu hold-to-complete. Un journal goal trebuie rutat la flow-ul
existent `journal-view.tsx`, iar un quiz goal la un view nou. `App.tsx runGoalAction` cheamă acum
`/goal/start` apoi `/goal/end`; pentru tipuri "complet" nu mai e "release la hold" ci "entry creat" /
"quiz trimis". Conținut în dispatch-ul frontend (switch pe `goal_type`) + adăugarea `goal_type` în
modelul `Goal` din `goal.ts`.

## Efort relativ pe faze (pentru context, nu ca plan de execuție)

- **Faza 0 — plumbing câmp `goal_type`** (≈1): câmp + serializer + loader + export central + model React.
  Fără schimbare de comportament; toate goal-urile existente devin TIMER. Plus guard-urile R2 din ziua 1.
- **Faza 1 — journal goal end-to-end** (≈2): reutilizează cel mai mult (subsistemul journal există).
  Câmp `produced_ref`, enforcement la handler (R1), flow create→entry→end, dispatch frontend către `journal-view.tsx`.
- **Faza 2 — quiz goal** (≈3-4): greenfield (model + storage + authoring + view + grading). Integrarea
  în typing e doar "încă un case în switch" — exact de ce câștigă abordarea leaf tipizat.

Alegerea de modelare (leaf tipizat) e cea care ține costul de *integrare* al Fazelor 1 și 2 aproape constant.

## Fișiere centrale relevante (referință)

- `c/ne/goal/goal-util.h:51-87` — struct `Goal` (unde ar sta `goal_type`, `produced_ref`)
- `c/ne/goal/goal-util.c:198-266` — `SerializeGoalList`
- `c/srv/user/journey.c:331-382` — field-loop de deserializare (pattern-ul default via `calloc`)
- `c/srv/http-server/goal-handlers.c:361-412` — `handle_post_goal_status_action` (choke-point completare)
- `c/srv/http-server/goal-handlers.c:227-229` — `serialize_goal_children_json` (auto-decompose la citire)
- `c/journal/journal-handlers.c:69` — `JournalCreate` întoarce `m.id` (legătura inversă R4)
- `react/src/goal.ts` — modelul `Goal` din frontend
- `react/src/section/focus-session.tsx`, `react/src/section/journal-view.tsx` — dispatch-ul UI per tip
