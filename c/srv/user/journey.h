#ifndef JOURNEY_HEADER_COMPONENTS
#define JOURNEY_HEADER_COMPONENTS

#define MAX_GOALS_PER_JOURNEY 512
#define JOURNEY_ID_SIZE 32
#define MAX_JOURNEYS 64

#include "goal.h"

typedef char journey_id_like[JOURNEY_ID_SIZE];

typedef struct JourneyType {
	journey_id_like id;
	String title;
	String extra_info;
	Goal *goals[MAX_GOALS_PER_JOURNEY];
	size_t goals_count;
	_Bool is_shared;
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

#endif
