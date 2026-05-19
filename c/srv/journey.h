#ifndef JOURNEY_HEADER_COMPONENTS
#define JOURNEY_HEADER_COMPONENTS

#define MAX_ROOT_GOALS_PER_JOURNEY 10
#define JOURNEY_ID_SIZE 32
#define MAX_JOURNEYS 64

#define DEFAULT_JOURNEY_TITLE "default"
#include "goal.h"

typedef char journey_id_like[JOURNEY_ID_SIZE];

typedef struct JourneyType {

	Goal RootGoals[MAX_ROOT_GOALS_PER_JOURNEY];
	journey_id_like id;

	String title;

} Journey;

extern Journey JOURNEY_TABLE[MAX_JOURNEYS];
extern size_t JOURNEY_COUNT;

_Bool MatchesJourneyID(Journey* j, journey_id_like id);
Journey* FindJourneyByID(journey_id_like id);

Journey* NewJourney(String *name);
void FreeJourney(Journey *journey);

void InitJourneySystem();
void FreeJourneySystem();


#endif
