#ifndef OPENAI_MOCKS_H
#define OPENAI_MOCKS_H

#include "../../config.h"

#define OPENAI_MODEL "gpt-5.4"

#define OPENAI_PROMPT_TEXT \
"Generate a single valid JSON object and nothing else. " \
"Do not output markdown. Do not output explanations. " \
"Return exactly one root JSON object with exactly these two top-level keys: " \
"\\\"graph_mocks\\\" and \\\"action_mocks\\\". " \
\
"The application simulates an AI system that builds and investigates a psychological identity graph of a user. " \
"The goal of the system is to model how a user's identity, motivations, emotions, habits, beliefs, passions, and subjective interpretations are connected. " \
"The graph represents a simplified internal cognitive and behavioral map of the user. " \
\
"The available identity contexts are: profession, emotion, passions, generalities, subjective. " \
"Each graph mock represents a local graph for one of these contexts. " \
\
"Graph mocks must contain: context, nodes, connections. " \
"Nodes represent meaningful concepts such as traits, pressures, emotions, goals, routines, or perceptions. " \
"Connections represent meaningful relationships between nodes and must not be random. " \
\
"Nodes contain name and may contain weight and activation. " \
"Connections contain nodes and may contain weight and activation. " \
\
"Weight should remain close to " CONFIG_XSTR(NODE_INIT_WGHT) " with only small variation. " \
"Activation should remain close to " CONFIG_XSTR(NODE_INIT_ACT) " but may occasionally spike to reflect importance or tension. " \
\
"Generate exactly " CONFIG_XSTR(DEFAULT_MOCK_NODES_COUNT) " graph mocks. " \
"Generate exactly " CONFIG_XSTR(DEFAULT_MOCK_ACTIONS_COUNT) " action mocks. " \
\
"Action mocks represent valid traversal or analysis commands executed by an AI investigating the graph. " \
"They must always be valid and consistent with the graph_mocks. " \
"Most actions must reference nodes that exist in graph_mocks and use valid contexts. " \
\
"There are exactly three command types plus one terminal object type. " \
\
"Command 1 is global filtering. " \
"Command 1 uses exactly these fields: command, percentage, criteria, intent. " \
"Command 1 must use command value 1. " \
"Command 1 must not contain node, context, percA, percW, depth, finished, or conclusion. " \
"percentage must be an integer between 0 and 100. " \
"criteria must be exactly activation or weight. " \
\
"Command 2 is local neighbor search. " \
"Command 2 uses exactly these fields: command, percentage, node, criteria, context, intent. " \
"Command 2 must use command value 2. " \
"Command 2 must not contain percA, percW, depth, finished, or conclusion. " \
"percentage must be an integer between 0 and 100. " \
"criteria must be exactly activation or weight. " \
"context must be one of the valid contexts. " \
"node must exist in the selected context graph. " \
\
"Command 3 is recursive exploration. " \
"Command 3 uses exactly these fields: command, node, context, percA, percW, depth, intent. " \
"Command 3 must use command value 3. " \
"Command 3 must not contain percentage, criteria, finished, or conclusion. " \
"percA and percW must be integers between 0 and 100. " \
"depth must be an integer between 1 and 5. " \
"context must be one of the valid contexts. " \
"node must exist in the selected context graph. " \
\
"The terminal object is not a command. " \
"It uses exactly these two fields: finished and conclusion. " \
"finished must be true. " \
"conclusion must be a short meaningful final assessment inferred from the graph traversal. " \
\
"At least one item in action_mocks must be this terminal object. " \
\
"Keep action mocks raw, without wrappers or extra metadata. " \
"Ensure the entire dataset is coherent, semantically meaningful, and useful for testing graph traversal and reasoning logic."

#define OPENAI_SCHEMA_JSON \
"{" \
  "\"type\":\"object\"," \
  "\"additionalProperties\":false," \
  "\"required\":[\"graph_mocks\",\"action_mocks\"]," \
  "\"properties\":{" \
    "\"graph_mocks\":{" \
      "\"type\":\"array\"," \
      "\"items\":{" \
        "\"type\":\"object\"," \
        "\"additionalProperties\":false," \
        "\"required\":[\"context\",\"nodes\",\"connections\"]," \
        "\"properties\":{" \
          "\"context\":{" \
            "\"type\":\"string\"," \
            "\"enum\":[\"profession\",\"emotion\",\"passions\",\"generalities\",\"subjective\"]" \
          "}," \
          "\"nodes\":{" \
            "\"type\":\"array\"," \
            "\"items\":{" \
              "\"type\":\"object\"," \
              "\"additionalProperties\":false," \
              "\"required\":[\"name\",\"weight\",\"activation\"]," \
              "\"properties\":{" \
                "\"name\":{\"type\":\"string\"}," \
                "\"weight\":{\"type\":[\"number\",\"null\"]}," \
                "\"activation\":{\"type\":[\"number\",\"null\"]}" \
              "}" \
            "}" \
          "}," \
          "\"connections\":{" \
            "\"type\":\"array\"," \
            "\"items\":{" \
              "\"type\":\"object\"," \
              "\"additionalProperties\":false," \
              "\"required\":[\"nodes\",\"weight\",\"activation\"]," \
              "\"properties\":{" \
                "\"nodes\":{" \
                  "\"type\":\"array\"," \
                  "\"minItems\":2," \
                  "\"maxItems\":2," \
                  "\"items\":{\"type\":\"string\"}" \
                "}," \
                "\"weight\":{\"type\":[\"number\",\"null\"]}," \
                "\"activation\":{\"type\":[\"number\",\"null\"]}" \
              "}" \
            "}" \
          "}" \
        "}" \
      "}" \
    "}," \
    "\"action_mocks\":{" \
      "\"type\":\"array\"," \
      "\"items\":{" \
        "\"anyOf\":[" \
          "{" \
            "\"type\":\"object\"," \
            "\"additionalProperties\":false," \
            "\"required\":[\"command\",\"percentage\",\"criteria\",\"intent\"]," \
            "\"properties\":{" \
              "\"command\":{\"type\":\"integer\"}," \
              "\"percentage\":{\"type\":[\"integer\",\"null\"]}," \
              "\"criteria\":{\"type\":[\"string\",\"null\"]}," \
              "\"intent\":{\"type\":[\"string\",\"null\"]}" \
            "}" \
          "}," \
          "{" \
            "\"type\":\"object\"," \
            "\"additionalProperties\":false," \
            "\"required\":[\"command\",\"percentage\",\"node\",\"criteria\",\"context\",\"intent\"]," \
            "\"properties\":{" \
              "\"command\":{\"type\":\"integer\"}," \
              "\"percentage\":{\"type\":[\"integer\",\"null\"]}," \
              "\"node\":{\"type\":[\"string\",\"null\"]}," \
              "\"criteria\":{\"type\":[\"string\",\"null\"]}," \
              "\"context\":{\"type\":[\"string\",\"null\"]}," \
              "\"intent\":{\"type\":[\"string\",\"null\"]}" \
            "}" \
          "}," \
          "{" \
            "\"type\":\"object\"," \
            "\"additionalProperties\":false," \
            "\"required\":[\"command\",\"node\",\"context\",\"percA\",\"percW\",\"depth\",\"intent\"]," \
            "\"properties\":{" \
              "\"command\":{\"type\":\"integer\"}," \
              "\"node\":{\"type\":[\"string\",\"null\"]}," \
              "\"context\":{\"type\":[\"string\",\"null\"]}," \
              "\"percA\":{\"type\":[\"integer\",\"null\"]}," \
              "\"percW\":{\"type\":[\"integer\",\"null\"]}," \
              "\"depth\":{\"type\":[\"integer\",\"null\"]}," \
              "\"intent\":{\"type\":[\"string\",\"null\"]}" \
            "}" \
          "}," \
          "{" \
            "\"type\":\"object\"," \
            "\"additionalProperties\":false," \
            "\"required\":[\"finished\",\"conclusion\"]," \
            "\"properties\":{" \
              "\"finished\":{\"type\":\"boolean\"}," \
              "\"conclusion\":{\"type\":\"string\"}" \
            "}" \
          "}" \
        "]" \
      "}" \
    "}" \
  "}" \
"}"

#define MKDIR(x) mkdir((x), 0755)

#ifndef PATH_CAP
#define PATH_CAP 512
#endif

_Bool RegenMocksOpenAI();

#endif
