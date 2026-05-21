#ifndef DEEP_SEARCH_EXECUTE_C
#define DEEP_SEARCH_EXECUTE_C

#include "deep-search-session.h"
#include "json.h"
#include "util.h"
#include "srv/user-management.h"

#define OPENAI_DEEP_SEARCH_JUDGE_SCHEMA_JSON \
"{" \
  "\"type\":\"object\"," \
  "\"additionalProperties\":false," \
  "\"required\":[\"pass\",\"reason\"]," \
  "\"properties\":{" \
    "\"pass\":{\"type\":\"boolean\"}," \
    "\"reason\":{\"type\":[\"string\",\"null\"]}" \
  "}" \
"}"

void exec_response(json_value* doc, String *dynamic_mem, size_t depth, String* conclusion, char *ds_id, User *user);

char *call_gpt_deepsearch(DS_memory *mem, size_t *respsize);

json_value *call_gpt_judge(String *out, Task *task);

#endif
