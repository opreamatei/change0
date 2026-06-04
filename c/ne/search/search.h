#ifndef SEARCH_ENGINE_HEADER
#define SEARCH_ENGINE_HEADER

#include "node.h"
#include <stdint.h>

#define MAX_FAMILY_DEPTH 5

struct Connection* FindNeighbours(Node* node);

typedef double (*GetValueFn)(const void *elem);

void **FilterTopPercent(
    void *container,
    size_t containerSize,
    size_t elemSize,
    int_fast64_t percentage,
    size_t *count,
    GetValueFn getValue
);

Node** FilterNodeByActivationGlobal(int_fast64_t percentage, size_t *count, NodeContainer *nc);
Node** FilterNodeByWeightGlobal(int_fast64_t percentage, size_t *count, NodeContainer *nc);

Connection** FilterNodeNeighboursByActivation(
    Node* node,
    int_fast64_t percentage,
    size_t *count
);

Connection** FilterNodeNeighboursByWeight(
    Node* node,
    int_fast64_t percentage,
    size_t *count
);

char* ComputeNodeFamily(NodeContainer *nc, Node* node, int_fast64_t percA, int_fast64_t percW, size_t depth, size_t *length);

#endif
