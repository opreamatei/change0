#ifndef JOURNEY_HEADER_COMPONENTS
#define JOURNEY_HEADER_COMPONENTS

#define MAX_GOALS_PER_JOURNEY 512
#define JOURNEY_ID_SIZE 32
#define MAX_JOURNEYS 64

#include "config.h"
#include "goal.h"

typedef char journey_id_like[JOURNEY_ID_SIZE];

/*
 * Participant in a shared journey. `id` matches a central User.id so leaves
 * can be attributed back to a concrete user. `display_name` and
 * `context_summary` are copies of the corresponding central User fields
 * taken at journey creation time — they are read-only inside the journey
 * and refreshed only when the journey is rebuilt.
 *
 * The AI never sees raw ids; it sees the participant index in the journey's
 * users[] table (0..user_count-1). The reverse lookup goes through this
 * table by index.
 */
typedef struct JourneyUserType {
	char   id[JOURNEY_ID_SIZE];   /* matches user_id_like length */
	String display_name;
	String context_summary;
} JourneyUser;

typedef struct JourneyType {
	journey_id_like id;
	String title;
	String extra_info;
	Goal *goals[MAX_GOALS_PER_JOURNEY];
	size_t goals_count;
	_Bool is_shared;

	JourneyUser users[MAX_JOURNEY_USERS];
	size_t user_count;
} Journey;

extern Journey JourneyTable[MAX_JOURNEYS];
extern size_t JourneyTableCount;

_Bool MatchesJourneyID(Journey *j, const char *id);
Journey *FindJourneyByID(const char *id);

Journey *NewJourney(String *name);
Journey *AllocJourney(void);   /* allocate empty slot; caller sets id and calls LoadJourneyFromFile */
void AddGoalToJourney(Journey *j, Goal *g);

void InitJourneySystem(void);
void FreeJourneySystem(void);

void SerializeJourney(const Journey *j, String *out);
void ExportJourneyTo(const Journey *j, const char *path);
void LoadJourneyFromBuffer(Journey *j, const char *buf, size_t len);
void LoadJourneyFromFile(Journey *j, const char *path);

Journey *FetchSharedJourney(const char *journey_id);
void PushJourneyToCentral(const Journey *j);
void DeleteSharedJourneyOnCentral(const char *journey_id);
void RemoveJourneyFromTable(const char *journey_id);

/*
 * Shared-journey user-table helpers. AddUserToJourney appends a participant
 * and copies its description into the journey's user table; the caller owns
 * neither the User nor the strings after the call. FindUserIndexInJourney
 * returns the journey-relative participant index for a given user id, or
 * MAX_JOURNEY_USERS if the id is not a participant.
 */
void AddUserToJourney(Journey *j, const char *user_id, const char *display_name, const char *context_summary);
size_t FindUserIndexInJourney(const Journey *j, const char *user_id);

#endif
