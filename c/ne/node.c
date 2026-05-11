#include <inttypes.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <math.h>

#include "node.h"
#include "../lib/util/util.h"

_Bool FreeNodes(){
	if (Nodes.items != NULL){
		free(Nodes.items);
		Nodes.items = NULL;
	}
	Nodes.capacity = 0;
	Nodes.count = 0;
	Nodes.init = 0;

	return 1;
}

_Bool InitNodes(){
	if (Nodes.init) FreeNodes();

	Nodes.capacity = INIT_NODE_CAP;
	Nodes.count = 0;
	Nodes.items = (Node*)malloc(sizeof(Node) * INIT_NODE_CAP);
	Nodes.needsRefresh = 0;

	if (Nodes.items == NULL) {
		Nodes.capacity = 0;
		Nodes.init = 0;
		return 0;
	}

	Nodes.init = 1;
	return 1;
}

// Parent can be Nullable
Node* AddNodeEx(char* label, size_t label_len, double activation, double weight, _Bool hasParent, size_t parent, _Bool fertile, time_t now){
	if (!label || !Nodes.init || !Nodes.items) return NULL;
	if (label_len > NODE_LABEL_CAP - 2) label[NODE_LABEL_CAP-1] = '\0';

	if (Nodes.count >= Nodes.capacity) {
		size_t new_capacity = MAX(INIT_NODE_CAP,Nodes.capacity) * 2;
		Node* tmp = realloc( Nodes.items, sizeof(Node) * new_capacity);
		if (tmp == NULL){
			fprintf(stderr, "Error: Couldn't allocate more memory to add nodes");
			return NULL;
		};
		Nodes.items = tmp;
		Nodes.capacity = new_capacity;
	}
	
	lowerAll(&label, label_len);

	Node* node = NodeAt(Nodes.count);
	node->labelLength = label_len;
	node->nsize = NODE_NBRS_CAP;
	node->ncount = 0;
	node->globalIndex = Nodes.count;
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

	if (hasParent && NodeExists(parent)){
		dic_add(NodeAt(parent)->childrenIndex, node->label, node->labelLength);
		*(NodeAt(parent)->childrenIndex->value) = node->globalIndex;
		node->parent = parent;
		node->hasParent = 1;
	}

	if (fertile)
		node->childrenIndex = dic_new(INIT_CHILDREN_COUNT);
	else
		node->childrenIndex = NULL;

	Nodes.count ++;

	return node;
}

Connection* LinkExists(Node* A, Node* B){
	// scan if A already contains B
	// TODO make this faster than O(A neighbours)
	
	for (size_t i = 0; i < A->ncount; i++){
		if (A->neighbours[i].target == B->globalIndex){
			// HIT
			// TODO when adding a new connection, increase activation based on its initial activation
			return &(A->neighbours[i]);
		};
	}

	for (size_t i = 0; i < B->ncount; i++){
		if (B->neighbours[i].target == A->globalIndex){
			// HIT
			// TODO when adding a new connection, increase activation based on its initial activation
			return &(B->neighbours[i]);
		};
	}

	return NULL;
}

// Unidirectional Linkage
// Danger: Always check the Link doesn't exist to avoid overriding
_Bool UniLinkEx(Node* A, Node* B, double activation, double weight){
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

	A->ncount ++;

	ConnectionCount ++;

	return 1;
}

_Bool UniLink(Node* A, Node* B){
	return UniLinkEx(A, B, NODE_INIT_ACT, NODE_INIT_WGHT);
}

// Bidirectional Linkage
_Bool BiLink(Node* A, Node* B){
	return UniLink(A, B) && UniLink(B, A);
}

_Bool BiLinkEx(Node* A, Node* B, double activation, double weight){
	return UniLinkEx(A, B, activation, weight) && UniLinkEx(B, A, activation, weight);
}

// TODO : Remove lowerAll by assuring it's imposibile for uppercase characters to appear in the first place.
Node* FindNode(char* target, uint_fast8_t length, Node* parent){
	if (parent == NULL || target == NULL || length == 0) return NULL;
	lowerAll(&target, (size_t) length);

	if (dic_find(parent->childrenIndex, (void*)target, length)){
		long index = *parent->childrenIndex->value;
		if (index < 0 || index >= Nodes.count) return NULL;
		return NodeAt(index);
	}
	return NULL;
}

Node* FindNodeGlobal(char* target, uint_fast8_t length, size_t stop){
	if(stop == 0) stop = Nodes.count;

	for (size_t i = 0; i < stop; i++)
		if (strcmp(NodeAt(i)->label, target) == 0)
			return NodeAt(i);

	return 0;
}

double read_node_activation(Node* n){
    double o = n->_activation;
    while (n->hasParent){
        n = NodeAt(n->parent);
        if (!n) break;
        o *= n->_activation;
    }
    return o;
}

double read_node_weight(Node* n){
    double o = n->_weight;
    while (n->hasParent){
        n = NodeAt(n->parent);
        if (!n) break;
        o *= n->_weight;
    }
    return o;
}

double read_connection_activation(Connection* c){
    double o = c->_activation;  
    Node *n = NodeAt(c->target);
    while (n && n->hasParent){
        n = NodeAt(n->parent);
        if (!n) break;
        o *= n->_activation; 
    }
    return o;
}

double read_connection_weight(Connection* c){
    double o = c->_weight;
    Node *n = NodeAt(c->target);
    while (n && n->hasParent){
        n = NodeAt(n->parent);
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
