#ifndef NEUROENGINE_EXPORT
#define NEUROENGINE_EXPORT

#include <stddef.h>
#include "node.h"

_Bool ExportGraphTo(char *path, NodeContainer *nc);

char *SeriliazeGraph(NodeContainer *nc);

#endif
