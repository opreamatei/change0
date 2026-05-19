#include "journey.h"
#include <string.h>

Journey JOURNEY_TABLE[MAX_JOURNEYS] = {0};
size_t JOURNEY_COUNT = 0;

_Bool MatchesJourneyID(Journey* u, journey_id_like id){
	return strcmp(u->id, id) == 0;
}

Journey* FindJourneyByID(journey_id_like id){
	for (size_t i = 0; i < JOURNEY_COUNT; i++){
		Journey *u = &JOURNEY_TABLE[i];
		if (MatchesJourneyID(u, id)){
			return u;
		}
	}
	return NULL;
}

Journey* NewJourney(String *name){
	change_assert(JOURNEY_COUNT < MAX_JOURNEYS, "Max journeys limit reached");

	Journey *j = &JOURNEY_TABLE[JOURNEY_COUNT];

	InitString(&j->title, 128);

	JOURNEY_COUNT ++;

	return j;
}

void FreeUser(Journey *journey){
	FreeString(&journey->title);
}

void InitUserSystem(){
	JOURNEY_COUNT = 0;
	
	String default_journey_title;
	{
		// calc defualt user name
		InitString(&default_journey_title, FSIZE(DEFAULT_JOURNEY_TITLE) + 2);
		CatFixed(&default_journey_title, DEFAULT_JOURNEY_TITLE);
	}

	NewJourney(&default_journey_title);
}

void FreeUserSystem(){

	for (size_t i = 0; i < JOURNEY_COUNT; i++){
		FreeUser(&JOURNEY_TABLE[i]);
	}

	JOURNEY_COUNT = 0;
}

