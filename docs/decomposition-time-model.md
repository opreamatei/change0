# Modelul de timp & decompoziție al goal-urilor

Document despre revizia modelului de timp pentru goal-uri: ancorarea realistă a
estimării la rădăcină, gardarea creșterii de timp la descompunere printr-un AI
judge, și pragmatizarea prompt-urilor (agency, nu busywork).

## Problema rezolvată

Un începător care își făcea primul reel de Instagram primea un goal descompus în
**59 de noduri pe 5 niveluri** — total impractic. Cauza era modelul de timp, nu
un bug izolat:

1. **`CalcGoalRequiredTime` e un acumulator pur bottom-up** (`c/ne/goal/goal-util.c`).
   Părintele *devine* suma copiilor. Nu există plafon top-down.
2. **Descompunerea umfla timpul.** În `DecomposeGoal`, fiecare copil primea o
   estimare independentă de la AI, iar părintele era recalculat ca suma lor. Fiecare
   nivel era o ocazie ca totalul să *crească*, nu să se subîmpartă.
3. **Oprirea era doar pe dimensiunea frunzei** (`required_time < GOAL_MIN_SECONDS`).
   Niciun buget total / adâncime maximă.
4. **Rădăcina pleca deja umflată** (~62h pentru un reel de începător), fără anchor.
5. **Profilul nu influența magnitudinea** — semnalele de profil ajungeau doar în
   formularea subgoal-urilor, nu în timp/adâncime.

## A. Anchor realist la rădăcină

**Unde:** `CreateUserGoal` (`c/ne/goal/goal.c`), în interiorul buclei de extracție.

După `ExtractGoalFromText`, un judge nou validează estimarea root înainte de commit:

- AI call `goal_root_realism_judge` (schema în `goal.h`, prompt
  `GOAL_ROOT_REALISM_JUDGE_PROMPT` în `config.h`) → `{pass, suggested_estimated_time,
  feedback}`.
- Inputuri: title, extra_info (conține skill level / starting point) și semnalele de
  profil via `SerializeUserProfileDerivedSummary`.
- Logica în caller:
  - `pass` → se păstrează estimarea.
  - `!pass` + `suggested_estimated_time > 0` → se adoptă suggestion-ul pe loc (fără
    re-extracție).
  - `!pass` fără suggestion → feedback injectat, re-extracție (mărginit de
    `depth_error < 10`).

Judge-ul corectează în **ambele** direcții: prinde supra-estimarea (62h pentru un
reel) și sub-estimarea (timp prea scurt).

Implementare: `run_root_realism_judge()` în `goal.c`.

## B. Justificarea creșterii la descompunere

**Unde:** `DecomposeGoal` (`c/ne/goal/goal.c`), rescris.

### Toleranță funcție de timpul ABSOLUT (nu de adâncime)

Factorul relevant e mărimea absolută a goal-ului, nu adâncimea — două goal-uri la
depth 1 pot fi unul de 2h, altul de 2 luni. Funcția `goal_growth_tolerance(time_t
old_estimate)` (`goal-util.c`) întoarce o toleranță monoton crescătoare cu mărimea,
prin interpolare logaritmică:

```
GOAL_GROWTH_TOL_MIN          = 0.2          // goal-uri mici (<= SMALL)
GOAL_GROWTH_TOL_MAX          = 1.0          // goal-uri mari (>= BIG)
GOAL_GROWTH_TOL_SMALL_SECONDS = 2*3600      // 2h
GOAL_GROWTH_TOL_BIG_SECONDS   = 30*24*3600  // ~1 lună
GOAL_GROWTH_TOL_HARD_K        = 2.0

tol(old) = MIN + (MAX-MIN) * clamp01( log(old/SMALL) / log(BIG/SMALL) )
```

Valori: `tol(2h)=0.20`, `tol(1zi)=0.54`, `tol(1săpt)=0.80`, `tol(≥1lună)=1.00`.

### Cele trei zone

Pe raportul `new_total / old_estimate`, cu `T = goal_growth_tolerance(old_estimate)`:

| zonă | condiție | acțiune |
|---|---|---|
| 1. silent | `new_total ≤ old·(1+T)` | accept tăcut, **zero AI call** (libertatea) |
| 2. judge | `≤ old·(1 + HARD_K·T)` | `goal_decompose_growth_judge` trebuie să justifice |
| 3. hard cap | `> old·(1 + HARD_K·T)` | plafon dur → scalare proporțională |

Comportament verificat:
- `4 luni → 7 luni (1.75x)` = **SILENT** (fără probleme, exact intenția).
- `1h → 3h (3x)` = **HARD CAP** → scalat (un goal mic nu poate tripla).
- `1h → 1.3h` = **JUDGE** (trebuie justificat).

### Mecanism

- Descompunerea rulează pe **copii temporari** (`DecompChild`, parsare din JSON)
  înainte să se creeze vreun `Goal` în journey — astfel un split respins nu
  înregistrează niciodată goal-uri în container.
- Buclă mărginită de `GOAL_DECOMPOSE_MAX_JUDGE_ROUNDS` (= 3). La respingere,
  feedback-ul judge-ului e adăugat în prompt și se re-descompune mai slab.
- Fallback de terminare garantată: la epuizarea rundelor,
  `scale_decomp_children_to_budget()` scalează proporțional estimările copiilor ca
  să încapă în hard cap (pauzele se păstrează, doar `estimated_time` se comprimă).

Implementare: `run_decompose_growth_judge()`, `serialize_decomp_children()`,
`scale_decomp_children_to_budget()`, `free_decomp_children()` în `goal.c`.

## C. Pragmatizarea prompt-urilor (agency, nu busywork)

**Unde:** `DECOMPOSE_GOAL_AI_PROMPT` în `config.h`.

Prompt-ul vechi împingea spre filler („avoid overly trivial tasks", default 3-5h/child,
„split further"). Modificări:

- **Agency:** fiecare child goal trebuie să fie o acțiune reală pe care userul o face,
  nu un pas de meta-proces (handoff, prioritizare, audit).
- **Granularitate scalată cu miza:** goal hobby/începător → listă scurtă de acțiuni
  simple; rigoarea de pipeline profesional se rezervă pentru miză mare.
- **Anti-filler:** interzise pașii al căror unic output sunt note/handoff-uri/audit-uri.
- **Reframe la „split further":** spargem doar când un pas chiar nu încape într-o
  sesiune ȘI produce acțiuni distincte reale.
- **Exemple concrete inventate** băgate în prompt:
  - GOOD (reel insta începător): „Pick 3-5 stock clips that match your idea" ·
    „Add a music track and trim it to the reel length" · „Drop 2-3 sound effects on
    the main cuts" · „Export and watch it back once and fix the most obvious thing".
  - BAD (filler): „Prepare the raw timing handoff for prioritization" · „Group timing
    notes by section and problem type" · „Validate the final timing note handoff".

Aceleași principii sunt injectate în prompt-urile celor două judge-uri.

## Fișiere atinse

| Fișier | Schimbare |
|---|---|
| `c/ne/goal/goal-util.h` | constantele `GOAL_GROWTH_TOL_*` + declarație `goal_growth_tolerance` |
| `c/ne/goal/goal-util.c` | implementarea `goal_growth_tolerance` (interpolare log, `<math.h>`) |
| `c/ne/goal/goal.h` | `GOAL_DECOMPOSE_MAX_JUDGE_ROUNDS` + schemele celor două judge-uri |
| `c/ne/goal/goal.c` | gate-ul de realism (A), rescrierea `DecomposeGoal` (B), helperele de judge |
| `c/config.h` | rescrierea `DECOMPOSE_GOAL_AI_PROMPT` + cele două prompt-uri de judge |

## Note de implementare

- **Mock-ul a fost lăsat deoparte:** `ai_openai_call_gpt_request` lovește API-ul real;
  `mockopenai.c` e un layer de record/replay HTTP, nu un dispatcher pe `schema_name`,
  deci nu era nevoie de răspunsuri mock noi.
- Pattern-ul de judge reutilizează exact forma din `RepairGoalBranch`
  (`ai_openai_call_gpt_request` + schema `{pass, feedback}` + buclă de retry cu feedback).

## Verificare

- Build: `cmake --build build -j` — curat, fără erori/warnings pe `goal`.
- Math toleranță validat standalone: monoton crescătoare, `tol(2h)=0.2`,
  `tol(≥1lună)=1.0`, exemplele 4mo→7mo (silent) și 1h→3h (hard cap) corecte.
- End-to-end (de rulat cu API live, `./build.sh`): reluarea flow-ului → estimare root
  realistă (ore single-digit), număr de noduri mult sub 59, adâncime sub 5, pași
  concreți fără filler de proces.
