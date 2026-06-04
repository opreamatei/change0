#### Hey there! Please read the disclaimer.

> The following are dev notes which were initially meant to present the change0 demo, they were not initially meant to be public, so take into account the document was translated from my native language and might sound akward without some context. This is my perspective, my technical documentation and philosophy about the change project as of june 2026. This is the demo (experimental) presentation.
Preparation started around 6 months prior to june and the C backend development started 3 months prior
This project is developed by 2 people! (currently) This document was written by the programmer so the POV is limited. 
Credits are not attributed to one person.

# CHANGE

We discuss how the application looks architecturally, what is good, what is not good. The
application revolves around one principle:

```
input -> store data about user -> output
```

every action tries to note something about the person's state; this is essential for
forming precise goals. We have several mediums for storing data: the graph, the goals,
time, and the profile.

The application's philosophy is to keep everything local (the demo does almost the
opposite) because privacy is a priority, to minimize the role of the AIs by reducing their
actions to the strictly necessary, as well as to the minimum necessary — this both for
resource efficiency and to prevent classic machine learning errors.

We want to produce a real goal for the user that adapts over time and gives them the chance
to use their own advantages to accomplish it, and along with that to offer them the chance
to find out what they truly want to do, if they had the opportunity to do anything. (The
demo fails in this regard :) )

## TECHNICAL

### Overview

1. it contains `react/`, `c/` and `js/` (react is the application compiled through capacitor,
   c is the backend and the terminal client, and `js/` is a visualizer for developers)
2. the architecture is simple, memory is saved on disk in easy-to-read files, the
   application depends on OpenAI, it talks through http or https (openssl) for connections

A user is

- id, name, port (port is legacy)
- journeys (group of goals)
- node container
- specific flags for refresh systems
- privacy settings and public description

The graph is

- a group of nodes (some nodes are themselves groups of nodes)
- a series of connections through which the nodes are linked
- all nodes have several properties, the relevant ones being activation and weight;
  activation is how relevant the node is now, weight is on the long term.
- the 5 context nodes by default are profession, emotion, passions, generalities,
  subjective. (all of them contain nodes)
- the graph represents clues about the user's interests as well as their current state

Each node retains some "touches" and whenever needed, it transforms those touches into an
"electrical signal" that increases the activation. In the future we can vary the signal
depending on the user's attention capacity at a given moment:

```c
void touch_node(Node *n, double power, time_t now){
    if (!n) return;
    n->lastTouched = now;
    n->pendingTouches += log1p(power);
}
// the signal accumulates here

// the signal is transformed into activation here
static void set_activation(Node *n, time_t now, double boost_per_touch)
{
    if (!n) return;
    n->_activation = decay_from_to(n->_activation, n->lastTouched, now);
    n->_activation += boost_per_touch * log1p((double)n->pendingTouches);
    n->pendingTouches = 0;
    n->lastTouched = now;
}
```

The weight depends on how tightly a node is linked to others, how many times it has been
useful so far, and others. Below is the actual code of the weight:

```c
double merit = SUPPORT_MERIT_TO_NODE_WEIGHT * support_norm +
    (1.0 - SUPPORT_MERIT_TO_NODE_WEIGHT) * used_norm;
double confidence = seen_norm;
double base = NODE_INIT_WGHT;
double old_weight = n->_weight;
double target_weight = confidence * merit + (1.0 - seen_norm) * base;
n->_weight = NODE_OLD_WEIGHT_RELEVANCE * old_weight + (1.0 - NODE_OLD_WEIGHT_RELEVANCE) * target_weight;
```

### The goals

For goals to make sense we needed a mechanism to calculate what the first step is (and the
second.. and the third...) to compute a goal; we settled on the option of producing a tree:

```
                 -> Goal 3 (we can decompose goal 3 similarly)
Goal 1 -> Goal 2
                 -> Goal 4
```

We decompose the first side of goals until it is reasonable to stop. We do not compute all
goals recursively for efficiency reasons. The method of splitting into different layers
works surprisingly well; even if you don't know what exactly is to be done in the future,
you know relatively well where you are now, at each start.

- Note: In the decomposition process we take into account the current layer, the chain of
  parents, the chain of uncles, the progress, potential already-existing close relatives,
  etc.

A goal is defined roughly like this:

- start time (when it begins)
- end time (when it ends)
- priority
- name, supplementary information, advice for the user
- depth
- prev, next
- retry_depth (we come back to this)
- assigned user (for journeys with multiple users)
- minimum pause
- others

Practically it is a hierarchical way of viewing goals; they are linked through prev, next
sequentially; in the future we want it to support parallelism (several goals at the same
time)

### The agents

There are many AIs with diverse roles here, from the deep search agent that runs actions to
investigate users, to its judge, even the guardian that takes care that goals stay within a
reasonable time, up to the model that links available users for a journey.

There are many diverse roles, but the basic idea is simple: an AI (or agent) receives a
small task, does that task and hands it over to the system; the system can continue or set
another AI to do something else. Importantly, our philosophy is to move as much of the care
as possible toward the system and to make agent tasks as small as possible; we use the
models like trains and the system is the rail; although the demo is simple and not entirely
conforming to the principle, each AI does something tiny, the system organizes everything,
because we don't want it to be a soup of slop.

Still, one remarkable AI is the deep search or the middleware one; both have a relatively
similar functional role, they interact through commands, not through json (well technically
yes, through json) or free text.

Both the deep search agent and the middleware can tell the system "I want to do X" and the
system responds with a result; it's as if they run commands — in fact that's what they're
called. The middleware makes the transition between the user's free text and the server's
internal commands; the user says "I want X", the middleware asks the server for command X.
(Note: the middleware has other responsibilities too)

The deep search agent has several commands at its disposal; in fact its flow is roughly
like this:

Deep search prompt:

- You are X, you failed because Y, you must do Z, you have at your disposal these n internal
  commands (they allow investigating the graph from several points, observing the user's
  discipline with respect to the goal, organizing time, etc. I want you to investigate the
  user in depth.
- The AI notes what it understood at each step and at the end offers a conclusion (the
  answer to Z). Then a judge (deep search judge) will say whether it is satisfied or not. If
  not, we update Y and repeat the process.

It is a very important flow because through deepsearch the internal system tells Another AI
information about the user; although it is veeeery costly, it will be much better once we
drop OpenAI and optimize for local inference.

Also almost all the application AIs are not called at once (not quite all of them) but have
a feedback loop; in this loop they are told by a judge / guardian whether they made a
mistake, in which case they redo their job until they do it correctly.

### Insertion

How does a node enter? how does a piece of information about the user end up becoming part
of the graph? the process works like this:

1. a piece of information about the user comes from somewhere: "Bob likes bananas"
2. this information is analyzed from 5 perspectives (the 5 contexts above)
3. each perspective draws some conclusions about how relevant the information is for bob
4. 5 subgraphs are formed for that information, those subgraphs are sent to the big graph
   where the mechanism takes care not to influence what already exists too much.
5. the system adapts the electrical signals and connections accordingly.

Why 5 perspectives? Initially we wanted a single, as-general-as-possible one, but over time
they became too mixed and we were forced to separate them somehow; in the future we want to
come back here and generalize as much as possible.

Types of actions identified for deep search:

- filter the global graph;
- search local neighbors;
- do recursive exploration;
- inspect goals;
- inspect schedule;
- inspect profile sections;
- combine structural and behavioral perspectives.

Goal-specific pipelines:

create goal:

- receives a title and extrainfo for the goal
- starts deep search for personalization
- creates, through the goal agent, a root goal (the root)
- a realism judge decides whether the time is optimal (so it's not too short or too long)
- if it's good, we continue down to the leaves, decomposing the first goal on each branch

for decomposition the pipeline:

it is a relatively simple feedback process, the AI analyzes where it currently is with the
goal and considers how it can break it appropriately; we have several agents involved, for
several small tasks (like extracting json) and another time judge. In the end, together they
can break a goal into a few subgoals.

we must keep in mind that the small goals will recalculate the time needed for the big one,
that's why the time AI is relatively strict and essential, so it doesn't create a rabbit
hole by mistake. The more abstract a goal is, the more we allow it to alter the time.

There are also experimental, legacy functionalities that did not make it into this version.
Such as repair branch, which inspected each goal on a branch, adapted it according to an
advice, then transferred the progress through a time-based heuristic. As it sounds, it was
not very safe although it had its good moments; for time reasons we did not include it in
the demo.

Other important functionalities are related to finalizing goals; when the user approaches or
finishes the final decomposed goals, the server computes the next stage.

### Extra systems

we have graph refresh systems (we discussed it relatively) and scheduling (which practically
places the goals in time considering how much the user can work, nothing interesting here,
it just reorganizes the goals' time)

there is also a file that extracts behavioral information about the user based on goals, it
finds out how efficient they were, where they got stuck, and it is very important for
deepsearch; also (in a superficial way) the create-goal agent takes the user's performance
into account. This file is quite important; also the schedule is very important so that the
AI doesn't bombard the user with too much information. The schedule is used by several
agents.

The profile is a system where we store history (several), profile summary, completed goals,
schedule snapshot, active goals, stalled goals, completed goals, deep search feedback,
privacy settings, current intent and other settings which, throughout the setup, we found
important for the agents to have at their disposal; it's like a kind of dictionary with
controlled keys.

The change server has a matching system where, for privacy, it only knows the users who
agreed to appear here and links those who seem compatible (depending on time, way of seeing
the world, and interests) into a journey, where they can create a common goal, where the AIs
assign each one a task and they can communicate). We want to have a closer relationship
between users; there is no intentional user search, you have in your contacts only the people
with whom you developed "real" relationships; we don't want to turn this into a social media;
this somehow creates isolated and interconnected communities — to reach someone specific, you
must go through someone else. Obviously I mention that this central server also handles shared
journeys and what is public; in the future we should encrypt these pieces of information peer
to peer as well.

Also we have a simple model of peer to peer verification: if a user agrees, they can submit
their own finished goal to peer to peer review and include photos and information about the
goal (another agent makes a summary for accuracy, in the future explicit filters are needed);
if other users give it a rating of 4+ (out of 5) then the user will receive a badge with that
goal being verified. (In the demo only one user needs to give a rating of 4 or 5.)

journals represent a medium where the user can write; some goals may require you to write
something in order to finish them. nothing too complicated here; in the future we need a
dynamic journal variant and for the AIs to learn about the user from these resources. The
photos from the journal can appear privately to the user as memories in the profile, to
surprise them and remind them of their progress.

Reminders is a system for reminders (either from the user or from the middleware); these
appear in the schedule.

Also we have an entire custom HTTP system, but since I did not write the code (although it's
not hard, it's simply json parsing mostly) I will not go deep, but it exposes the server's
functionalities to the testing environment and front end. We also have SSE support for
continuous peer to peer communication (well, here it's harder, I did not write this system).

### Other architectural notes and problems

- The application depends on an openai token; we will switch to the llama cpp engine for
  local inference, which allows much more control over the models through the available
  parameters and open source models.
- Each error is not hidden but displayed directly (obviously if it's not a repairable error)
  to prevent any problem in time. It is a general principle used in application development;
  obviously in production it is not recommended (in general).
- There are several defined constants, although we try to minimize that. Some agents have too
  much responsibility, like deep search.
- There are several fixed capacities (max users, goals, max node label and others)
- Concurrency is superficial; initially I did not focus on this and it became hard to nearly
  impossible to integrate into a system relatively matured on sequential principles.
- At this moment the project is open-source, we want to continue this way.
- The graph risks growing uncontrollably. It has few anti-collision rules, but this is not
  the case for the demo.
- the systems are repetitive, I learned C creating this project, I did not know how to
  organize, everything can be muuuch more simplified and abstracted
- in the last 2-3 weeks we were forced to use AI to meet the deadline, namely claude and
  codex.

github: nita-andrei-cristian/change0
