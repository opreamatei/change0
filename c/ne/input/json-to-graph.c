#include "json-to-graph.h"
#include "json.h"
#include "util.h"
#include "time.h"
#include "node.h"
#include "string.h"
#include "config.h"
#include <stddef.h>

static void AddNodeFromEntry(json_value *val, size_t context, time_t now){
	if (val->type != json_object) return;
	if (val->u.object.length == 0) return;

	char name[32] = "\0";
	_Bool constructable = 0;
	double activation = NODE_INIT_ACT;
	double weight = NODE_INIT_WGHT;
	size_t len;

	for (size_t i = 0; i < val->u.object.length; i++){
		json_object_entry entry = val->u.object.values[i];

		// Node {name, activation}

		if (!strcmp(entry.name, "name") && entry.value->type == json_string){
			// Constructing a name for the Node
			len = MIN(31, entry.value->u.string.length);
			memcpy(name, entry.value->u.string.ptr, len);
			name[len] = '\0';
			constructable = 1;
		} else if (!strcmp(entry.name, "activation")){
			if (entry.value->type == json_double){
				activation = entry.value->u.dbl;
			}else if (entry.value->type == json_integer){
				activation = (double)entry.value->u.integer;
			}
		}else if (!strcmp(entry.name, "weight")){
			if (entry.value->type == json_double){
				weight = entry.value->u.dbl;
			}else if (entry.value->type == json_integer){
				weight = (double)entry.value->u.integer;
			}
		}

	}

	if (!constructable) return;

	// TODO Quick reminder this only makes sense if NODE_INIT_ACT is 1.0 (same for the connections below)
	Node* existing = FindNode(name, len, NodeAt(context));
	if (existing)
		touch_node(existing, activation, now);
	else
		AddNodeEx(name, len, activation, NODE_INIT_WGHT + ( weight - NODE_INIT_WGHT ) * NODE_GUESS_WEIGHT_RELEVANCE , 1, context, 0, now);

}

static void AddNodesFromEntry(json_object_entry* entry, size_t context){
	if (!entry->value) return;
	if (entry->value->type != json_array || entry->value->u.array.length == 0) return;

	time_t now = time(NULL);
	for (size_t i = 0; i < entry->value->u.array.length; i++){
		AddNodeFromEntry(entry->value->u.array.values[i], context, now);
	}
	
}

static _Bool ProcessArrayLinkage(json_value *entry, double weight, double activation, size_t context, time_t now){
	if (!entry) return 0;

	if (entry->type != json_array || entry->u.array.length != 2) return 0;

	json_value* a = entry->u.array.values[0];
	json_value* b = entry->u.array.values[1];


	cassert(a->type == json_string && b->type == json_string, "Error: Nodes are not strings");

	Node* A = FindNode(a->u.string.ptr, a->u.string.length, NodeAt(context));
	if (!A) return 0;
	A->lastTouched = time(NULL);
	Node* B = FindNode(b->u.string.ptr, b->u.string.length, NodeAt(context));
	if (!B) return 0;
	B->lastTouched = time(NULL);

	Connection* existing = LinkExists(A, B);

	if(existing)
		touch_connection(existing, activation, now);
	else{
	 	BiLink(A, B);
		Connection* ab = A->neighbours + A->ncount - 1;
		Connection* ba = B->neighbours + B->ncount - 1;
		
		ab->_activation += activation * 0.1;
		ab->_weight += ( weight - CONN_INIT_WGHT ) * CONNECTION_GUESS_WEIGHT_RELEVANCE;

		ba->_activation += activation * 0.1;
		ba->_weight += ( weight - CONN_INIT_WGHT ) * CONNECTION_GUESS_WEIGHT_RELEVANCE;
	}

	return 1;
}

// link a->b b->c c->d d->a
static void AddConnectionFromEntry(json_value* val, size_t context, time_t now){
	if (!val) return;
	//cassert(ProcessArrayLinkage(val, NODE_INIT_ACT, NODE_INIT_WGHT, context), "Problem when direct adding nodes"); // just in case we're working with a direct array
	if (val->type != json_object) return;
	
	double activation = NODE_INIT_ACT;
	double weight = NODE_INIT_WGHT;
	json_value* arr = NULL;

	for (size_t i = 0; i < val->u.object.length; i++){
		json_object_entry entry = val->u.object.values[i];
		if (!strcmp(entry.name, "nodes")){
			arr = entry.value;
		} else if (!strcmp(entry.name, "activation")){
			if (entry.value->type == json_double){
				activation = entry.value->u.dbl;
			}else if (entry.value->type == json_integer){
				activation = (double)entry.value->u.integer;
			}
		} else if (!strcmp(entry.name, "weight")){
			if (entry.value->type == json_double){
				weight = entry.value->u.dbl;
			}else if (entry.value->type == json_integer){
				weight = (double)entry.value->u.integer;
			}
		}
	}

	cassert(ProcessArrayLinkage(arr, weight, activation, context, now), "Problem when creaing connections list, btw size must be two.");
	
}

static void AddConnectionsFromEntry(json_object_entry* entry, size_t context){
	if (entry->value == NULL) return;
	if (entry->value->type != json_array) return;

	time_t now = time(NULL);
	for (size_t i = 0; i < entry->value->u.array.length; i++)
		// Adding a connection
		AddConnectionFromEntry(entry->value->u.array.values[i], context, now);

}

_Bool AddContextNodesFromJSON(char* context_name, size_t context_size, json_value* root){
	cassert(root, "No context data provided. Json entry.\n");

	cassert(root->type == json_object, "Context provided, but is not an object \n");

	Node* context = FindNodeGlobal(context_name, context_size, CONTEXT_COUNT);
	cassert(context, "Context not found. Be carefull, there is also an edge case where the context exists but is not withing the first CONTEXT_COUNT nodes.\n");

	size_t context_id = context->globalIndex;

	for (size_t i = 0; i < root->u.object.length; i++){
		json_object_entry entry = root->u.object.values[i];
		if (strcmp(entry.name, "nodes") == 0) AddNodesFromEntry(&entry, context_id);
		else if(strcmp(entry.name, "connections") == 0) AddConnectionsFromEntry(&entry, context_id);
	}

	printf("JSON parsed successfully\n\n");

	return 1;
}

void LoadGraphFromFile(char* path){

	FreeNodes();
	InitNodes();

	size_t len = 0;
	char* buff = readFile(path, &len);

	if (massert(buff, "Coudln't load graph from file\n")){
		return;
	}

	json_value* doc = json_parse(buff, len);
	change_assert(doc, "Couldn't load object from file: [%s], len [%zu]\n", buff, len);
	change_assert(doc->type == json_object, "Loaded file is JSON, but not an objects [%s]\n", buff);

	time_t now = time(NULL);

	for (size_t i = 0; i < doc->u.object.length; i++){
		json_object_entry entry = doc->u.object.values[i];

		if (strcmp(entry.name, "nodes") == 0){

			// add nodes
			change_assert(entry.value->type == json_array, "Nodes are not an array [%s]", buff);

			for (size_t j = 0; j < entry.value->u.array.length; j++){
				json_value *node_val = entry.value->u.array.values[j];

				String name;
				InitString(&name, NODE_LABEL_CAP + 2);

				uint64_t id = UINT64_MAX;
				uint64_t parent = UINT64_MAX;
				_Bool has_parent = 0;

				double activation = NODE_INIT_ACT;
				double weight = NODE_INIT_WGHT;

				_Bool has_name = 0;
				_Bool has_id = 0;

				change_assert(
						node_val->type == json_object,
						"Some node is not an object\n at pos [%zu] file [%s]",
						j,
						buff
					     );

				for (size_t k = 0; k < node_val->u.object.length; k++) {
					json_object_entry property = node_val->u.object.values[k];

					if (strcmp(property.name, "name") == 0) {
						change_assert(
								property.value->type == json_string,
								"Name is not a string on some node [%s]",
								buff
							     );

						CatString(&name, property.value->u.string.ptr, property.value->u.string.length);
						has_name = 1;
					}
					else if (strcmp(property.name, "id") == 0) {
						change_assert(
								property.value->type == json_integer,
								"ID is not an integer on node [%s]",
								buff
							     );

						change_assert(
								property.value->u.integer >= 0,
								"ID is negative on node [%s]",
								buff
							     );

						id = (uint64_t)property.value->u.integer;
						has_id = 1;
					}
					else if (strcmp(property.name, "parent") == 0) {
						change_assert(
								property.value->type == json_integer,
								"Parent is not an integer on node [%s]",
								buff
							     );

						change_assert(
								property.value->u.integer >= 0,
								"Parent is negative on node [%s]",
								buff
							     );

						parent = (uint64_t)property.value->u.integer;
						has_parent = 1;
					}
					else if (strcmp(property.name, "activation") == 0) {
						change_assert(
								property.value->type == json_double || property.value->type == json_integer,
								"Activation is not a number on node [%s]",
								buff
							     );

						if (property.value->type == json_double)
							activation = property.value->u.dbl;
						else
							activation = (double)property.value->u.integer;
					}
					else if (strcmp(property.name, "weight") == 0) {
						change_assert(
								property.value->type == json_double || property.value->type == json_integer,
								"Weight is not a number on node [%s]",
								buff
							     );

						if (property.value->type == json_double)
							weight = property.value->u.dbl;
						else
							weight = (double)property.value->u.integer;
					}
				}

				change_assert(
						has_name,
						"Node has no name at pos [%zu] file [%s]",
						j,
						buff
					     );

				change_assert(
						has_id,
						"Node has no id at pos [%zu] file [%s]",
						j,
						buff
					     );

				AddNodeEx(name.p, name.len, activation, weight, has_parent, (size_t)parent, 1, now);

				FreeString(&name);

			}

		}else if(strcmp(entry.name, "connections") == 0){
			change_assert(entry.value->type == json_array, "Connections are not an array [%s]", buff);

			for (size_t j = 0; j < entry.value->u.array.length; j++){
				json_value *conn_val = entry.value->u.array.values[j];

				uint64_t A_id = UINT64_MAX;
				uint64_t B_id = UINT64_MAX;

				double activation = 1.0;
				double weight = 1.0;

				_Bool has_nodes = 0;

				change_assert(
						conn_val->type == json_object,
						"Some connection is not an object\n at pos [%zu] file [%s]",
						j,
						buff
					     );

				for (size_t k = 0; k < conn_val->u.object.length; k++){
					json_object_entry property = conn_val->u.object.values[k];

					if (strcmp(property.name, "nodes") == 0){
						change_assert(
								property.value->type == json_array,
								"Connection nodes is not an array [%s]",
								buff
							     );

						change_assert(
								property.value->u.array.length == 2,
								"Connection nodes array doesn't have exactly 2 elements at pos [%zu] file [%s]",
								j,
								buff
							     );

						json_value *A_val = property.value->u.array.values[0];
						json_value *B_val = property.value->u.array.values[1];

						change_assert(
								A_val->type == json_integer && B_val->type == json_integer,
								"Connection nodes are not integers at pos [%zu] file [%s]",
								j,
								buff
							     );

						change_assert(
								A_val->u.integer >= 0 && B_val->u.integer >= 0,
								"Connection nodes contain negative ids at pos [%zu] file [%s]",
								j,
								buff
							     );

						A_id = (uint64_t)A_val->u.integer;
						B_id = (uint64_t)B_val->u.integer;

						has_nodes = 1;
					}
					else if (strcmp(property.name, "activation") == 0){
						change_assert(
								property.value->type == json_double || property.value->type == json_integer,
								"Connection activation is not a number at pos [%zu] file [%s]",
								j,
								buff
							     );

						if (property.value->type == json_double)
							activation = property.value->u.dbl;
						else
							activation = (double)property.value->u.integer;
					}
					else if (strcmp(property.name, "weight") == 0){
						change_assert(
								property.value->type == json_double || property.value->type == json_integer,
								"Connection weight is not a number at pos [%zu] file [%s]",
								j,
								buff
							     );

						if (property.value->type == json_double)
							weight = property.value->u.dbl;
						else
							weight = (double)property.value->u.integer;
					}
				}

				change_assert(
						has_nodes,
						"Connection has no nodes field at pos [%zu] file [%s]",
						j,
						buff
					     );

				Node *A = NodeAt((size_t)A_id);
				Node *B = NodeAt((size_t)B_id);

				change_assert(
						A,
						"Connection references missing A node id [%zu] at pos [%zu] file [%s]",
						(size_t)A_id,
						j,
						buff
					     );

				change_assert(
						B,
						"Connection references missing B node id [%zu] at pos [%zu] file [%s]",
						(size_t)B_id,
						j,
						buff
					     );

				BiLinkEx(A, B, activation, weight);
			}
		}
	}

	json_value_free(doc);
}
