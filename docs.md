# CHANGE C Backend: documentatie tehnica de arhitectura

Acest document descrie in profunzime backend-ul C din proiectul `change`, cu accent pe:

- mecanismele principale;
- submecanismele interne;
- pipeline-urile de executie;
- fallback-urile si gardurile de siguranta;
- interconectarea dintre subsisteme;
- punctele unde AI-ul, stocarea pe disk, serverele HTTP si modelele de date se influenteaza reciproc.

Documentul acopera backend-ul C din `c/`. Frontend-ul React exista, dar nu este focusul aici.

## 1. Vedere de ansamblu

Sistemul este un backend local, monolitic, modularizat la nivel de biblioteci CMake. Functional, el este impartit in 6 straturi:

1. **Bootstrap si runtime shell**
   - `c/main.c`
   - `c/cli/ui.c`
2. **Model semantic intern**
   - `c/ne/node.*`
   - `c/ne/graph/*`
   - `c/ne/input/*`
3. **Model comportamental si temporal**
   - `c/ne/goal/*`
   - `c/journal/*`
4. **Orchestrare AI**
   - `c/middleware/*`
   - `c/ne/search/*`
   - `c/lib/openai/*`
5. **Expunere de retea**
   - `c/srv/http-server/*`
   - `c/srv/central-server/*`
6. **Persistenta si colaborare**
   - `c/srv/user/*`
   - `c/srv/match-system/*`

Arhitectura reala este una de tip:

- **stateful in-memory**, pentru operatiile active;
- **persistata pe disk**, pentru continuitate;
- **AI-assisted**, pentru decompozitie, deep-search, goal generation si middleware decisions;
- **event-driven**, pentru SSE si feedback incremental catre client.

## 2. Topologia runtime

Exista doua servere distincte:

1. **Central server** (`c/srv/central-server`)
   - port fix `8085` prin `CENTRAL_SERVER_PORT` in `c/config.h`;
   - gestioneaza userii, selectia userului activ, shared journeys, connections, mesaje, reviews.

2. **Client server per-user** (`c/srv/http-server`)
   - pornit pentru un user anume;
   - ideal pe port efemer (`start_server(0, user)`), apoi portul real se afla prin `client_server_port()`;
   - expune graph, goals, middleware chat, deep search, profile, schedule, journal, reminders.

Relatia dintre ele este importanta:

- central server-ul este meta-layer-ul;
- client server-ul este engine-ul operational pentru un singur user;
- selectarea unui user din central server porneste serverul client pentru acel user.

## 3. Bootstrap si initializare

### 3.1 Entry point

`c/main.c` porneste CLI-ul:

- `UIStart()`
- `UILoop()`
- `UIKill()`

CLI-ul este doar shell de control local. Logica reala este in modulele de backend.

### 3.2 Initializare in CLI

In `c/cli/ui.c`, `UIStart()`:

1. ruleaza `InitUserSystem()`;
2. selecteaza sau creeaza un user;
3. initializeaza context nodes prin `SetupContextNodes(&user->nodes)`;
4. initializeaza registrul global de pointeri;
5. publica emitters globali:
   - `ds_emit`
   - `goal_emit`
6. ruleaza `InitGoalSystem()`.

Aceasta ordine conteaza. Goal system si deep-search depind de:

- user system;
- graph state;
- emitteri globali.

## 4. Modelul de date central

### 4.1 User

`User` din `c/srv/user/user-management.h` este agregatul principal de runtime. Contine:

- identitate de baza: `id`, `name`, `port`;
- journeys active;
- `NodeContainer nodes` pentru semantic graph;
- schedule cache:
  - `schedule_table`
  - `schedule_len`
  - `schedule_needs_refresh`
- semnale de recalcul pentru goal health;
- stare de matching:
  - `discoverable`
  - `description`

Userul este, practic, containerul tuturor subsistemelor personale.

### 4.2 Semantic graph

`NodeContainer` din `c/ne/node.h` contine:

- vectorul de noduri;
- count/capacity;
- flag `needsRefresh`;
- `connection_count`;
- indecsii pentru cele 5 contexte:
  - `profession`
  - `emotion`
  - `passions`
  - `generalities`
  - `subjective`

Fiecare `Node` are:

- `label`;
- `_activation` si `_weight`;
- `times_seen`, `times_used`;
- timestamp-uri si pending touches;
- relatie de parent/children;
- lista de vecini (`Connection`).

### 4.3 Goal tree

`Goal` din `c/ne/goal/goal-util.h` este modelul ierarhic al muncii:

- `title`, `extra_info`;
- `required_time`;
- `start_date`, `end_date`;
- links structurale:
  - `parent`
  - `prev`
  - `next`
  - `subgoals`
- `depth`, `priority`, `retry_depth`;
- `journey_id`;
- `assigned_to` pentru shared journeys.

Structura combinata parent/children + prev/next permite doua moduri de traversare:

- ierarhic;
- secvential, pentru schedule.

## 5. Persistenta si layout-ul pe disk

Configurarea vine din `c/config.h`:

- `PROJECT_ROOT`
- `DATA_ROOT_DIRECTORY`
- `USER_DATA_DIRECTORY`
- `DEFAULT_DUMP_DIRECTORY`

Per-user exista fisiere standard:

- `graph-copy.json`
- `goals-copy.json`
- `user-profile.log`
- `.meta`
- director de `journal`

Modulele de user management construiesc path-urile prin helperi:

- `GetUserDirectory`
- `GetUserFilePath`
- `GetUserGraphExportPath`
- `GetUserJourneyPath`
- `GetUserProfileExportPath`
- `GetUserMetaPath`

Ideea de baza este simpla: starea activa e in memorie, dar fiecare agregat major poate fi exportat/reincarcat de pe disk.

## 6. Mecanismul semantic graph

### 6.1 Rol

Graph-ul semantic este memoria structurala a userului. El nu este doar un istoric textual; este o structura ponderata cu:

- semnale curente: `activation`;
- semnale stabile: `weight`.

### 6.2 Initializare si contexte

`SetupContextNodes()` creeaza cele 5 radacini de context. Orice nod util intra sub unul dintre aceste contexte.

Asta ofera doua proprietati:

1. acelasi label poate exista in contexte diferite;
2. scorurile se compun pe lantul de parinti.

### 6.3 Inserare si legare

`AddNodeEx()`:

- aloca nod nou;
- normalizeaza label-ul la lowercase;
- leaga la parinte daca exista;
- creeaza dictionar de copii pentru nodurile fertile.

`UniLinkEx()` / `BiLinkEx()` creeaza muchii cu:

- activation;
- weight;
- lastTouched;
- pendingTouches.

### 6.4 Semantica scorurilor

In `c/ne/node.c`:

- `read_node_activation()` si `read_node_weight()` multiplica valoarea locala cu lantul de parinti;
- acelasi model se aplica si pentru conexiuni.

Practic, un nod local mosteneste importanta contextuala de sus.

### 6.5 Refresh si decay

`RefreshGraph()` din `c/ne/graph/graph-engine.c` este mecanismul de rebalansare:

1. decaiaza activation in timp cu half-life `ACT_HALFTIME`;
2. aplica `pendingTouches`;
3. calculeaza support-ul fiecarui nod din vecini;
4. normalizeaza `times_seen`, `times_used`, `support`;
5. recomputa gradual `weight`.

Formula este controlata din `c/config.h` prin:

- `ACTIVATION_IMPORTANCE_TO_NODE_WEIGHT`
- `NCOUNT_PENALTY_TO_NODE_WEIGHT`
- `SUPPORT_MERIT_TO_NODE_WEIGHT`
- `NODE_OLD_WEIGHT_RELEVANCE`
- `ACT_HALFTIME`

### 6.6 Fallback-uri si limite

- daca nu exista noduri sau containerul nu e initializat, refresh-ul iese rapid;
- daca alocarea pentru support buffer esueaza, codul opreste executia prin assert;
- capacity-ul pentru noduri si vecini creste dinamic prin `realloc`.

Sistemul nu are fallback semantic offline; fallback-ul lui este unul de integritate: mai bine fail-fast decat graph corupt.

## 7. Input decomposition pipeline

### 7.1 Rol

`c/ne/input/input-processor.c` transforma textul liber al userului in actualizari de graph.

### 7.2 Pipeline

1. inputul este logat in profile history;
2. se construieste promptul `DECOMPOSITION_INTO_GRAPH_PROMPT`;
3. se face apel OpenAI cu schema stricta;
4. raspunsul brut OpenAI este parcurs pana la textul JSON validat;
5. JSON-ul este convertit in noduri/context nodes prin `AddContextNodesFromJSON()`.

### 7.3 Rolul submodulului `json-to-graph`

`c/ne/input/json-to-graph.*` este adaptorul dintre raspunsul AI si modelul de graph. El aplica euristici si constantele de relevanta pentru:

- weight initial de nod;
- weight initial de conexiune;
- pozitionarea nodurilor in context.

### 7.4 Fallback

Nu exista un fallback offline pentru decompozitie. Mecanismul folosit este:

- schema stricta pentru a reduce raspunsuri invalide;
- assert-uri pentru cazuri imposibile;
- profiling/logging pentru trasabilitate.

## 8. Deep Search

### 8.1 Rol

Deep Search este agentul de investigatie. El nu rezolva direct cererea userului; el colecteaza dovezi din:

- graph;
- goals;
- schedule;
- profile.

### 8.2 Componente

- `deep-search-session.*`
- `deep-search-execute.*`
- `command-parsing.*`
- `ai-action.*`
- `search.*`

### 8.3 Model de executie

Deep Search ruleaza iterativ:

1. prompt persistent din `DS_PERSISTENT_PROMPT`;
2. memorie dinamica acumulata in `DS_memory.dynamic`;
3. modelul alege exact o comanda JSON;
4. executorul ruleaza `run1 ... run9`;
5. output-ul se adauga in memoria dinamica;
6. ciclul continua pana cand AI-ul marcheaza `finished=true` si livreaza `conclusion`.

### 8.4 Tipuri de actiuni

Din schema din `deep-search-session.h` rezulta ca agentul poate:

- filtra global graph-ul;
- cauta vecini locali;
- face explorare recursiva;
- inspecta goals;
- inspecta schedule;
- inspecta profile sections;
- combina perspective structurale si comportamentale.

### 8.5 Judge intern

`deep-search-execute.c` include si un judge (`call_gpt_judge`) care verifica daca rezultatul este suficient de bun pentru taskul dat.

### 8.6 Fallback

Fallback-ul deep search nu inseamna model alternativ, ci control de traiectorie:

- schema stricta;
- comenzi finite, numerotate `1..9`;
- validare la parse;
- daca AI incearca sa termine fara concluzie, eroarea este injectata in memorie;
- runtime evidence este tratata ca autoritara.

## 9. Goal system

### 9.1 Rol

Goal system transforma intentiile in:

- root goals;
- subgoals secventiale;
- leaf sessions executabile.

Este al doilea model central al sistemului, dupa graph.

### 9.2 Pipeline de creare

`CreateUserGoal()`:

1. primeste `goal_input1` si `goal_input2`;
2. poate porni deep search pentru personalizare;
3. ruleaza adaptarea AI a goal-ului;
4. extrage root goal;
5. trece prin realism judge pentru estimarea initiala;
6. persista goal-ul;
7. ruleaza decompozitia pana la frunze.

### 9.3 Decompozitie

`DecomposeGoal()` si `DecomposeToLeaf()` sparg recursiv arborele.

In varianta actuala, descompunerea nu este lasata complet libera. Exista doua garduri:

1. **root realism judge**
   - valideaza timpul total initial;
2. **decompose growth judge**
   - verifica daca suma copiilor umfla nerealist parintele.

Detaliile sunt documentate separat in `docs/decomposition-time-model.md`.

### 9.4 Traversare si stare

Sistemul opereaza simultan pe:

- arbore de descompunere;
- lant secvential de frunze.

Asta permite:

- repararea unei ramuri;
- calculul urmatorului pas executabil;
- scheduling pe baza `prev`/`next`.

### 9.5 Operatii majore

- `CreateUserGoal`
- `RepairGoalBranch`
- `DropGoalTree`
- `StartGoal`
- `EndGoal`
- `ComputePartialDecomposition`
- `GetSessionGoals`

### 9.6 Fallback si guardrails

- numar limitat de runde pentru judge/retry;
- scale-down proportional daca decompozitia depaseste hard cap-ul;
- leaf-urile sunt tinute in plaja practica de timp;
- goal ID-urile trebuie sa fie exacte, nu sunt reconstruite euristic.

## 10. Goal health si schedule system

### 10.1 Rol

Schedule system-ul transforma goal tree-ul intr-o secventa temporala executabila.

### 10.2 Pipeline

`RefreshSchedule(User *user)`:

1. ruleaza `RunGoalHealthCheck(user)`;
2. goleste schedule cache-ul curent;
3. colecteaza due leaves din toate journey-urile userului;
4. parcurge fiecare lant secvential de frunze;
5. calculeaza `start_time` pentru fiecare goal;
6. umple `schedule_table`.

### 10.3 Logica de ancorare

Pentru fiecare leaf:

- daca este terminat si are succesor, sari la succesor;
- daca este activ (`start_date` set, `end_date` lipsa), anchor la `start_date`;
- daca e capat de lant si nimic nu a inceput, anchor la `change_time_now()`;
- altfel, anchor la `prev->end_date + pauseToNext`.

### 10.4 Cache invalidation

Schedule-ul nu se recalculeaza continuu. Se folosesc semnale:

- `schedule_needs_refresh`
- `goal_health_needs_refresh`

Acesta este mecanismul de decuplare dintre mutatii si recalcule scumpe.

### 10.5 Fallback

- daca nu exista due goals, schedule-ul devine gol si flag-ul se reseteaza;
- referintele rupte in arbore sunt tratate ca erori critice, nu sunt ignorate.

## 11. Middleware orchestration

### 11.1 Rol

Middleware-ul este orchestratorul conversational. El nu este chatbot generic; el decide actiuni controlate peste subsistemele interne.

### 11.2 Inputuri folosite

Promptul din `c/middleware/middleware.h` combina:

- inputul userului;
- istoric de sesiune;
- user profile summary;
- raw profile history;
- goal activity history;
- active goals;
- schedule snapshot;
- completed goals;
- stalled goals;
- retry feedback;
- deep search feedback.

### 11.3 Actiuni disponibile

Schema din `c/middleware/middleware.c` permite actiuni precum:

- `reply`
- `set_profile`
- `clear_profile`
- `ask_permission`
- `create_goal`
- `set_goal_priority`
- `call_deep_search`
- `update_graph`
- `delay_goal`
- `drop_goal`
- `repair_branch`
- `set_discoverable`
- `set_private`
- `update_match_description`
- `find_match`
- `set_reminder`

### 11.4 Bucla de retry

`RunClientMiddleware()` ruleaza pana la `MIDDLEWARE_MAX_RETRIES = 10`:

1. construieste contextul;
2. apeleaza modelul;
3. parseaza JSON-ul;
4. valideaza actiunile;
5. le aplica;
6. daca orice pas esueaza, construieste `retry_feedback` si repeta.

Acesta este unul dintre cele mai importante mecanisme de fallback din tot sistemul.

### 11.5 Permission gating

Exista doua cozi separate:

- `pending_permissions` pentru profile fields;
- `pending_reminders` pentru reminders.

Cheile sensibile:

- `age`
- `name`
- `location`
- `profession`

cer aprobare. Restul pot fi salvate silent daca promptul decide asta.

### 11.6 Session scoping

Session-urile middleware sunt namespaced per user:

- forma este `userId:sessionId`;
- istoricul si evenimentele sunt tinute in memorie;
- se pot exporta prin endpoint dedicat.

### 11.7 Interconectare

Middleware-ul este nodul de control care poate atinge aproape toate celelalte sisteme:

- profile;
- graph;
- goals;
- deep search;
- reminders;
- matching.

Este principalul punct de compozitie al backend-ului.

## 12. HTTP server si SSE

### 12.1 Routing

`c/srv/http-server/routes.c` mapeaza rutele catre handlere specializate. Domeniile principale sunt:

- `/graph/*`
- `/research/*`
- `/middleware/*`
- `/goal/*`
- `/profile/*`
- `/schedule*`
- `/journal/*`
- `/reminders/*`
- `/submissions/*`

### 12.2 Server lifecycle

`start_server()`:

- opreste instanta veche daca exista;
- initializeaza tabelul SSE;
- creeaza socket;
- incearca bind pe portul cerut;
- daca portul fix esueaza si nu era `0`, cade pe port efemer;
- porneste thread-ul de accept.

Acesta este un fallback operational explicit si important.

### 12.3 SSE

`c/srv/http-server/sse.c` gestioneaza clienti SSE:

- tabel fix de conexiuni;
- filtrare dupa `stream_id`;
- lock per client pentru scriere;
- `prune_dead_sse_clients()` trimite ping-uri si elimina conexiunile moarte.

SSE este canalul prin care clientul primeste:

- progres deep search;
- evenimente middleware;
- evenimente de goal.

### 12.4 Robustete

- `SIGPIPE` este ignorat pentru a evita terminarea procesului la reconnect-uri browser;
- clientii morti sunt eliminati activ;
- handlerele SSE returneaza keep-open doar pentru endpoint-urile stream.

## 13. Central server

### 13.1 Rol

Central server-ul este planul meta. El nu ruleaza direct graph/goal logic pentru requesturile lui, dar initiaza sistemele comune si coordoneaza accesul.

### 13.2 Ce initializeaza

In `start_central_server()`:

- `InitGlobalPointerMap()`
- emitter pointers
- `InitGoalSystem()`
- `InitUserSystem()`
- `InitConnectionSystem()`
- `init_shared_journeys()`
- `InitReviewSystem()`

### 13.3 Endpoint-uri cheie

- user management;
- selectarea userului;
- shared journeys;
- connections;
- messaging;
- submissions/reviews.

### 13.4 Interconectare

La pornire, daca exista useri, poate porni automat si client server-ul pentru primul user.

Asta inseamna ca central server-ul este bootstrapper-ul intregii platforme locale.

## 14. User management

### 14.1 Rol

User management reconstruieste si persista agregatele `User`.

### 14.2 Mecanisme

- `USER_TABLE[MAX_USERS]`
- cautare dupa `id` sau `name`
- `alloc_user_slot()`
- `NewUser()`
- `SaveUser()`
- `InitUserSystem()`

### 14.3 Guardrails

- `MAX_USERS`
- validare stricta pentru avatar path input (`avatar_safe_id`);
- path helpers centralizati pentru a evita concatenari riscante.

### 14.4 Interconectare

Acest modul este dependency direct pentru:

- graph;
- goals;
- middleware;
- HTTP handlers;
- matching;
- journal.

## 15. Journal si reminders

### 15.1 Journal

`c/journal/*` gestioneaza:

- create/read/update/delete entry;
- fisiere atasate;
- embed-uri catre goal-uri, alte entry-uri sau imagini.

`JournalMeta` retine:

- `id`
- `title`
- `mood_index`
- `last_updated`
- `icon_index`

### 15.2 Embeds

Embeds sunt legaturi usoare intre knowledge artifacts. Ele permit jurnalului sa devina strat de context peste goals si memorie.

### 15.3 Reminders

Reminders au propriul flux:

1. middleware poate propune reminder;
2. reminderul intra in coada de permission;
3. dupa aprobare, `RemindersSave()` persista datele.

Acest model mentine reminder-ele ca efect side-effect controlat, nu ca simplu text conversational.

## 16. Matching, connections si mesagerie

### 16.1 Rol

`c/srv/match-system/*` implementeaza matching intre useri discoverable.

### 16.2 Stare si persistenta

Fisierele sunt tinute sub:

- `data/users/connections/`

cu extensii:

- `.conn`
- `.msgs`

### 16.3 Pipeline

1. userul devine discoverable;
2. serverul salveaza descrierea interna;
3. `find_match` ruleaza AI matching pe candidati;
4. se dedupeaza rezultate;
5. se persista conexiunile/propunerile;
6. se pot aproba/declina;
7. dupa conectare, se poate trimite mesagerie.

### 16.4 Guardrails

- matching-ul este opt-in;
- descrierea este server-side only;
- promptul middleware interzice framing romantic;
- exista lock global pentru conexiuni (`conn_lock`).

## 17. OpenAI integration

### 17.1 Rol transversal

OpenAI este folosit in:

- input decomposition;
- middleware;
- deep search;
- goal creation;
- goal judges;
- matching.

### 17.2 Design

Fiecare subsistem important foloseste:

- prompt dedicat;
- schema JSON stricta;
- parsare valida;
- validare semantica locala.

### 17.3 Filosofie de fallback

Sistemul nu se bazeaza pe text liber "best effort". In schimb:

- constrange modelul cu schema;
- revalideaza server-side;
- repeta cu retry feedback;
- sau face fail-fast.

Este o filosofie corecta pentru un sistem AI orchestration stateful.

## 18. Global pointer map

`c/globals.*` expune un registry mic de pointeri globali.

El este folosit pentru a injecta dependinte runtime fara a introduce circularitati grele intre module, in special pentru:

- `ds_emit`
- `goal_emit`

Este un mecanism simplu, dar critic: permite propagarea emitters catre module care nu ar trebui sa cunoasca direct serverele.

## 19. Taxonomia fallback-urilor

Sistemul foloseste mai multe tipuri de fallback, nu unul singur:

### 19.1 Fallback de retea

- bind pe port fix -> fallback pe port efemer in client server;
- SSE dead client pruning;
- ignorare `SIGPIPE`.

### 19.2 Fallback de orchestrare AI

- middleware retry loop;
- deep-search iterative correction;
- judge feedback reinjectat in prompt.

### 19.3 Fallback de control al cresterii

- root realism judge;
- decompose growth judge;
- proportional scaling la hard cap.

### 19.4 Fallback de permisiune

- pending queues pentru profile/reminders;
- rezolvare asincrona prin endpoint dedicat.

### 19.5 Fallback de cache

- `schedule_needs_refresh`;
- recalcul doar cand mutatiile chiar o cer.

### 19.6 Ce nu exista

Nu exista fallback local complet pentru:

- OpenAI indisponibil;
- decompozitie graph fara model;
- goal generation offline.

Arhitectural, backend-ul este inca AI-dependent.

## 20. Interconectarea reala dintre sisteme

Fluxul cel mai important din aplicatie arata asa:

1. userul trimite mesaj prin `/middleware/message`;
2. middleware-ul construieste context din:
   - profile
   - goals
   - schedule
   - istoric
3. AI-ul alege o actiune;
4. actiunea poate:
   - actualiza graph-ul
   - lansa deep search
   - crea goal
   - modifica profile
   - genera reminder
   - activa matching
5. goals mutateaza schedule-ul;
6. toate pot emite evenimente SSE catre client;
7. `SaveUser(user)` persista starea.

Din perspectiva arhitecturii, asta inseamna:

- **middleware** este orchestratorul;
- **user** este agregatul de stare;
- **graph** este memoria semantica;
- **goals/schedule** sunt motorul comportamental;
- **deep search** este investigatorul;
- **HTTP + SSE** sunt stratul de transport;
- **disk** este continuitatea;
- **OpenAI** este motorul de inferenta controlata.

## 21. Riscuri structurale curente

Cateva puncte merita retinute:

1. **Dependenta ridicata de OpenAI**
   - lipseste un provider abstraction complet.
2. **Fail-fast agresiv**
   - multe cai critice folosesc assert-uri si pot opri procesul.
3. **State global + in-memory**
   - simplifica sistemul, dar limiteaza scalarea si izolarea.
4. **Capacitati fixe in mai multe tabele**
   - `MAX_USERS`, `MAX_SSE_CLIENTS`, pending permission tables.
5. **Concurenta este locala si partiala**
   - exista lock-uri in servere/SSE/connections, dar modelul nu este gandit pentru throughput mare.

## 22. Concluzie

Backend-ul C din CHANGE nu este doar un server HTTP cu cateva handlere. Este un runtime AI-orchestrated cu patru nuclee functionale:

- semantic identity graph;
- goal decomposition and scheduling;
- conversational middleware;
- collaboration/matching infrastructure.

Ce il face interesant tehnic este combinatia dintre:

- model de date structural;
- pipeline-uri iterative cu AI;
- validare stricta prin JSON schema;
- evenimente live prin SSE;
- persistenta locala pe fisiere;
- garduri de siguranta orientate spre coerenta sistemului, nu doar spre uptime.

Pentru extindere, cele mai sensibile puncte sunt:

- abstractizarea providerului AI;
- reducerea dependentei de assert-uri pentru recoverable failures;
- formalizarea mai stricta a persistentei si a contractelor dintre module.
