#ifndef GOAL_AI_DECLARATIONS
#define GOAL_AI_DECLARATIONS

#include "goal-util.h"
#include "util.h"

#define OPENAI_GOAL_EXTRACT_SCHEMA_JSON \
"{" \
  "\"type\":\"object\"," \
  "\"additionalProperties\":false," \
  "\"required\":[\"title\",\"reason\",\"extrainfo\",\"estimated_time\"]," \
  "\"properties\":{" \
    "\"title\":{" \
      "\"type\":\"string\"" \
    "}," \
    "\"reason\":{" \
      "\"type\":\"string\"" \
    "}," \
    "\"extrainfo\":{" \
      "\"type\":[\"string\",\"null\"]" \
    "}," \
    "\"estimated_time\":{" \
      "\"type\":[\"integer\",\"null\"]," \
      "\"minimum\":0" \
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
        "\"required\":[\"title\",\"extrainfo\",\"estimated_time\"]," \
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
          "}" \
        "}" \
      "}" \
    "}" \
  "}" \
"}"

void AICallExtractionGoalSchema(String *input, String *out);
void ExtractGoalFromText(String* text, String* title, String* extrainfo, time_t *estimated_time, _Bool forceEstTime);
void SetGoalShortenPrompt(Goal* g, String* prompt, time_t now);
void SetGoalDecompositionPrompt(Goal* g, String* prompt, time_t now);
String *CallGoalDecompositionAI(String *prompt);
void ParseDecompositionSubgoal(json_value *item,String *title,String *extrainfo,size_t *estimated_time);

#endif
