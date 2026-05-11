#include "ui.h"
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include "json-to-graph.h"
#include "node.h"
#include "util.h"
#include "json.h"
#include "mockopenai.h"
#include "graph-export.h"
#include "input-processor.h"
#include "search/deep-search-session.h"
#include "config.h"
#include <time.h>
#include <unistd.h>
#include <termios.h>
#include <string.h>
#include "srv/http-server.h"
#include "globals.h"
#include "goal/goal.h"

// AI generated function
static int getch_nowait_enterless(void) {
    struct termios oldt, newt;
    int ch;

    tcgetattr(STDIN_FILENO, &oldt);   // save current terminal settings
    newt = oldt;
    newt.c_lflag &= ~(ICANON | ECHO); // disable line buffering and echo
    tcsetattr(STDIN_FILENO, TCSANOW, &newt);

    ch = getchar();

    tcsetattr(STDIN_FILENO, TCSANOW, &oldt); // restore settings
    return ch;
}

static inline void clear(){
	printf("\033[H\033[J");
}

static void SetUpContexts(){
	time_t now = change_time_now();
	for (int i = 0; i < CONTEXT_COUNT; i++){
		Node *n = AddNodeEx(context_labels[i], strlen(context_labels[i]), NODE_INIT_ACT, NODE_INIT_WGHT, PARENTLESS, -1, FERTILE, now);
		if(!n){
			fprintf(stderr, "Critical Error: Couldn't initialize contexts for neuro engine\n");
			exit(EXIT_FAILURE);
		}
		Contexts[i] = n->globalIndex;
	}
}

void UIStart(){
	InitNodes();
	SetUpContexts();
	InitGlobalPointerMap();

	// Setup Global Pointers
	SetGlobalPointerF("ds_emit", &ds_emit_event);
	SetGlobalPointerF("goal_emit", &goal_emit_event);

	InitGoalSystem();
}

static void Run(int i){
	clear();
	printf("------------- [ %c ] -------------\n", options[i].key);

	if (options[i].type == MESSAGE){
		char *input_raw = NULL;
		size_t input_size = 0;

		while (input_size < 5){
			printf("Please write a message: \n");
			input_raw = NULL; input_size = 0;

			int read = mygetline(&input_raw, &input_size, stdin);
			if (read < 0) input_size = 0;

			if (read > 0){
				String input; InitString(&input, input_size + 1);
				CatString(&input, input_raw, input_size);

				DecomposeInputIntoGraph(&input);

				FreeString(&input);
			}

			if (input_raw) free(input_raw);
		}
	}

	if (options[i].type == SAVEGRAPH){
		ExportGraphTo(DEFAULT_GRAPH_EXPORT);
	}

	if (options[i].type == SAVEGOALS){
		ExportGraphTo(DEFAULT_GOALS_DIRECTORY);
	}

	if (options[i].type == DEEPRESEARCH){
		Task task;

		char *input_raw = NULL;
		size_t input_size = 0;

		printf("Please write a message: \n");
		input_raw = NULL; input_size = 0;

		int read = mygetline(&input_raw, &input_size, stdin);
		if (read < 0) input_size = 0;

		if (input_size > 5){
			CatString(&task.name, input_raw, input_size);
			task.minDepth = 2;
		}

		if (input_raw) free(input_raw);
		
		String out; InitString(&out, 2048);
		start_ds_session(&task, "default", &out);

		printf("See result in:\n\n%s%s\n", PROJECT_ROOT, "deep-search-result.txt");
		dump_to_file(PROJECT_ROOT "deep-search-result.txt", out.p, out.len);

		FreeString(&out);
	}

	if (options[i].type == REGEN_OPENAI)
		RegenMocksOpenAI();

	if (options[i].type == STARTSERVER){
		start_server(HTTP_SERVER_PORT);
		printf("Server is up and running...\n\n");
		WaitForInput();
		stop_server();
		printf("You stopped the server, press enter to continue\n");
		WaitForInput();
	}

	if (options[i].type == CREATEGOAL){
		char *input_raw0 = NULL;
		size_t input_size0 = 0;

		char *input_raw1 = NULL;
		size_t input_size1 = 0;

		printf("Please write a goal: \n");
		int read0 = mygetline(&input_raw0, &input_size0, stdin);

		printf("Please reason the goal: \n");
		int read1 = mygetline(&input_raw1, &input_size1, stdin);

		String input0; InitString(&input0, input_size0 + 1);
		String input1; InitString(&input1, input_size1 + 1);

		Goal *g = CreateUserGoal(&input0, &input1, start_ds_session);

		FreeString(&input0);
		FreeString(&input1);
	}

	if (options[i].type == NMESSAGE){
		for (int i = 0; i < DEFAULT_MOCK_NODES_COUNT; i++){
			char file[512];
			sprintf(file, DEFAULT_MOCK_DIRECTORY "nodes/graph_%03u.json", i);

			size_t buffer_len = 0;
			char* buffer = readFile(file, &buffer_len);

			cassert(buffer, "File probably doesn't exist\n");

			json_value* doc = json_parse(buffer, buffer_len);
			cassert(doc, "Coudln't parse mock \n");
			cassert(doc->type == json_object, "Json is not an object");

			char context[256] = "\0";
			for (size_t i = 0; i < doc->u.object.length; i++){
				json_object_entry e = doc->u.object.values[i];

				if (strcmp(e.name, "context") == 0 && e.value->type == json_string){
					memcpy(context, e.value->u.string.ptr, e.value->u.string.length);
				}
			}

			AddContextNodesFromJSON(context, strlen(context), doc);

			json_value_free(doc);
		}
	}

	if (options[i].type == REGEN_OPENAI){
		RegenMocksOpenAI();
	}

	WaitForInput();
}

void UILoop(){
	int selection = -1;
	while(1){
		clear();
		printf("CHANGE APP CLI\n\n");

		if (selection >= 0 && selection < OPTIONS_COUNT){
			printf("Ran %c\n\n", options[selection].key);
		}

		for (int i = 0; i < OPTIONS_COUNT; ++i){
			printf("[%c] - %s\n", options[i].key, options[i].msg);
		}
		printf("\n\nSelect any option above: ");

		char option = (char)getch_nowait_enterless();
		for (selection = 0; selection < OPTIONS_COUNT; ++selection){
			if (option == QUIT_BUTTON) return;
			if (option == options[selection].key) Run(selection);
		}
		if (selection == OPTIONS_COUNT) continue;

	}
}

void UIKill(){
	FreeNodes();
	FreeGlobalPointerMap();
	FreeGoals();
}
