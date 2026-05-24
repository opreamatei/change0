#ifndef MATCH_SYSTEM_INTERNAL_H
#define MATCH_SYSTEM_INTERNAL_H

#include "../connections.h"
#include "config.h"
#include "lib/jsonp/json.h"
#include "lib/util/change-errors.h"
#include "lib/util/time-util.h"
#include "lib/util/util.h"
#include "openai.h"

#include <dirent.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define CONN_DIR PROJECT_ROOT "user-data/connections/"
#define CONN_EXT ".conn"
#define MSG_EXT  ".msgs"

extern UserConn ConnectionTable[MAX_CONNECTIONS];
extern size_t ConnectionCount;
extern UserConnMessage MessageTable[MAX_MESSAGES];
extern size_t MessageCount;
extern pthread_mutex_t conn_lock;

void copy_match_result(MatchResult *dst, const MatchResult *src);
size_t dedupe_match_results(
	const MatchResult *src, size_t src_count,
	MatchResult *dst, size_t dst_max);

size_t ai_find_matches(
	const User *a,
	User **candidates, size_t candidate_count,
	MatchResult *out, size_t out_max);

size_t ai_pick_final_matches(
	const User *a,
	User **candidates,
	const MatchResult *shortlist, size_t shortlist_count,
	MatchResult *out, size_t out_max);

void ensure_conn_dir(void);
void conn_path(const char *id, const char *ext, char *out, size_t out_size);
void persist_connection(const UserConn *c);
void append_message_to_file(const UserConnMessage *m);
UserConn *find_pair(const char *a, const char *b);

#endif
