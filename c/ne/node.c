#include <inttypes.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <math.h>

#include "node.h"
#include "../lib/util/util.h"

const char context_labels[CONTEXT_COUNT][NODE_LABEL_CAP] = {
	"profesie",
	"emotie",
	"pasiuni",
	"generalitati",
	"subiectiv",
};

_Bool FreeNodes(NodeContainer *nc){
	if (nc->items != NULL){
		free(nc->items);
		nc->items = NULL;
	}
	nc->capacity = 0;
	nc->count = 0;
	nc->init = 0;

	return 1;
}

_Bool InitNodes(NodeContainer *nc){
	if (nc->init) FreeNodes(nc);

	nc->capacity = INIT_NODE_CAP;
	nc->count = 0;
	nc->items = (Node*)malloc(sizeof(Node) * INIT_NODE_CAP);
	nc->needsRefresh = 0;
	nc->connection_count = 0;
	for (int i = 0; i < CONTEXT_COUNT; i++) nc->contexts[i] = 0;

	if (nc->items == NULL) {
		nc->capacity = 0;
		nc->init = 0;
		return 0;
	}

	nc->init = 1;
	return 1;
}

// Parent can be Nullable
Node* AddNodeEx(NodeContainer *nc, const char* label, size_t label_len, double activation, double weight, _Bool hasParent, size_t parent, _Bool fertile, time_t now){
	if (!label || !nc->init || !nc->items) return NULL;
	if (label_len > NODE_LABEL_CAP - 2) label_len = NODE_LABEL_CAP - 2;

	if (nc->count >= nc->capacity) {
		size_t new_capacity = MAX(INIT_NODE_CAP, nc->capacity) * 2;
		Node* tmp = realloc(nc->items, sizeof(Node) * new_capacity);
		if (tmp == NULL){
			fprintf(stderr, "Error: Couldn't allocate more memory to add nodes");
			return NULL;
		};
		nc->items = tmp;
		nc->capacity = new_capacity;
	}

	Node* node = NodeAt(nc, nc->count);
	node->labelLength = label_len;
	node->nsize = NODE_NBRS_CAP;
	node->ncount = 0;
	node->globalIndex = nc->count;
	node->neighbours = malloc(node->nsize * sizeof(Connection));
	node->_activation = activation;
	node->_weight = weight;
	node->hasParent = 0;
	node->times_seen = 0;
	node->times_used = 0;

	node->lastTouched = now;
	node->pendingTouches = 0;

	memcpy(node->label, label, node->labelLength);
	node->label[node->labelLength] = '\0';
	char *lp = node->label;
	lowerAll(&lp, node->labelLength);

	if (hasParent && NodeExists(nc, parent)){
		dic_add(NodeAt(nc, parent)->childrenIndex, node->label, node->labelLength);
		*(NodeAt(nc, parent)->childrenIndex->value) = node->globalIndex;
		node->parent = parent;
		node->hasParent = 1;
	}

	if (fertile)
		node->childrenIndex = dic_new(INIT_CHILDREN_COUNT);
	else
		node->childrenIndex = NULL;

	nc->count++;

	return node;
}

Connection* LinkExists(Node* A, Node* B){
	for (size_t i = 0; i < A->ncount; i++){
		if (A->neighbours[i].target == B->globalIndex){
			return &(A->neighbours[i]);
		};
	}

	for (size_t i = 0; i < B->ncount; i++){
		if (B->neighbours[i].target == A->globalIndex){
			return &(B->neighbours[i]);
		};
	}

	return NULL;
}

// Unidirectional Linkage
// Danger: Always check the Link doesn't exist to avoid overriding
_Bool UniLinkEx(NodeContainer *nc, Node* A, Node* B, double activation, double weight){
	if (!A || !B) return 0;

	long a = A->ncount;

	if (a >= A->nsize){
		size_t new_capacity = MAX(NODE_NBRS_CAP, A->nsize * 2);
		Connection* tmp = (Connection*)realloc(A->neighbours, new_capacity * sizeof(Connection));
		if (!tmp){
			fprintf(stderr, "Failed to allocate memory for node neighbour\n");
			return 0;
		}
		A->neighbours = tmp;
		A->nsize = new_capacity;
	}

	Connection* c = A->neighbours + A->ncount;

	c->_activation = activation;
	c->_weight = weight;

	c->target = B->globalIndex;

	c->lastTouched = change_time_now();
	c->pendingTouches = 0;

	A->ncount++;

	nc->connection_count++;

	return 1;
}

_Bool UniLink(NodeContainer *nc, Node* A, Node* B){
	return UniLinkEx(nc, A, B, NODE_INIT_ACT, NODE_INIT_WGHT);
}

// Bidirectional Linkage
_Bool BiLink(NodeContainer *nc, Node* A, Node* B){
	return UniLink(nc, A, B) && UniLink(nc, B, A);
}

_Bool BiLinkEx(NodeContainer *nc, Node* A, Node* B, double activation, double weight){
	return UniLinkEx(nc, A, B, activation, weight) && UniLinkEx(nc, B, A, activation, weight);
}

// TODO : Remove lowerAll by assuring it's imposibile for uppercase characters to appear in the first place.
Node* FindNode(NodeContainer *nc, char* target, uint_fast8_t length, Node* parent){
	if (parent == NULL || target == NULL || length == 0) return NULL;
	lowerAll(&target, (size_t) length);

	if (dic_find(parent->childrenIndex, (void*)target, length)){
		long index = *parent->childrenIndex->value;
		if (index < 0 || (size_t)index >= nc->count) return NULL;
		return NodeAt(nc, index);
	}
	return NULL;
}

Node* FindNodeGlobal(NodeContainer *nc, char* target, uint_fast8_t length, size_t stop){
	if(stop == 0) stop = nc->count;

	for (size_t i = 0; i < stop; i++)
		if (strcmp(NodeAt(nc, i)->label, target) == 0)
			return NodeAt(nc, i);

	return 0;
}

void SetupContextNodes(NodeContainer *nc) {
	time_t now = change_time_now();
	for (int i = 0; i < CONTEXT_COUNT; i++) {
		Node *n = AddNodeEx(nc, context_labels[i], strlen(context_labels[i]), NODE_INIT_ACT, NODE_INIT_WGHT, PARENTLESS, 0, FERTILE, now);
		change_assert(n, "Critical: couldn't initialize context node [%d]\n", i);
		nc->contexts[i] = n->globalIndex;
	}
}

double read_node_activation(NodeContainer *nc, Node* n){
    double o = n->_activation;
    while (n->hasParent){
        n = NodeAt(nc, n->parent);
        if (!n) break;
        o *= n->_activation;
    }
    return o;
}

double read_node_weight(NodeContainer *nc, Node* n){
    double o = n->_weight;
    while (n->hasParent){
        n = NodeAt(nc, n->parent);
        if (!n) break;
        o *= n->_weight;
    }
    return o;
}

double read_connection_activation(NodeContainer *nc, Connection* c){
    double o = c->_activation;
    Node *n = NodeAt(nc, c->target);
    while (n && n->hasParent){
        n = NodeAt(nc, n->parent);
        if (!n) break;
        o *= n->_activation;
    }
    return o;
}

double read_connection_weight(NodeContainer *nc, Connection* c){
    double o = c->_weight;
    Node *n = NodeAt(nc, c->target);
    while (n && n->hasParent){
        n = NodeAt(nc, n->parent);
        if (!n) break;
        o *= n->_weight;
    }
    return o;
}

// TODO make lamda time modifyiable in JS
static double decay_from_to(double value, time_t from, time_t to)
{
    double dt = difftime(to, from);
    if (dt <= 0.0) return value;

    // half-life = 100 seconds
    return value * pow(2.0, -dt / 100.0);
}

void touch_node(Node *n, double power, time_t now)
{
    if (!n) return;
    n->lastTouched = now;
    n->pendingTouches += log1p(power);
}

void touch_connection(Connection *c, double power, time_t now){
    if (!c) return;
    c->lastTouched = now;
    c->pendingTouches += log1p(power);
}
