#ifndef DEEP_SEARCH_SESSION_C
#define DEEP_SEARCH_SESSION_C

#include <stddef.h>
#include "node.h"
#include "util.h"

#define OPENAI_DEEP_SEARCH_SCHEMA_JSON \
"{" \
  "\"type\":\"object\"," \
  "\"additionalProperties\":false," \
  "\"required\":[" \
    "\"command\"," \
    "\"finished\"," \
    "\"conclusion\"," \
    "\"percentage\"," \
    "\"criteria\"," \
    "\"node\"," \
    "\"context\"," \
    "\"percA\"," \
    "\"percW\"," \
    "\"depth\"," \
    "\"intent\"," \
    "\"mode\"," \
    "\"max\"," \
    "\"goal_id\"," \
    "\"method\"" \
  "]," \
  "\"properties\":{" \
    "\"command\":{\"type\":[\"integer\",\"null\"],\"enum\":[1,2,3,4,5,6,null]}," \
    "\"finished\":{\"type\":[\"boolean\",\"null\"]}," \
    "\"conclusion\":{\"type\":[\"string\",\"null\"]}," \
    "\"percentage\":{\"type\":[\"integer\",\"null\"],\"minimum\":1,\"maximum\":100}," \
    "\"criteria\":{\"type\":[\"string\",\"null\"],\"enum\":[\"activation\",\"weight\",null]}," \
    "\"node\":{\"type\":[\"string\",\"null\"]}," \
    "\"context\":{\"type\":[\"string\",\"null\"],\"enum\":[\"profesie\",\"emotie\",\"pasiuni\",\"generalitati\",\"subiectiv\",null]}," \
    "\"percA\":{\"type\":[\"integer\",\"null\"],\"minimum\":0,\"maximum\":100}," \
    "\"percW\":{\"type\":[\"integer\",\"null\"],\"minimum\":0,\"maximum\":100}," \
    "\"depth\":{\"type\":[\"integer\",\"null\"],\"minimum\":1,\"maximum\":5}," \
    "\"intent\":{\"type\":[\"string\",\"null\"]}," \
    "\"mode\":{\"type\":[\"string\",\"null\"],\"enum\":[\"roots\",\"due\",\"history\",null]}," \
    "\"max\":{\"type\":[\"integer\",\"null\"],\"minimum\":0}," \
    "\"goal_id\":{\"type\":[\"string\",\"null\"]}," \
    "\"method\":{\"type\":[\"string\",\"null\"],\"enum\":[\"siblings\",\"parents\",\"linked-siblings\",\"linked-siblings-hidden\",\"uncles\",\"uncles-hidden\",\"history\",null]}" \
  "}" \
"}"

void start_ds_session(Task *task, char* id, String* out);

#endif

#ifndef DS_MEMORY_DEFINITION
#define DS_MEMORY_DEFINITION

typedef struct {
	String dynamic;
	String persistent;

} DS_memory;

_Bool init_ds_memory(DS_memory *d);
void free_ds_memory(DS_memory *d);


#endif
