#ifndef NE_NODES
#define NE_NODES

#include <stddef.h>
#include <stdint.h>
#include "time.h"
#include "hashdict.h"
#include "util.h"

#define CONTEXT_COUNT 5

#define INIT_NODE_CAP 16
#define NODE_LABEL_CAP 32
#define NODE_NBRS_CAP 4 // NEIGHBOURS

#define NODE_ACT_DECAY 0.95
#define NODE_WGHT_DECAY 0.99
#define CONN_ACT_DECAY 0.95
#define CONN_WGT_DECAY 0.99

#define NODE_ACT_INCR 0.5
#define NODE_WGHT_INCR 0.01
#define CONN_ACT_INCR 0.5
#define CONN_WGHT_INCR 0.01

#define NODE_INIT_ACT 1
#define NODE_INIT_WGHT 1

#define CONN_INIT_ACT 1
#define CONN_INIT_WGHT 1

#define INIT_CHILDREN_COUNT 256

#define INFERTILE 0
#define FERTILE 1
#define HASPARENT 1
#define PARENTLESS 0

typedef struct NodeType {
	char label[NODE_LABEL_CAP];
	_Bool hasParent;
	uint_fast8_t labelLength;

	double _weight;
	double _activation;

	struct ConnectionType *neighbours;
	size_t nsize, ncount, globalIndex;

	// for activation
	time_t lastTouched;
	double pendingTouches;

	uint_fast64_t times_seen;
	uint_fast64_t times_used;

	size_t parent;
	struct dictionary *childrenIndex;
} Node;

typedef struct ConnectionType {
	double _activation;
	double _weight;
	time_t lastTouched;
	uint_fast32_t pendingTouches;
	size_t target;
} Connection;

typedef struct {
	Node *items;
	size_t capacity;
	size_t count;
	_Bool needsRefresh;
	_Bool init;
	size_t connection_count;
	size_t contexts[CONTEXT_COUNT];
} NodeContainer;

typedef struct {
	String name;
	size_t minDepth;
} Task;

extern const char context_labels[CONTEXT_COUNT][NODE_LABEL_CAP];

#define NodeAt(nc, i) ((nc)->items + (i))
#define NodeExists(nc, i) ((i) < (nc)->count)

_Bool InitNodes(NodeContainer *nc);
_Bool FreeNodes(NodeContainer *nc);

Node* FindNode(NodeContainer *nc, char* target, uint_fast8_t length, Node* parent);
Node* FindNodeGlobal(NodeContainer *nc, char* target, uint_fast8_t length, size_t stop);

Node* AddNodeEx(
		NodeContainer *nc,
		const char* label,
		size_t label_len,
		double activation,
		double weight,
		_Bool hasParent,
		size_t parent,
		_Bool fertile,
		time_t now
	       );

Connection* LinkExists(Node* A, Node* B);

_Bool UniLinkEx(NodeContainer *nc, Node* A, Node* B, double activation, double weight);
_Bool UniLink(NodeContainer *nc, Node* A, Node* B);
_Bool BiLink(NodeContainer *nc, Node* A, Node* B);
_Bool BiLinkEx(NodeContainer *nc, Node* A, Node* B, double activation, double weight);

double read_node_activation(NodeContainer *nc, Node* n);
double read_node_weight(NodeContainer *nc, Node* n);
double read_connection_activation(NodeContainer *nc, Connection* c);
double read_connection_weight(NodeContainer *nc, Connection* c);

void touch_node(Node *n, double power, time_t now);
void touch_connection(Connection *n, double power, time_t now);

void SetupContextNodes(NodeContainer *nc);

#endif
