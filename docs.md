# CHANGE: review tehnic, arhitectură și flow-uri

Documentul descrie ce face codul din `c/` pe baza implementării actuale, nu pe baza intențiilor din README. Accentul este pe sistem, pe fluxurile reale și pe ce încearcă aplicația să obțină.

## 1. Ce încearcă să construiască proiectul

`c/` implementează un backend C pentru un sistem personal de modelare a utilizatorului. Ideea centrală nu este un chatbot general, ci un motor care încearcă să țină simultan trei reprezentări:

1. o memorie semantică despre utilizator, sub formă de graf;
2. un sistem de goal-uri, cu decompoziție și progres;
3. un schedule derivat din goal-uri, pentru presiune temporală și disponibilitate.

LLM-ul nu este produsul principal. Este folosit punctual ca adaptor semantic între text liber și structurile interne:

- transformă textul utilizatorului în update-uri de graf;
- alege comenzi în deep search;
- validează dacă deep search-ul a ajuns la o concluzie suficient de bună;
- normalizează goal-uri;
- poate decomprima sau repara o ramură de goal-uri.

Arhitectural, produsul este:

- un runtime stateful, monolitic, în memorie;
- cu orchestrare procedurală în C;
- cu apeluri OpenAI doar la marginile unde e nevoie de interpretare semantică;
- expus prin CLI și HTTP/SSE.

## 2. Entry point și bootstrap real

Intrarea în program este minimă în [c/main.c](/home/nita/dev/c/change2/c/main.c:1):

- `UIStart()`
- `UILoop()`
- `UIKill()`

Bootstrap-ul real este în [c/cli/ui.c](/home/nita/dev/c/change2/c/cli/ui.c:1). `UIStart()` face, în ordine:

1. `InitNodes()`
2. `SetUpContexts()`
3. `InitGlobalPointerMap()`
4. înregistrează callback-ul `ds_emit`
5. înregistrează callback-ul `goal_emit`
6. `InitGoalSystem()`

Asta spune mult despre modelul de execuție:

- există un singur runtime global;
- sistemul nu este multi-tenant;
- serverul HTTP, CLI-ul, goal-urile și graful partajează aceeași memorie;
- callback-urile globale sunt folosite ca mecanism de integrare între subsisteme.

Nu există izolare per user, per sesiune sau per request.

## 3. Harta sistemului din `c/`

### `c/ne/`

Zona principală de domain logic. `ne` este efectiv "neuro engine", dar implementarea e mai degrabă un motor simbolic cu heuristici decât ceva neural.

Submodule importante:

- `node.*`: stocare noduri și muchii;
- `graph/graph-engine.*`: refresh, decay, recalcul de greutăți;
- `input/*`: ingestie text -> JSON -> graf;
- `search/*`: deep search ghidat de AI peste graf, goal-uri și schedule;
- `goal/*`: creare, decompoziție, reparație și serializare goal-uri;
- `profile/*`: logging de input-uri și urme de interacțiune.

### `c/srv/`

Wrapper HTTP și SSE. Expune graful, goal-urile, deep search-ul și evenimente live.

### `c/cli/`

Shell local pentru bootstrapping, debugging și operare manuală.

### `c/lib/`

Biblioteci locale:

- `util`: string-uri, fișiere, asserts, helpers generici;
- `jsonp`: parser JSON intern;
- `openai`: client OpenAI;
- `hd`: hash dictionary folosit în indexare.

### `c/globals.*`

Registru global de pointeri. Este un mecanism de service locator foarte simplu.

## 4. Modelul de date: user identity ca graf semantic

### 4.1 Contexte fixe

În [c/ne/node.h](/home/nita/dev/c/change2/c/ne/node.h:1) există cinci contexte rădăcină:

- `profesie`
- `emotie`
- `pasiuni`
- `generalitati`
- `subiectiv`

Acestea sunt create la startup în `SetUpContexts()`. Nu sunt doar etichete; sunt noduri reale, rădăcini ale unor subarbori.

Ce încearcă sistemul aici:

- să împartă identitatea utilizatorului pe axe psihologice;
- să permită același label semantic în contexte diferite;
- să trateze "cine este userul" ca structură, nu ca text brut.

### 4.2 Structura nodului

`Node` conține:

- `label`
- `_weight`
- `_activation`
- `neighbours`
- `times_seen`
- `times_used`
- `parent`
- `childrenIndex`
- metadate de decay și touch

Interpretarea practică este:

- `_activation`: relevanță curentă, volatilă;
- `_weight`: importanță structurală, mai lentă;
- `times_seen`: cât de des apare în explorări;
- `times_used`: cât de des devine ancoră de investigație;
- `childrenIndex`: index local pe label sub un părinte dat.

### 4.3 Muchii și propagare

`Connection` are și el:

- `_activation`
- `_weight`
- `pendingTouches`
- `target`

Deci nu doar nodurile au stare; și relațiile au saliență și importanță.

### 4.4 Efectul ierarhiei

Funcțiile `read_node_activation`, `read_node_weight`, `read_connection_activation`, `read_connection_weight` iau în calcul lanțul de părinți. Asta înseamnă că un nod nu este evaluat izolat: contextul lui modifică scorul efectiv.

Implicația de design:

- contextul nu e doar clasificare;
- contextul influențează scorarea operațională;
- aceeași noțiune poate avea efect diferit în `emotie` față de `profesie`.

## 5. Dinamică: de ce se numește "neuro engine"

Partea "neuro" vine din update-urile dinamice, nu din ML clasic.

În [c/ne/graph/graph-engine.c](/home/nita/dev/c/change2/c/ne/graph/graph-engine.c:1), `RefreshGraph()`:

1. aplică decay exponențial pe activări, în funcție de timp;
2. consumă `pendingTouches`;
3. calculează support pentru fiecare nod din vecini;
4. normalizează după maxime globale;
5. reconstruiește `weight` folosind o combinație de:
   - support structural;
   - `times_seen`;
   - `times_used`;
   - constante din `config.h`.

Ce vrea să atingă acest mecanism:

- memorie cu uitare controlată;
- distincție între ce e important acum și ce e important în general;
- întărire graduală a conceptelor folosite repetat;
- penalizare implicită pentru noduri cu multe muchii slabe.

Nu este un graf static. Este o memorie euristică care se reașază pe baza utilizării.

## 6. Flow-ul de ingestie: text liber -> graf intern

Fluxul este în [c/ne/input/input-processor.c](/home/nita/dev/c/change2/c/ne/input/input-processor.c:1).

### 6.1 Pașii reali

1. Utilizatorul introduce text.
2. `DecomposeInputIntoGraph()` loghează input-ul în profil.
3. Se construiește promptul `DECOMPOSITION_INTO_GRAPH_PROMPT`.
4. Se face request OpenAI cu schema JSON strictă.
5. Se parsează răspunsul OpenAI.
6. Se extrage `output -> content -> text`.
7. Textul extras se parsează din nou ca JSON.
8. Pentru fiecare context primit, `AddContextNodesFromJSON(...)` adaugă noduri și legături în graf.

### 6.2 Ce încearcă să obțină

Acest pipeline încearcă să transforme propoziții umane în memorie semantică normalizată:

- nu păstrează input-ul doar ca jurnal;
- îl proiectează într-o structură exploatabilă de motor;
- obligă modelul să producă formă strictă, nu text conversațional.

### 6.3 Observație critică

Fiabilitatea flow-ului depinde mult de contractul OpenAI:

- codul parsează un format nested concret;
- asumă că output-ul text este JSON valid;
- folosește `cassert`, deci multe erori duc la oprire dură a procesului.

Asta face sistemul bun ca prototip de cercetare, dar fragil ca serviciu robust.

## 7. Search și deep search: motorul de investigație

Deep search este partea cea mai specifică a proiectului.

### 7.1 Ce este de fapt

Nu este web search. Este un agent de investigație care operează peste datele interne:

- graf identitar;
- goal-uri;
- schedule.

Task-ul lui nu este să "rezolve" problema direct, ci să producă concluzii despre utilizator și contextul lui.

### 7.2 Memoria sesiunii

În [c/ne/search/deep-search-session.c](/home/nita/dev/c/change2/c/ne/search/deep-search-session.c:1), o sesiune are două memorii:

- `persistent`: instrucțiuni de sistem + task;
- `dynamic`: jurnalul rundelor și al evidențelor.

Asta este o alegere importantă: agentul nu rulează stateless pe fiecare pas. Primește context cumulativ.

### 7.3 Bucla de execuție

`start_ds_session()` face:

1. pregătește promptul persistent din `DS_PERSISTENT_PROMPT`;
2. rulează `RefreshGraph()`;
3. emite evenimente de start;
4. intră într-o buclă externă de judge/retry;
5. în fiecare buclă externă rulează o buclă internă de think/act până la concluzie;
6. după concluzie, rulează un judge LLM;
7. dacă judge-ul respinge rezultatul, injectează feedback în memoria persistentă și reia.

### 7.4 Modelul operațional

Agentul trebuie să emită exact o comandă JSON per pas. Execuția reală se face în [c/ne/search/deep-search-execute.c](/home/nita/dev/c/change2/c/ne/search/deep-search-execute.c:1) prin `exec_response(...)`, care mapează `command` la `run1 ... run9`.

Deci designul este:

- LLM-ul decide următoarea operație;
- C-ul execută operația;
- rezultatul devine evidență pentru pasul următor;
- un al doilea LLM decide dacă investigația e suficient de bună.

Este o arhitectură de tip constrained agent, nu un simple prompt-response.

### 7.5 Ce încearcă proiectul aici

Scopul real pare să fie:

- să facă reasoning iterativ peste memorie internă;
- să evite răspunsul superficial dintr-un singur prompt;
- să forțeze agentul să caute dovezi structurale înainte de concluzie.

Asta este partea cea mai ambițioasă din repo.

## 8. Goal system: comportament, nu identitate

Prompturile și codul tratează explicit goal-urile ca behavioural evidence, separat de identity graph.

### 8.1 Rolul subsistemului

Goal-urile încearcă să captureze:

- ce vrea utilizatorul;
- ce a început;
- ce a terminat;
- ce a abandonat;
- cum se rupe un obiectiv mare în pași executabili.

### 8.2 Inițializare și container

`InitGoalSystem()` pornește containerul global. Din nou, totul este global și în memorie.

### 8.3 Mecanisme importante

În [c/ne/goal/goal.c](/home/nita/dev/c/change2/c/ne/goal/goal.c:1) apar câteva direcții clare:

- serializare recursivă a arborelui de goal-uri;
- snapshot de progres pentru comparații și reparații;
- normalizare de titluri;
- reparație de leaf goals;
- scurtare automată a goal-ului când utilizatorul eșuează repetat.

### 8.4 Ce încearcă să atingă sistemul

Goal system-ul nu vrea doar CRUD. Vrea adaptare:

- dacă un goal nu încape în timpul estimat, îl extinde;
- dacă problema persistă, îl scurtează semantic prin AI;
- dacă un goal mare e prea abstract, îl poate decompune.

Asta sugerează un produs orientat spre auto-management asistat, nu doar knowledge graph.

## 9. Schedule system: temporalizarea comportamentului

În [c/ne/goal/user-schedule.c](/home/nita/dev/c/change2/c/ne/goal/user-schedule.c:1), schedule-ul este derivat, nu introdus direct.

### 9.1 Cum funcționează

1. identifică due leaf goals;
2. pentru fiecare, găsește prima frunză executabilă;
3. construiește o succesiune temporală cu `prev`, `next`, `pauseToNext`;
4. calculează orele de lucru pe zi și pe săptămână;
5. serializează rezultatul ca raport textual + JSON embedded.

### 9.2 De ce contează

Schedule-ul adaugă o dimensiune pe care graful identitar nu o are:

- presiune temporală;
- cost operațional;
- ferestre de execuție;
- densitate de lucru.

În combinație cu deep search, sistemul poate infera nu doar "ce contează", ci și "ce e realist să urmeze".

## 10. HTTP server: stratul de produs

În [c/srv/http-server.c](/home/nita/dev/c/change2/c/srv/http-server.c:1), serverul face mai mult decât servire de fișiere:

- gestionează request parsing manual;
- expune răspunsuri JSON;
- suportă CORS;
- ține conexiuni SSE active;
- multiplexează evenimente de deep search și goal-uri prin `stream_id`.

Implicații:

- backend-ul a fost gândit pentru UI interactiv;
- deep search-ul poate fi urmărit live;
- goal-urile pot emite progres incremental;
- frontend-ul React și viewer-ul JS sunt clienți pentru același runtime.

Este un server custom low-level, fără framework, ceea ce păstrează controlul, dar crește costul de robustețe.

## 11. CLI-ul: consolă de operare și laborator

CLI-ul din `c/cli/ui.c` expune opțiuni precum:

- ingestie mesaj;
- export graf;
- export goal-uri;
- deep research;
- start server;
- creare goal;
- regen mock OpenAI.

Asta arată că repo-ul este încă și un mediu de experiment:

- poți popula manual sistemul;
- poți porni serverul din aceeași aplicație;
- poți itera pe flow-uri AI fără frontend.

CLI-ul este, practic, interfața de debugging a produsului.

## 12. Rolul `config.h`

[c/config.h](/home/nita/dev/c/change2/c/config.h:1) este un amestec de:

- configurație infrastructurală;
- prompt engineering;
- constante de scoring;
- path-uri locale.

Aici stă mare parte din comportamentul sistemului:

- portul serverului;
- project root;
- formulele de decay și merit;
- prompturile pentru deep search;
- contractele de interpretare pentru agent.

Design-wise, `config.h` este aproape un centru de comandă al produsului. E util pentru prototipare rapidă, dar tinde să cupleze tare:

- logică;
- configurare;
- prompturi;
- deployment local.

## 13. Flow-uri end-to-end importante

### Flow A: construire user identity

1. userul scrie text în CLI sau prin server;
2. textul ajunge în `DecomposeInputIntoGraph`;
3. OpenAI extrage structură JSON pe contexte;
4. nodurile și legăturile sunt adăugate în graf;
5. graful devine baza pentru căutări ulterioare.

Rezultatul urmărit: o memorie semantică incrementală despre utilizator.

### Flow B: investigație asistată

1. userul sau UI-ul cere deep search pentru un task;
2. `start_ds_session()` compune promptul persistent;
3. agentul alege o comandă internă;
4. C-ul execută comanda și întoarce evidență;
5. agentul iterează până produce o concluzie;
6. un judge verifică suficiența concluziei;
7. rezultatul final este livrat și emis prin SSE.

Rezultatul urmărit: concluzii argumentate, nu improvizație directă.

### Flow C: management de goal-uri

1. userul definește un goal;
2. goal-ul poate fi normalizat și decompozat;
3. progresul actualizează datele de start/end;
4. la eșec repetat, sistemul extinde sau scurtează goal-ul;
5. schedule-ul se reconstruiește din leaf goals due.

Rezultatul urmărit: planificare adaptivă pornită din comportament real.

## 14. Ce este interesant tehnic

Cele mai interesante idei din cod sunt:

- separarea între identitate, comportament și timp;
- folosirea LLM-ului ca transformator controlat de schemă;
- deep search cu buclă agent + executor + judge;
- memorie cu activare/greutate și decay temporal;
- SSE pentru streaming de reasoning operațional.

Ca direcție, proiectul vrea mai mult decât "AI wrapper peste API". Încearcă să construiască un motor intern care să poată susține interpretări personalizate.

## 15. Limite și riscuri tehnice observabile

### Fragilitate operațională

Se folosesc multe `cassert` în flow-uri dependente de rețea și input AI. Asta înseamnă că:

- erorile de format pot opri procesul;
- serverul și runtime-ul nu par izolate de eșecul unui request;
- experiența e mai apropiată de prototip decât de serviciu rezilient.

### Stare globală

Global state-ul simplifică integrarea, dar complică:

- concurența;
- testarea izolată;
- multi-user support;
- restart-uri parțiale.

### Cuplare puternică la OpenAI

Contractele JSON sunt mai bune decât free-form prompting, dar sistemul tot depinde de:

- disponibilitatea modelului;
- structura exactă a răspunsului;
- prompturi embeddate în C.

### Server HTTP custom

Implementarea manuală oferă control, dar mută în cod propriu responsabilități care de obicei ar fi delegate unui framework:

- parsing robust de request;
- limite și timeouts;
- handling de erori și edge cases de socket.

## 16. Concluzie

`c/` conține miezul real al produsului. Nu este doar backend utilitar, ci un motor experimental de modelare a utilizatorului care încearcă să unească:

- memorie semantică;
- interpretare comportamentală;
- presiune temporală;
- investigație ghidată de AI.

Direcția proiectului este clară: un sistem personalizat de reasoning despre utilizator, nu un simplu strat conversațional. Codul are idei bune și destulă ambiție de sistem, dar încă poartă semnele unui prototip: stare globală, fail-fast pe multe ramuri și dependență puternică de contractele LLM.
