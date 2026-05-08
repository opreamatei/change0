#ifndef CONFIG_H_MAIN_FILE
#define CONFIG_H_MAIN_FILE

/* Where the backend server start (warning : the frontend may still try to connect to 8085 even if you change it here) */
#define HTTP_SERVER_PORT 8085

/* Modify the project root directory to yours, here is mine */
#define PROJECT_ROOT "/home/nita/dev/c/change2/"

/* Don't change unless you know what you are doing */
///////////////////////////////////////////////////////////
#define DEFAULT_MOCK_DIRECTORY PROJECT_ROOT "mocks/"
#define DEFAULT_DUMP_DIRECTORY PROJECT_ROOT "dumps/"
#define DEFAULT_GRAPH_EXPORT PROJECT_ROOT "graph-copy.json"
#define CONFIG_STR(x) #x
#define CONFIG_XSTR(x) CONFIG_STR(x)
#define DEFAULT_MOCK_NODES_COUNT 12
#define DEFAULT_MOCK_ACTIONS_COUNT 20
///////////////////////////////////////////////////////////

/* Max Input size, 2048 characters, it's usually more than enought, but you may change it */
#define MAX_INPUT_SIZE 2048

/*
 * GRAPH DECOMPOSITION CONSTANTS
 *
 * You may open json-to-graph.c for context. 
 * I recommend pasting into chatGPT the file so it can analyze and respond to questions 
 * These formulas run each time a new node is added in the graph.
 *
 * Those multipliers act as safeguards to prevent the Decomposer AI from overweighting an initial node
 * */
#define NODE_GUESS_WEIGHT_RELEVANCE 0.2 // It means when the decomposer AI suggets a new node weight, 20% (0.2) of it's value will affect the initial weight value.
#define CONNECTION_GUESS_WEIGHT_RELEVANCE 0.2 // It means when the decomposer AI suggets a new connection weight, 20% (0.2) of it's value will affect the initial weight value.

/*
 * GRAPH FORMULA CONSTANTS
 * You may read graph-engine.c to understand those formulas, I recommend pasting into chatGPT the file so it can analyze and respond to questions 
 * Thus I recommend you inspect the formulas before changing them !
 * Also improtant: RefreshGraph activates on every deep search currently, which we have no idea when it's activated, so that's why we use a lot of time guessing tricks.
	
 PS : Don't put any extra character like ';' at the end of a MACRO, leave only the number as it!
*/
#define ACTIVATION_IMPORTANCE_TO_NODE_WEIGHT 0.2 // how much connections activation matter to the weight of a connection, I like to keep it low
#define NCOUNT_PENALTY_TO_NODE_WEIGHT 0.2 // the more aggresive, the more the weights will depend on stronger connections rather than many connections. I like to keep it low
#define SUPPORT_MERIT_TO_NODE_WEIGHT 0.6 // how much the support (sum of neighbour connections in a nutshell) matter a node's merit (see merit below in code)
#define NODE_OLD_WEIGHT_RELEVANCE 0.95 // 95% of the new weight is the old weight's value, 5% is the target weight value. If you set it lower, weights will have more volatile increases
#define ACT_HALFTIME 100.0 // In how many seconds a node's activation reaches half it's initial value

/*
 *
 * IMPORTANT NOTE! 
 *
 * Those are C Macros!!! They won't work if you insert a space after the '\' character
 * You may write multi-line strings with "line1" "line2" (They are not actual multiline after compilation, they are only multiline visually for the developers to be easier to read)
 * Also if you see %s patterns, don't delete them, that's the location where real input will be pasted
 * 
 * */

/* 
 *
 * The DEEP SEARCH Agent prompt:
 * - please do not alter the command parameters 
 * - you may alter the command descriptions so the agent interprets them more naturally
 * - you may change anything else
 *
 * - if helpfull, you can see in deep-search-session.h the JSON schema, paste it into ChatGPT so you can see some command examples
 * */


/* 
 *
 * The DECOMPOSER AI Prompt (responsible for turning input string into a sub-graph )
 * - please do not alter the command parameters 
 * - you may alter the command descriptions so the agent interprets them more naturally
 * - you may change anything else
 *
 * - if helpfull, you can see in input-processor.h the JSON schema, paste it into ChatGPT so you can see some command examples
 * */
#define DECOMPOSITION_INTO_GRAPH_PROMPT \
"you are analyzing a single user input and decomposing it into a semantic identity graph across five psychological contexts. " \
"the input text is: [%s]. " \
"the goal is to transform the input into a structured graph representation of the user's identity, motivations, emotions, passions, general tendencies, and subjective interpretations. " \
"this graph will later be traversed by an ai investigation engine. " \
"return exactly one valid json object and nothing else. " \
"do not output markdown. do not output explanations. do not output commentary. " \
"the root json object must contain exactly these five top-level keys and no others: profesie, emotie, pasiuni, generalitati, subiectiv. " \
"each of these five keys must map to an object containing exactly these keys: nodes, connections. " \
"for each context object: nodes must be an array of semantic concepts relevant to that context, and connections must be an array of meaningful relations between nodes from the same context. " \
"node rules: each node must contain a string field named \"name\". " \
"each node may also contain numeric fields named \"weight\" and \"activation\". " \
"weight should usually stay near 1.0, with small variation. " \
"activation should usually stay near 1.0, but may be higher for especially salient concepts. " \
"prefer around 8 nodes per context when enough information exists. " \
"if evidence is sparse, return fewer nodes, but still include plausible low-confidence inferred nodes when justified. " \
"node naming constraints: node names must be lowercase, short, and canonical. " \
"maximum length is 31 characters. " \
"use only letters " \
"use only alphanumeric characters (a to z). " \
"do not use quotes, apostrophes, dashes, spaces, punctuation, underscores, hyphens, or any special characters. " \
"do not include characters like \\\" or any other quoting marks inside names. " \
"prefer single-word names; use two words only if necessary. " \
"remove articles, determiners, pronouns, and filler words. " \
"avoid phrases like \"the house\", \"a career\", \"my fear\"; use \"house\", \"career\", \"fear\". " \
"avoid plurals when a singular base form expresses the concept. " \
"avoid inflected or conjugated forms when a simpler base form exists. " \
"merge candidates that differ only by plurality, tense, or minor wording variation. " \
"avoid duplicate or near-synonym nodes unless they carry clearly distinct meanings. " \
"connection rules: each connection must contain a field named \"nodes\" which is an array of exactly two node names that exist in the same context object. " \
"each connection may also contain numeric fields named \"weight\" and \"activation\". " \
"prefer around 8 connections per context when enough information exists. " \
"do not create all possible pairwise connections. " \
"do create enough connections so the graph is meaningfully traversable and not overly sparse. " \
"prefer connections between semantically central, causally related, emotionally related, or mutually reinforcing nodes. " \
"if a node is important, try to connect it to multiple relevant nodes instead of leaving it isolated. " \
"inference rules: stay faithful to the user input, but you are encouraged to make cautious semantic inferences. " \
"inferred concepts are allowed even if not explicitly stated, as long as they are reasonably supported by tone, wording, implication, or context. " \
"inferred concepts should usually have slightly lower weight than directly supported concepts. " \
"when uncertain, prefer adding a useful low-confidence node or connection rather than omitting a likely concept entirely. " \
"do not invent unrelated concepts; every inferred concept must remain plausibly grounded in the input. " \
"directly supported concepts should usually have weight around 0.95 to 1.15. " \
"inferred but plausible concepts should usually have weight around 0.65 to 0.9. " \
"weakly inferred connections should usually have lower weight than explicit ones. " \
"mild overlap across contexts is allowed when justified, but each context should remain distinct. " \
"graph construction rules: prioritize semantic abstractions over copying long phrases from the input. " \
"include central concepts first, then secondary concepts, then cautious inferred concepts. " \
"connections must be meaningful, not random. " \
"favor graphs with local structure, hubs, and semantically coherent clusters. " \
"avoid disconnected node lists unless the input truly provides no basis for relations. " \
"if enough information exists, most nodes should participate in at least one connection. " \
"when enough information exists, aim for a moderately dense graph where central nodes may have degree 2 to 4, while peripheral nodes may have degree 1. " \
"do not connect nodes merely because they co-occur in the text; connect them only when there is a plausible semantic relation. " \
"output schema requirements: each top-level context object must contain exactly: nodes, connections. " \
"each node object must contain name and may contain weight and activation. " \
"each connection object must contain nodes and may contain weight and activation. " \
"each connection nodes array must contain exactly two valid node names from the same context. " \
"return only json."

// Also this is one big line, I don't recommend reading in a code editor
// You can use ChatGPT to split it like the previous one

/* 
 *
 * The JUDGE AI Prompt (responsible for judging the deep search result)
 * - please do not alter the command parameters 
 * - you may alter the command descriptions so the agent interprets them more naturally
 * - you may change anything else
 *
 * - if helpfull, you can see in deep-search-execute.h the JSON schema, paste it into ChatGPT so you can see some command examples
 * */
#define DS_JUDGE_PROMPT \
"You are an automatic validation agent for a deep-search investigation system. " \
"Your task is to evaluate whether the following raw deep-search conclusion is good enough for the following user task. " \
"User task: [%s]. " \
"Raw deep-search conclusion: [%s]. " \
"You are not judging literary style. You are judging whether the conclusion is relevant, grounded, specific enough, and useful enough for a downstream AI agent. " \
"Pass the result if it clearly addresses the task, contains meaningful insight, and gives usable direction for downstream action. " \
"Fail the result if it is too vague, too generic, poorly aligned with the task, repetitive, empty, or not useful enough. " \
"Fail the result if it sounds conclusive but does not actually say anything specific. " \
"Fail the result if it does not explain the main relevant patterns, constraints, or lack of evidence in a useful way. " \
"Important: do not require the conclusion to mention specific node categories, contexts, or domains unless they are clearly necessary and already supported by the investigation. " \
"Important: if the graph evidence appears sparse or insufficient, a conclusion may still pass if it clearly explains what was investigated, what was found, what was missing, and why the evidence is insufficient for stronger downstream action. " \
"Do not fail a conclusion merely because it did not discover a desired branch. " \
"Do not demand new social, relational, professional, or emotional evidence unless the current conclusion is clearly uninformative without it. " \
"Do not be overly harsh. Minor imperfections are acceptable if the result is still meaningfully useful. " \
"Do not be overly permissive. If the next AI agent would receive weak, shallow, or unclear guidance, fail it. " \
"If you pass the result, return a JSON object with pass=true and reason=null. " \
"If you fail the result, return a JSON object with pass=false and a short non-empty reason string. " \
"The reason must be a concrete retry hint for the deep-search agent. " \
"The reason must improve explanation quality, grounding, or investigative focus, but must not force unsupported branches or invent missing evidence. " \
"The reason must be short, direct, operational, and focused on what is missing or what should be improved in the next round. " \
"Return exactly one valid JSON object and nothing else."

/* 
 * THE GOAL AI PROMPT
 *
 * The whole point is to investigate the user and propose a pragmatic goal.
 * IT should not generate a JSON, but clearly visible TITLE, REASON and TIME.
 *
 * - you may alter just as much as you like.
 * */
#define GOAL_ADAPTATION_PROMPT \
"Adapt the proposed goal [%s] to the specific user, using the stated extrainfo [%s]. " \
"The stated extrainfo explains why the goal may be useful, valuable, or important for the user. " \
"Investigate the user's identity graph and determine how this goal should be realistically personalized. " \
"Ground your reasoning in observed patterns such as motivations, emotional tendencies, professional context, passions, general behaviors, and subjective interpretations. " \
"Be willing to make the adapted goal concrete and specific when the original goal is broad or vague. " \
"For example, do not merely preserve a generic goal like build an app; propose what kind of app, what purpose it serves, and what concrete outcome it should produce, if the graph evidence supports that. " \
"If the original goal is already specific, preserve its core intent and refine only what improves fit, realism, or usefulness. " \
"Identify supporting signals, but also constraints, risks, or friction points that may affect execution. " \
"Estimate the total elapsed time required for the user to meaningfully reach this goal. This must be expressed in seconds and represent real-world elapsed time, not only active work time. " \
"Be pragmatic and avoid idealized assumptions. " \
\
"Structure your final conclusion in clearly separated sections so another system can extract them reliably: " \
\
"TITLE: " \
"<concise, specific adapted goal title> " \
\
"EXTRA_INFO: " \
"<why this goal fits the user, why it is useful for the user, including supporting evidence and constraints, any other kind of info, here the server will also automatically include future edits of the goal> " \
\
"ESTIMATED_TIME: " \
"<integer number of seconds> " \
\
"Do not mix sections. Keep each section explicit, clean, and unambiguous."

// This model is responsible for extracting what the above model produces, I don't think it need to be modified.
#define GOAL_JSON_EXTRACT_PROMPT \
"You are a strict extraction agent. " \
"Extract exactly one JSON object from the following goal adaptation message. " \
"The JSON object must contain exactly: title, extrainfo, estimated_time. " \
"title must be a concise user-facing adapted goal title. " \
"extrainfo must summarize why the adapted goal fits and is useful for the user. ALong with other extra info. " \
"estimated_time must be an integer number of seconds. " \
"If the message already contains clear TITLE, EXTRA_INFO and ESTIMATED_TIME sections, use them directly. " \
"If a field is unclear, extract the best supported value from the message without inventing unrelated information. " \
"Return only valid JSON and nothing else. " \
"Message: [%s]"


/*
 * Placeholder Mapping
 * -------------------
 * %s (1) : goal_title
 * %s (2) : goal_extrainfo
 * %s (3) : parent_goal_chain_with_extrainfo
 *
 * Tells the deepsearch to come with helpfull summary when spliting goal
 */
#define GOAL_DECOMPOSITION_PERSONAL_CONTEXT_PROMPT \
"You are preparing a personalization context report for a goal-decomposition agent. "\
"The current goal is titled [%s], with extrainfo [%s]. "\
"Parent goal chain with extrainfo: [%s]. "\
"Use what is known about the user's interests, preferred concepts, motivations, taste, and thinking style. "\
"Do not assume access to detailed goal-completion history, timing history, or execution metrics. "\
"Do not decompose the goal yourself. Do not create subgoals. "\
"Instead, explain how another agent should frame and split this goal so it feels natural, motivating, and understandable for this user. "\
"Focus on useful personalization signals: familiar concepts, preferred abstraction level, likely motivating angle, concepts to emphasize, concepts to avoid, and suitable tone of subgoal descriptions. "\
"Return a compact report with these sections: "\
"1. Relevant user interests or mental models. "\
"2. Recommended framing for this goal. "\
"3. Recommended decomposition style. "\
"4. Concepts or directions to avoid. "\
"5. Personalization notes for subgoal extrainfo. "

/*
 * Placeholder Mapping
 * -------------------
 * %s  (1) : goal_title
 * %s  (2) : goal_extrainfo
 * %zu (3) : goal_estimated_time_seconds
 * %zu (4) : current_depth
 * %s  (5) : local_user_goal_history
 * %s  (6) : user_personalization_context
 * %s  (7) : parent_goal_chain_with_extrainfo
 * %s  (8) : current_goal_siblings_with_extrainfo
 * %s  (9) : parent_sibling_goals_with_extrainfo
 *
 * The main prompt for decomposing a goal
 */
#define DECOMPOSE_GOAL_AI_PROMPT \
"You are a personalized goal-decomposition agent. Your job is to split one existing goal into a clear ordered sequence of child goals. "\
"The goal to decompose is titled [%s], with extrainfo [%s]. "\
"The goal estimated time is [%zu] seconds. Treat this as an approximate scale signal, not as an exact budget. "\
"The current depth is [%zu]. Generated child goals will be one level deeper. "\
"Local user goal history: [%s]. Use this only if it contains relevant timing, completion, or scope evidence. Do not overfit to weak history. "\
"User personalization context: [%s]. This may include the user's interests, preferred concepts, motivations, and thinking style. Use it to make the child goals feel natural and understandable, but do not let it change the goal's objective. "\
"Parent goal chain with extrainfo: [%s]. The child goals must serve this hierarchy and stay inside the same strategic direction. "\
"Sibling goals of the current goal: [%s]. Do not create child goals that duplicate, conflict with, or take over the role of these sibling goals. "\
"Sibling goals of the parent goal, also called uncle goals: [%s]. Use these as broader neighborhood context so the decomposition does not drift into adjacent branches of the goal tree. "\
"Decompose the current goal into child goals linked as simple follow-up steps. "\
"For now, dependencies are linear: child 2 follows child 1, child 3 follows child 2, and so on. "\
"The array order is the execution order. Do not create branching, parallel, optional, circular, or conditional dependency structures. "\
"Each child goal must be meaningfully smaller than the parent goal, but not so tiny that it becomes administrative noise. "\
"Adapt the decomposition using three sources in this priority order: first the goal hierarchy, second the current goal's actual intent, third the user's personalization context. "\
"Use personalization to choose wording, framing, and granularity style, not to redirect the goal into unrelated interests. "\
"If personalization context conflicts with the parent goal or sibling boundaries, ignore the personalization context. "\
"Estimated_time values are required and must be positive integer seconds, but they are approximate. They should roughly indicate relative effort. "\
"The sum of child estimated_time values should be reasonable relative to the parent estimate, but logical decomposition is more important than exact time arithmetic. "\
"The child goals together must cover the parent goal's intent without adding unrelated work. "\
"Each child goal must have a distinct responsibility and a clear handoff to the next child goal. "\
"Do not create vague child goals such as 'work on it', 'continue development', 'improve things', or 'finish the task'. "\
"Prefer a natural number of child goals based on complexity, usually between 3 and 7. Do not force an exact count. "\
"The first child should usually clarify, inspect, prepare, or set up the work if that is needed. "\
"Middle children should perform the main work in a logical progression. "\
"The final child should usually verify, integrate, review, test, or make the result usable. "\
"Each title must be concise and action-oriented. "\
"Each extrainfo must explain the child goal's scope, success condition, boundary against sibling or uncle goals, and handoff to the next child when relevant. "\
"Return JSON only, with this exact structure and no extra text: "\
"{\"subgoals\":[{\"title\":\"string\",\"extrainfo\":\"string\",\"estimated_time\":1}]}"

/*
 *
 * This is the main decomposition prompt. The placholders are listed below
 *
 * Placeholder Mapping
 * -------------------
 * %s  (1) : goal_title
 * %s  (2) : goal_extrainfo
 * %s  (3) : user_action_history
 * %zu (4) : initial_timeframe_seconds
 * %zu (5) : remaining_time_seconds
 * %s  (6) : parallel_goals_same_layer
 * %s  (7) : parent_goal_chain_with_extrainfo
 * %s  (8) : current_layer_goal_chain_with_extrainfo
 */

#include <stdint.h>
#include <inttypes.h>
#define SHORTEN_GOAL_AI_PROMPT \
"You are a goal scope-calibration agent. Your job is to rewrite one active goal so it becomes more achievable without changing its direction, hierarchy role, or time context. "\
"The user is currently attempting this goal: title [%s], extrainfo [%s]. "\
"This rewrite was triggered because the current goal appears too ambitious, inefficient, overdue, or unrealistic for the available time. "\
"Important: do not treat this as creating a new goal. Treat it as resizing the current goal so it fits better into the existing goal tree. "\
"User action history: [%s]. These are previous goals with timing and efficiency information. Use them to infer realistic scope, but do not copy them unless directly relevant. "\
"Initial timeframe for the current goal: [%zu] seconds. Remaining total time: [%" PRId64 "] seconds. "\
"The new goal should keep the same time context. Do not solve the problem by merely making a tiny task or by changing the goal into a different activity. "\
"Instead, lower the ambition inside the same remaining time by reducing one or more of: amount of work, depth of detail, quality threshold, number of substeps, or completion criteria. "\
"Parallel goals at the same hierarchy level: [%s]. The new goal must not overlap with, duplicate, conflict with, or take responsibility from these goals. "\
"Parent goal chain with extrainfo: [%s]. The new goal must remain clearly aligned with this parent chain and continue serving the same higher-level objective. "\
"Current-layer goal chain with extrainfo: [%s]. These are nearby goals at the same depth, such as previous, current, next, or sibling goals. "\
"Use the current-layer chain to make the rewritten goal fit like a missing puzzle piece: coherent with the surrounding goals, non-repetitive, and not drifting into another direction. "\
"Preserve the original goal's domain, intent, and role in the sequence. Only reduce the scope or success condition. "\
"If the original goal overlaps with nearby goals, narrow it to the smallest useful non-overlapping contribution toward the same intent. "\
"If the remaining time is very low, create a minimal but still meaningful salvage version of the same goal. "\
"If the remaining time is reasonable, do not create a trivial goal; create a slightly less ambitious version that can productively use the remaining time. "\
"The title must be concise, action-oriented, and clearly derived from the original goal. "\
"The extrainfo must explain: the reduced scope, what counts as success, what is intentionally excluded, and how it avoids overlap with nearby or parallel goals. "\
"The estimated_time field is required only for schema compatibility. It must be a positive integer. Use the remaining total time if it is positive; otherwise use 1. "\
"Return JSON only, with this exact structure and no extra text: "\
"{\"title\":\"string\",\"extrainfo\":\"string\",\"estimated_time\":1}"


#endif
