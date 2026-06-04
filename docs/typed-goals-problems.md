# Probleme identificate: goal-uri tipizate (TIMER / JOURNAL)

Presupuneri confirmate înainte de lista de probleme:
- 2 tipuri: `TIMER` (default) și `JOURNAL`
- Tipizarea vine din promptul AI la decompoziție
- Backend-ul rămâne neatins comportamental; `goal_type` + `produced_ref` se persistă pe server
- Enforcement-ul completării e exclusiv în frontend
- Interfața journal goal: editor journal în centru + timer mic jos; submit → creează entry cu titlul goal-ului → `/goal/end` ca înainte

---

## P1 — `produced_ref` necesită o minimă atingere a `/goal/end` [BLOCANT]

Dacă server-ul trebuie să stocheze id-ul journal-ului produs pe goal, `/goal/end` trebuie să accepte
un câmp opțional (e.g. `"journal_ref"`) și să îl persiste. Altfel `produced_ref` trăiește doar în
memória browser-ului și se pierde la refresh.

Opțiuni:
- `/goal/end` acceptă `journal_ref` opțional și îl scrie pe goal fără să schimbe logica de completare — **cel mai simplu**
- Endpoint separat `POST /goal/set-ref` — mai mult cod, fără beneficiu

## P2 — AI-ul nu va tipiza consistent fără un schema explicit în output [BLOCANT]

Azi decompoziția returnează un array de goal-uri cu câmpuri fixe. Fără un schema JSON explicit în
răspuns, AI-ul va omite `goal_type` sau va hallucina valori.

Soluție: promptul cere explicit câmpul `"goal_type": "timer"|"journal"` pe fiecare leaf, cu `"timer"`
ca fallback dacă lipsește. Parser-ul din `goal-ai.c` trebuie să extragă câmpul și să defaulteze la
TIMER dacă e absent.

## P3 — Re-deschiderea unui journal goal deja pornit dar neterminat

Dacă userul deschide goal-ul → începe să scrie → închide fără submit → redeschide: vede un editor gol
(se creează un al doilea entry) sau editorul draft-ului anterior?

Decizie necesară: la submit se creează întotdeauna un entry NOU, sau se stochează un `draft_ref` înainte
de submit? Fără decizie explicită, comportamentul implicit e "entry nou la fiecare submit".

## P4 — Semantica timer-ului pentru un journal goal

`required_time` e setat de AI la decompoziție (în secunde). Pentru un journal goal, AI-ul va pune
probabil 15–20min. Trebuie decis:
- Countdown (ca la timer goal) — userul simte presiunea timpului?
- Sau timer elapsed (doar cronometru) — mai potrivit pentru reflecție?

Decizia afectează și promptul AI: trebuie instruit să pună un `required_time` rezonabil pentru
reflecție, nu pentru execuție.

## P5 — `produced_ref` poate fi gol după `/goal/end` (fără enforcement server)

Un user (sau apel direct) poate chema `/goal/end` pe un journal goal fără să fi creat un entry.
Goal-ul va fi marcat complet fără `produced_ref`. Dacă UI-ul afișează "citește jurnalul acestui pas"
și `produced_ref` e null, trebuie un state de fallback — afișezi goal-ul ca terminat fără link.

## P6 — `goal_type` trebuie inclus în serializarea central-server pentru shared journeys

Dacă `PushJourneyToCentral` folosește altă cale de serializare decât `SerializeGoalList`, câmpul nou
se pierde la round-trip. De verificat că ambele căi serializează `goal_type` și `produced_ref`.
