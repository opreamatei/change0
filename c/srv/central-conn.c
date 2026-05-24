#include "central-internal.h"
#include "http-util.h"
#include "connections.h"
#include "user-management.h"
#include "util.h"

#include <stdlib.h>
#include <string.h>

void handle_conn_discoverable(int fd, CentralRequest *req)
{
	char *user_id = extract_string_field(req->body, req->body_len, "user_id");
	char *desc    = extract_string_field(req->body, req->body_len, "description");
	if (!user_id || !*user_id) {
		free(user_id); free(desc);
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_user_id\"}");
		return;
	}
	User *u = FindUserByID(user_id);
	free(user_id);
	if (!u) {
		free(desc);
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"user_not_found\"}");
		return;
	}
	SetUserDiscoverable(u, desc ? desc : "");
	free(desc);
	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

void handle_conn_private(int fd, CentralRequest *req)
{
	char *user_id = extract_string_field(req->body, req->body_len, "user_id");
	if (!user_id || !*user_id) {
		free(user_id);
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_user_id\"}");
		return;
	}
	User *u = FindUserByID(user_id);
	free(user_id);
	if (!u) {
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"user_not_found\"}");
		return;
	}
	SetUserPrivate(u);
	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

void handle_conn_update_description(int fd, CentralRequest *req)
{
	char *user_id = extract_string_field(req->body, req->body_len, "user_id");
	char *desc    = extract_string_field(req->body, req->body_len, "description");
	if (!user_id || !*user_id) {
		free(user_id); free(desc);
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_user_id\"}");
		return;
	}
	User *u = FindUserByID(user_id);
	free(user_id);
	if (!u) {
		free(desc);
		http_send_json(fd, 404, "Not Found", "{\"ok\":false,\"error\":\"user_not_found\"}");
		return;
	}
	UpdateUserDescription(u, desc ? desc : "");
	free(desc);
	http_send_json(fd, 200, "OK", "{\"ok\":true}");
}

void handle_conn_list(int fd, const char *query)
{
	char user_id[USER_ID_SIZE] = {0};
	if (query) {
		const char *p = strstr(query, "user_id=");
		if (p) {
			p += 8;
			size_t i = 0;
			while (*p && *p != '&' && i < USER_ID_SIZE - 1)
				user_id[i++] = *p++;
			user_id[i] = '\0';
		}
	}
	if (!user_id[0]) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_user_id\"}");
		return;
	}

	UserConn *conns[MAX_CONNECTIONS];
	size_t n = ListConnsForUser(user_id, conns, MAX_CONNECTIONS);

	String out;
	InitString(&out, 512);
	CatFixed(&out, "{\"ok\":true,\"connections\":[");
	for (size_t i = 0; i < n; i++) {
		UserConn *c = conns[i];
		User *other  = OtherUserInConn(c, user_id);
		char *other_name = other ? json_escape_dup(other->name.p ? other->name.p : "") : NULL;
		char *reason_esc = json_escape_dup(c->reason);
		int am_a = strcmp(c->a, user_id) == 0;
		CatTemplateString(&out,
			"%s{\"id\":\"%s\",\"state\":%d,"
			"\"my_approved\":%s,\"their_approved\":%s,"
			"\"other_name\":\"%s\",\"reason\":\"%s\","
			"\"proposed_at\":%lld}",
			i == 0 ? "" : ",",
			c->id, (int)c->state,
			(am_a ? c->a_approved : c->b_approved) ? "true" : "false",
			(am_a ? c->b_approved : c->a_approved) ? "true" : "false",
			other_name ? other_name : "unknown",
			reason_esc,
			(long long)c->proposed_at);
		free(reason_esc);
		free(other_name);
	}
	CatFixed(&out, "]}");
	http_send_json(fd, 200, "OK", c_str(&out));
	FreeString(&out);
}

void handle_conn_approve(int fd, CentralRequest *req)
{
	char *conn_id = extract_string_field(req->body, req->body_len, "connection_id");
	char *user_id = extract_string_field(req->body, req->body_len, "user_id");
	if (!conn_id || !user_id) {
		free(conn_id); free(user_id);
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_fields\"}");
		return;
	}
	_Bool ok = ApproveConn(conn_id, user_id);
	free(conn_id); free(user_id);
	http_send_json(fd, 200, "OK", ok ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"approve_failed\"}");
}

void handle_conn_decline(int fd, CentralRequest *req)
{
	char *conn_id = extract_string_field(req->body, req->body_len, "connection_id");
	char *user_id = extract_string_field(req->body, req->body_len, "user_id");
	if (!conn_id || !user_id) {
		free(conn_id); free(user_id);
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_fields\"}");
		return;
	}
	_Bool ok = DeclineConn(conn_id, user_id);
	free(conn_id); free(user_id);
	http_send_json(fd, 200, "OK", ok ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"decline_failed\"}");
}

void handle_msg_send(int fd, CentralRequest *req)
{
	char *conn_id   = extract_string_field(req->body, req->body_len, "connection_id");
	char *sender_id = extract_string_field(req->body, req->body_len, "sender_id");
	char *text      = extract_string_field(req->body, req->body_len, "text");
	if (!conn_id || !sender_id || !text) {
		free(conn_id); free(sender_id); free(text);
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_fields\"}");
		return;
	}
	_Bool ok = SendUserConnMessage(conn_id, sender_id, text);
	free(conn_id); free(sender_id); free(text);
	http_send_json(fd, 200, "OK", ok ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"send_failed\"}");
}

void handle_msg_list(int fd, const char *query)
{
	char conn_id[CONNECTION_ID_SIZE] = {0};
	if (query) {
		const char *p = strstr(query, "connection_id=");
		if (p) {
			p += 14;
			size_t i = 0;
			while (*p && *p != '&' && i < CONNECTION_ID_SIZE - 1)
				conn_id[i++] = *p++;
			conn_id[i] = '\0';
		}
	}
	if (!conn_id[0]) {
		http_send_json(fd, 400, "Bad Request", "{\"ok\":false,\"error\":\"missing_connection_id\"}");
		return;
	}

	UserConnMessage *msgs[MAX_MESSAGES];
	size_t n = ListConnMessages(conn_id, msgs, MAX_MESSAGES);

	String out;
	InitString(&out, 512);
	CatFixed(&out, "{\"ok\":true,\"messages\":[");
	for (size_t i = 0; i < n; i++) {
		UserConnMessage *m = msgs[i];
		char *text_esc = json_escape_dup(m->text);
		CatTemplateString(&out,
			"%s{\"sender\":\"%s\",\"at\":%lld,\"text\":\"%s\"}",
			i == 0 ? "" : ",",
			m->sender, (long long)m->at, text_esc);
		free(text_esc);
	}
	CatFixed(&out, "]}");
	http_send_json(fd, 200, "OK", c_str(&out));
	FreeString(&out);
}
