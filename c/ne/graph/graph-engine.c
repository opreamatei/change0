#include "graph-engine.h"
#include "node.h"
#include "math.h"
#include "util.h"
#include <string.h>
#include "config.h"
#include <stdio.h>


// TODO
// 100 means every 100s the nodes half in activation
// It's actually denoted as lambda in a weird formula so you might want to be more accurate
// Don't forget to implement this in JS
static double decay_from_to(double value, time_t from, time_t to)
{
    double dt = difftime(to, from);
    if (dt <= 0.0) return value;

    // half-life = 100 seconds
    return value * pow(2.0, -dt / ACT_HALFTIME);
}


static void refresh_connection(Connection *c, time_t now, double boost_per_touch)
{
    if (!c) return;

    c->_activation = decay_from_to(c->_activation, c->lastTouched, now);

    // Then add pending touches
    //n->activation += boost_per_touch * (double)n->pendingActivationTouches;
    c->_activation += boost_per_touch * log1p((double)c->pendingTouches);// TODO Try to switch here to see if the formula is better, this is smoother

    c->pendingTouches = 0;
    c->lastTouched = now;
}

static void set_activation(Node *n, time_t now, double boost_per_touch)
{
    if (!n) return;

    n->_activation = decay_from_to(n->_activation, n->lastTouched, now);

    // Then add pending touches
    //n->activation += boost_per_touch * (double)n->pendingActivationTouches;
    n->_activation += boost_per_touch * log1p((double)n->pendingTouches);// TODO Try to switch here to see if the formula is better, this is smoother

    n->pendingTouches = 0;
    n->lastTouched = now;
}
				 
void RefreshGraph(){
	//if (!Nodes.needsRefresh) return;
	if (!Nodes.init || Nodes.count == 0) return;
	
	// decrease connection and activation on every instance
	time_t currTime = time(NULL);

	double k = ACTIVATION_IMPORTANCE_TO_NODE_WEIGHT;
	double c = NCOUNT_PENALTY_TO_NODE_WEIGHT; 
		
	double mx_seen = -1, mx_used = -1, mx_support = -1;

	double *support_buffer = malloc(sizeof(double) * Nodes.count);
	cassert(support_buffer, "Couldn't allocate memory for support\n");

	// compute maxes for normalziation
	for (size_t i = 0; i < Nodes.count; i++){
		Node* n = NodeAt(i);

		if (n->times_seen > mx_seen) mx_seen = n->times_seen;
		if (n->times_used > mx_used) mx_used = n->times_used;

		// calculate support
		double support = 0;

		for (size_t j = 0; j < n->ncount; j++){
			refresh_connection(&n->neighbours[j], currTime, CONN_ACT_INCR);
			support += read_connection_weight(&n->neighbours[j]) + k * read_connection_activation(&n->neighbours[j]);
		}

		support /= 1 + c * n->ncount;
		support_buffer[i] = support;

		if (support > mx_support) mx_support = support;
	}


	for (size_t i = 0; i < Nodes.count; i++){
		Node* n = NodeAt(i);

		double seen_norm = 0;
		double used_norm = 0;
		double support_norm = 0;

		if (mx_used > 0)
			used_norm = log1p(n->times_used) / log1p(mx_used);
		if (mx_seen > 0)
			seen_norm = log1p(n->times_seen) / log1p(mx_seen);
		if (mx_support > 0)
			support_norm = log1p(support_buffer[i]) / log1p(mx_support);

		// TODO turn scalars into constants
		double merit = SUPPORT_MERIT_TO_NODE_WEIGHT * support_norm + (1.0 - SUPPORT_MERIT_TO_NODE_WEIGHT) * used_norm;
		double confidence = seen_norm;
		double base = NODE_INIT_WGHT;
		double old_weight = n->_weight;
		double target_weight = confidence * merit + (1.0 - seen_norm) * base;

		// set weight
		n->_weight = NODE_OLD_WEIGHT_RELEVANCE * old_weight + (1.0 - NODE_OLD_WEIGHT_RELEVANCE) * target_weight;
		

		set_activation(n, currTime, NODE_ACT_INCR);
	}

	free(support_buffer);
	Nodes.needsRefresh = 0;
}

