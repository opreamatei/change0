#ifndef GOAL_AI_DECLARATIONS
#define GOAL_AI_DECLARATIONS

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

_Bool ExtractGoalFromText(String* text, String* title, String* extrainfo, time_t *estimated_time, size_t *priority, _Bool forceEstTime, String* feedback);
void SetGoalShortenPrompt(Goal* g, String* prompt, time_t now);
void SetGoalDecompositionPrompt(Goal* g, String* prompt, time_t now, User *user);
String *CallGoalDecompositionAI(String *prompt);
void ParseDecompositionSubgoal(json_value *item,String *title,String *extrainfo,size_t *estimated_time,time_t *min_pause_to_next,time_t *pause_to_next);

#endif
