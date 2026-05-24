#include "internal.h"

/* -------- AI-based pair matching -------- */

void copy_match_result(MatchResult *dst, const MatchResult *src)
{
	dst->index = src->index;
	strncpy(dst->reason, src->reason, MATCH_REASON_SIZE - 1);
	dst->reason[MATCH_REASON_SIZE - 1] = '\0';
}

size_t dedupe_match_results(
	const MatchResult *src, size_t src_count,
	MatchResult *dst, size_t dst_max)
{
	size_t out_count = 0;

	for (size_t i = 0; i < src_count && out_count < dst_max; i++) {
		_Bool seen = 0;
		for (size_t j = 0; j < out_count; j++) {
			if (dst[j].index == src[i].index) {
				seen = 1;
				break;
			}
		}
		if (seen) continue;
		copy_match_result(&dst[out_count++], &src[i]);
	}

	return out_count;
}

/*
 * One AI call that sees all candidates at once.
 * Returns the number of matches written into out[].
 * Retries up to 3 times on parse failure.
 */
size_t ai_find_matches(
	const User *a,
	User **candidates, size_t candidate_count,
	MatchResult *out, size_t out_max)
{
	if (candidate_count == 0) return 0;

	String feedback;
	InitString(&feedback, 128);
	size_t found = 0;

	for (int attempt = 0; attempt < 3; attempt++) {
		String clist;
		InitString(&clist, 256 * candidate_count);
		for (size_t i = 0; i < candidate_count; i++) {
			CatTemplateString(&clist, "Candidate %zu: %s\n",
				i + 1,
				candidates[i]->description.p ? candidates[i]->description.p : "(no description)");
		}

		String prompt;
		InitString(&prompt, 512 + clist.len);
		CatTemplateString(&prompt,
			CONN_MATCH_PROMPT,
			a->description.p ? a->description.p : "(no description)",
			clist.p,
			feedback.len > 0 ? feedback.p : "");

		FreeString(&clist);
		FreeString(&feedback);
		InitString(&feedback, 128);

		ai_gpt_request req = {0};
		req.prompt      = prompt;
		req.model       = AI_OPENAI_MODEL_GPT_5_4_MINI;
		req.schema_name = "connection_match";
		InitString(&req.schema, sizeof(MATCH_SCHEMA) + 1);
		CatFixed(&req.schema, MATCH_SCHEMA);

		String *raw = ai_openai_call_gpt_request(&req);
		change_assert(raw, "ai_find_matches: OpenAI call failed");

		FreeString(&prompt);
		FreeString(&req.schema);

		json_value *doc = json_parse(raw->p, raw->len);
		FreeString(raw);
		free(raw);

		if (!doc || doc->type != json_object) {
			CatFixed(&feedback, "\n[Previous response was not valid JSON. Return the schema exactly.]");
			if (doc) json_value_free(doc);
			continue;
		}

		json_value *jmatches = json_object_get(doc, "matches");
		if (!jmatches || jmatches->type != json_array) {
			CatFixed(&feedback, "\n[\"matches\" field missing or not an array. Fix it.]");
			json_value_free(doc);
			continue;
		}

		_Bool valid = 1;
		for (unsigned m = 0; m < jmatches->u.array.length && found < out_max; m++) {
			json_value *item = jmatches->u.array.values[m];
			if (!item || item->type != json_object) { valid = 0; break; }

			json_value *jidx    = json_object_get(item, "index");
			json_value *jreason = json_object_get(item, "reason");

			if (!jidx || jidx->type != json_integer) { valid = 0; break; }

			long long idx = jidx->u.integer;
			if (idx < 0 || (size_t)idx >= candidate_count) continue;

			out[found].index = (size_t)idx;
			if (jreason && jreason->type == json_string && jreason->u.string.length > 0) {
				size_t rlen = jreason->u.string.length;
				if (rlen >= MATCH_REASON_SIZE) rlen = MATCH_REASON_SIZE - 1;
				memcpy(out[found].reason, jreason->u.string.ptr, rlen);
				out[found].reason[rlen] = '\0';
			} else {
				snprintf(out[found].reason, MATCH_REASON_SIZE, "You seem like compatible people.");
			}
			found++;
		}

		json_value_free(doc);
		if (!valid) {
			found = 0;
			CatFixed(&feedback, "\n[Some match items had invalid fields. Return index (integer) and reason (string) for each.]");
			continue;
		}
		break;
	}

	FreeString(&feedback);
	return found;
}

/*
 * Final "master AI" pass over an already-filtered shortlist.
 * Returns at most out_max ordered matches. If the judge cannot return valid
 * structured output after retries, falls back to the first out_max shortlist
 * entries in their existing order.
 */
size_t ai_pick_final_matches(
	const User *a,
	User **candidates,
	const MatchResult *shortlist, size_t shortlist_count,
	MatchResult *out, size_t out_max)
{
	if (shortlist_count == 0 || out_max == 0) return 0;
	if (shortlist_count <= out_max) {
		for (size_t i = 0; i < shortlist_count; i++)
			copy_match_result(&out[i], &shortlist[i]);
		return shortlist_count;
	}

	String feedback;
	InitString(&feedback, 128);

	for (int attempt = 0; attempt < 3; attempt++) {
		size_t found = 0;

		String slist;
		InitString(&slist, 320 * shortlist_count);
		for (size_t i = 0; i < shortlist_count; i++) {
			const User *candidate = candidates[shortlist[i].index];
			CatTemplateString(&slist,
				"Shortlist %zu:\n"
				"Candidate description: %s\n"
				"Preliminary reason: %s\n\n",
				i + 1,
				candidate->description.p ? candidate->description.p : "(no description)",
				shortlist[i].reason[0] ? shortlist[i].reason : "You seem like compatible people.");
		}

		String prompt;
		InitString(&prompt, 768 + slist.len);
		CatTemplateString(&prompt,
			CONN_FINAL_MATCH_PROMPT,
			out_max,
			a->description.p ? a->description.p : "(no description)",
			slist.p,
			out_max,
			feedback.len > 0 ? feedback.p : "");

		FreeString(&slist);
		FreeString(&feedback);
		InitString(&feedback, 128);

		ai_gpt_request req = {0};
		req.prompt      = prompt;
		req.model       = AI_OPENAI_MODEL_GPT_5_5;
		req.schema_name = "connection_final_match";
		InitString(&req.schema, sizeof(MATCH_SCHEMA) + 1);
		CatFixed(&req.schema, MATCH_SCHEMA);

		String *raw = ai_openai_call_gpt_request(&req);
		change_assert(raw, "ai_pick_final_matches: OpenAI call failed");

		FreeString(&prompt);
		FreeString(&req.schema);

		json_value *doc = json_parse(raw->p, raw->len);
		FreeString(raw);
		free(raw);

		if (!doc || doc->type != json_object) {
			CatFixed(&feedback, "\n[Previous response was not valid JSON. Return the schema exactly.]");
			if (doc) json_value_free(doc);
			continue;
		}

		json_value *jmatches = json_object_get(doc, "matches");
		if (!jmatches || jmatches->type != json_array) {
			CatFixed(&feedback, "\n[\"matches\" field missing or not an array. Fix it.]");
			json_value_free(doc);
			continue;
		}

		_Bool valid = 1;
		for (unsigned m = 0; m < jmatches->u.array.length && found < out_max; m++) {
			json_value *item = jmatches->u.array.values[m];
			if (!item || item->type != json_object) { valid = 0; break; }

			json_value *jidx    = json_object_get(item, "index");
			json_value *jreason = json_object_get(item, "reason");

			if (!jidx || jidx->type != json_integer) { valid = 0; break; }

			long long shortlist_idx = jidx->u.integer;
			if (shortlist_idx < 0 || (size_t)shortlist_idx >= shortlist_count) {
				valid = 0;
				break;
			}

			out[found].index = shortlist[(size_t)shortlist_idx].index;
			if (jreason && jreason->type == json_string && jreason->u.string.length > 0) {
				size_t rlen = jreason->u.string.length;
				if (rlen >= MATCH_REASON_SIZE) rlen = MATCH_REASON_SIZE - 1;
				memcpy(out[found].reason, jreason->u.string.ptr, rlen);
				out[found].reason[rlen] = '\0';
			} else {
				snprintf(out[found].reason, MATCH_REASON_SIZE, "You seem like compatible people.");
			}
			found++;
		}

		json_value_free(doc);
		if (!valid) {
			CatFixed(&feedback, "\n[Each item must use a valid shortlist index and reason string.]");
			continue;
		}

		found = dedupe_match_results(out, found, out, out_max);
		FreeString(&feedback);
		return found;
	}

	FreeString(&feedback);
	for (size_t i = 0; i < out_max; i++)
		copy_match_result(&out[i], &shortlist[i]);
	return out_max;
}
