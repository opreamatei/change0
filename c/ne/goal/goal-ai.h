#ifndef GOAL_AI_DECLARATIONS
#define GOAL_AI_DECLARATIONS

#include <stdint.h>

#include "goal-util.h"
#include "util.h"

#define OPENAI_GOAL_EXTRACT_SCHEMA_JSON \
"{" \
  "\"type\":\"object\"," \
  "\"additionalProperties\":false," \
  "\"required\":[\"title\",\"extrainfo\",\"estimated_time\",\"priority\"]," \
  "\"properties\":{" \
    "\"title\":{" \
      "\"type\":\"string\"" \
    "}," \
    "\"extrainfo\":{" \
      "\"type\":\"string\"" \
    "}," \
    "\"estimated_time\":{" \
      "\"type\":[\"integer\",\"null\"]," \
      "\"minimum\":0" \
    "}," \
    "\"priority\":{" \
      "\"type\":[\"integer\",\"null\"]," \
      "\"minimum\":0," \
      "\"maximum\":5" \
    "}" \
  "}" \
"}"

#define OPENAI_GOAL_DECOMPOSITION_SCHEMA_JSON \
"{" \
  "\"type\":\"object\"," \
  "\"additionalProperties\":false," \
  "\"required\":[\"subgoals\"]," \
  "\"properties\":{" \
    "\"subgoals\":{" \
      "\"type\":\"array\"," \
      "\"minItems\":2," \
      "\"maxItems\":9," \
      "\"items\":{" \
        "\"type\":\"object\"," \
        "\"additionalProperties\":false," \
        "\"required\":[\"title\",\"extrainfo\",\"estimated_time\",\"min_pause_to_next\",\"pause_to_next\"]," \
        "\"properties\":{" \
          "\"title\":{" \
            "\"type\":\"string\"," \
            "\"minLength\":3" \
          "}," \
          "\"extrainfo\":{" \
            "\"type\":\"string\"," \
            "\"minLength\":10" \
          "}," \
          "\"estimated_time\":{" \
            "\"type\":\"integer\"," \
            "\"minimum\":1" \
          "}," \
          "\"min_pause_to_next\":{" \
            "\"type\":\"integer\"," \
            "\"minimum\":0" \
          "}," \
          "\"pause_to_next\":{" \
            "\"type\":\"integer\"," \
            "\"minimum\":0" \
          "}" \
        "}" \
      "}" \
    "}" \
  "}" \
"}"

/*
 * Shared-journey decomposition schema. Same shape as the solo schema with an
 * added required assigned_to integer per subgoal. 255 = unassigned sentinel,
 * 0..(MAX_JOURNEY_USERS-1) = participant index.
 */
#define OPENAI_SHARED_GOAL_DECOMPOSITION_SCHEMA_JSON \
"{" \
  "\"type\":\"object\"," \
  "\"additionalProperties\":false," \
  "\"required\":[\"subgoals\"]," \
  "\"properties\":{" \
    "\"subgoals\":{" \
      "\"type\":\"array\"," \
      "\"minItems\":2," \
      "\"maxItems\":9," \
      "\"items\":{" \
        "\"type\":\"object\"," \
        "\"additionalProperties\":false," \
        "\"required\":[\"title\",\"extrainfo\",\"estimated_time\",\"min_pause_to_next\",\"pause_to_next\",\"assigned_to\"]," \
        "\"properties\":{" \
          "\"title\":{" \
            "\"type\":\"string\"," \
            "\"minLength\":3" \
          "}," \
          "\"extrainfo\":{" \
            "\"type\":\"string\"," \
            "\"minLength\":10" \
          "}," \
          "\"estimated_time\":{" \
            "\"type\":\"integer\"," \
            "\"minimum\":1" \
          "}," \
          "\"min_pause_to_next\":{" \
            "\"type\":\"integer\"," \
            "\"minimum\":0" \
          "}," \
          "\"pause_to_next\":{" \
            "\"type\":\"integer\"," \
            "\"minimum\":0" \
          "}," \
          "\"assigned_to\":{" \
            "\"type\":\"integer\"," \
            "\"minimum\":0," \
            "\"maximum\":255" \
          "}" \
        "}" \
      "}" \
    "}" \
  "}" \
"}"

_Bool ExtractGoalFromText(String* text, String* title, String* extrainfo, time_t *estimated_time, size_t *priority, _Bool forceEstTime, String* feedback);
void SetGoalShortenPrompt(Goal* g, String* prompt, time_t now);
void SetGoalDecompositionPrompt(Goal* g, String* prompt, time_t now, User *user);
String *CallGoalDecompositionAI(String *prompt);
String *CallSharedGoalDecompositionAI(String *prompt);
void ParseDecompositionSubgoal(json_value *item,String *title,String *extrainfo,size_t *estimated_time,time_t *min_pause_to_next,time_t *pause_to_next);
void ParseSharedDecompositionSubgoal(json_value *item,String *title,String *extrainfo,size_t *estimated_time,time_t *min_pause_to_next,time_t *pause_to_next,uint8_t *assigned_to);

/*
 * Build the goal-adaptation prompt (the root-goal creation prompt).
 * Dispatches by journey: solo journeys keep using GOAL_ADAPTATION_PROMPT and
 * the existing per-user deep-search context (input is the deep-search output
 * already in `out`). Shared journeys use SHARED_GOAL_ADAPTATION_PROMPT and
 * the participants block built from each user's central profile.
 *
 * The function fills `out` with the final adaptation result the extractor
 * expects to parse — same downstream contract for both variants.
 */
void BuildGoalAdaptationPrompt(
	String *input1, String *input2, String *feedback,
	String *out, char *goalId,
	start_ds_session_like_func start_ds_session,
	const char *journey_id, User *user
);

/*
 * Build the goal-decomposition prompt for a goal. Dispatches by journey:
 * solo journeys keep their existing decomposition prompt and the per-user
 * deep-search personalization pass. Shared journeys use the shared variant
 * with journey-level history and the participants block.
 *
 * Returns whether this is the shared variant; the caller uses it to pick
 * the matching schema/parser.
 */
_Bool BuildDecomposePrompt(Goal *g, String *prompt, time_t now, User *user);

#endif
