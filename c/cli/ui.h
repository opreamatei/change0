#ifndef UI_CLIENT_FUNCTIONALITY
#define UI_CLIENT_FUNCTIONALITY

#define QUIT_BUTTON 'q'

enum INPUT_OPTION {
	QUIT,
	MESSAGE,
	NMESSAGE,
	REGEN_OPENAI,
	DEEPRESEARCH,
	STARTSERVER,
	STARTCLIENTSERVER,
	CREATEGOAL,
	SAVEGOALS,
	SAVEGRAPH,
};

typedef struct {
    enum INPUT_OPTION type;
    char key;
    const char* msg;
} InputOption;

InputOption options[] = {
    {QUIT, QUIT_BUTTON, "Exit client."},
    {MESSAGE, 'u', "Write user input."},
    {REGEN_OPENAI, 'r', "Regen mocks with ChatGPT"},
    {NMESSAGE, 'n', "Create n messages directly from pre-cached mocks."},
    {DEEPRESEARCH, 'd', "Run deep research"},
    {STARTSERVER, 's', "Start central server (port 8085)"},
    {STARTCLIENTSERVER, 'l', "Start client server (select/create user, random port)"},
    {CREATEGOAL, 'g', "Create a new Goal"},
    {SAVEGRAPH, 'c', "Copy graph to json"},
    {SAVEGOALS, 'b', "Copy goals to json"},
};
#define OPTIONS_COUNT (sizeof(options) / sizeof(InputOption))

void UIStart();

void UILoop();

void UIKill();

#endif
