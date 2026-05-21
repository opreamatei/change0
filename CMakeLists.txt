cmake_minimum_required(VERSION 3.16)
project(change)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON) # for lsp

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

find_package(OpenSSL REQUIRED)

add_library(timeutil SHARED ${CMAKE_SOURCE_DIR}/c/lib/util/time-util.c)
target_include_directories(timeutil PUBLIC
	${CMAKE_SOURCE_DIR}/c/lib/util
)

add_library(hd SHARED ${CMAKE_SOURCE_DIR}/c/lib/hd/hashdict.c)
target_include_directories(hd PUBLIC ${CMAKE_SOURCE_DIR}/c/lib/hd)

add_library(jsonp SHARED ${CMAKE_SOURCE_DIR}/c/lib/jsonp/json.c)
target_include_directories(jsonp PUBLIC ${CMAKE_SOURCE_DIR}/c/lib/jsonp)
target_link_libraries(jsonp PRIVATE m) # add math

add_library(util SHARED ${CMAKE_SOURCE_DIR}/c/lib/util/util.c)
target_include_directories(util PUBLIC 
	${CMAKE_SOURCE_DIR}/c/lib/util
	${CMAKE_SOURCE_DIR}/c/lib/jsonp
	${CMAKE_SOURCE_DIR}/c
)
target_link_libraries(util PUBLIC jsonp change-errors timeutil)

add_library(change-errors SHARED ${CMAKE_SOURCE_DIR}/c/lib/util/change-errors.c)
target_include_directories(change-errors PUBLIC 
	${CMAKE_SOURCE_DIR}/c
	${CMAKE_SOURCE_DIR}/c/lib/util
)
target_link_libraries(change-errors PUBLIC timeutil)

add_library(openai SHARED ${CMAKE_SOURCE_DIR}/c/lib/openai/openai.c)
target_include_directories(openai PUBLIC 
	${CMAKE_SOURCE_DIR}/c/lib/openai
        ${CMAKE_SOURCE_DIR}/c/lib/util
        ${CMAKE_SOURCE_DIR}/c/lib/jsonp
        ${CMAKE_SOURCE_DIR}/c
)
target_link_libraries(openai
    PUBLIC util jsonp
    PRIVATE OpenSSL::SSL OpenSSL::Crypto
)

add_library(mockopenai SHARED ${CMAKE_SOURCE_DIR}/c/lib/openai/mockopenai.c)
target_include_directories(mockopenai PUBLIC ${CMAKE_SOURCE_DIR}/c/lib/openai ${CMAKE_SOURCE_DIR}/c/lib/jsonp)
target_link_libraries(mockopenai PUBLIC openai)

add_library(ui SHARED ${CMAKE_SOURCE_DIR}/c/cli/ui.c)
target_include_directories(ui PUBLIC
    ${CMAKE_SOURCE_DIR}/c/cli   
    ${CMAKE_SOURCE_DIR}/c/srv
    ${CMAKE_SOURCE_DIR}/c       
)
target_link_libraries(ui PUBLIC
    node
    util
    mockopenai
    graphexport
    inputprocessor
    deepsearchsession
    user-management
    goal
    http-server
    central-server
    globals
)

add_library(graphexport SHARED ${CMAKE_SOURCE_DIR}/c/ne/graph/graph-export.c)
target_include_directories(graphexport PUBLIC
    ${CMAKE_SOURCE_DIR}/c/ne/graph
    ${CMAKE_SOURCE_DIR}/c/ne
)
target_link_libraries(graphexport PUBLIC
    util
    node
)

add_library(user-schedule SHARED ${CMAKE_SOURCE_DIR}/c/ne/goal/user-schedule.c)
target_include_directories(user-schedule PUBLIC
    ${CMAKE_SOURCE_DIR}/c/ne/goal
    ${CMAKE_SOURCE_DIR}/c/ne
    ${CMAKE_SOURCE_DIR}/c/lib/hd
    ${CMAKE_SOURCE_DIR}/c/lib/util
    ${CMAKE_SOURCE_DIR}/c/lib/jsonp
    ${CMAKE_SOURCE_DIR}/c
)
target_link_libraries(graphexport PUBLIC
	goal-util
)

add_library(graphengine SHARED ${CMAKE_SOURCE_DIR}/c/ne/graph/graph-engine.c)
target_include_directories(graphengine PUBLIC
    ${CMAKE_SOURCE_DIR}/c/ne/graph
    ${CMAKE_SOURCE_DIR}/c/ne
    ${CMAKE_SOURCE_DIR}/c
)
target_link_libraries(graphengine PUBLIC node util)
target_link_libraries(graphengine PRIVATE m) 

add_library(node SHARED ${CMAKE_SOURCE_DIR}/c/ne/node.c)
target_include_directories(node PUBLIC 
	${CMAKE_SOURCE_DIR}/c/ne
	${CMAKE_SOURCE_DIR}/c/lib/util
	${CMAKE_SOURCE_DIR}/c/lib/hd
)
target_link_libraries(node PRIVATE m) 
target_link_libraries(node PUBLIC hd util) 

add_library(mocks SHARED ${CMAKE_SOURCE_DIR}/c/ne/mocks/mocks.c)
target_include_directories(mocks PUBLIC
    ${CMAKE_SOURCE_DIR}/c/ne/mocks
    ${CMAKE_SOURCE_DIR}/c/lib/util
    ${CMAKE_SOURCE_DIR}/c/ne
    ${CMAKE_SOURCE_DIR}/c
)
target_link_libraries(mocks PUBLIC util node)

add_library(search SHARED ${CMAKE_SOURCE_DIR}/c/ne/search/search.c)
target_include_directories(search PUBLIC
    ${CMAKE_SOURCE_DIR}/c/ne/search
    ${CMAKE_SOURCE_DIR}/c/ne
)
target_link_libraries(search PUBLIC node util)

add_library(deepsearchsession SHARED ${CMAKE_SOURCE_DIR}/c/ne/search/deep-search-session.c)
target_include_directories(deepsearchsession PUBLIC
    ${CMAKE_SOURCE_DIR}/c/ne/search
    ${CMAKE_SOURCE_DIR}/c/lib/util
    ${CMAKE_SOURCE_DIR}/c/lib/jsonp
    ${CMAKE_SOURCE_DIR}/c/lib/openai
    ${CMAKE_SOURCE_DIR}/c/ne
    ${CMAKE_SOURCE_DIR}/c
)
target_link_libraries(deepsearchsession PUBLIC
    util
    jsonp
    comparsing
    openai
    graphengine
    mocks
    globals
    deepsearchexecute
)

add_library(deepsearchexecute SHARED ${CMAKE_SOURCE_DIR}/c/ne/search/deep-search-execute.c)
target_include_directories(deepsearchexecute PUBLIC
    ${CMAKE_SOURCE_DIR}/c/ne/search
    ${CMAKE_SOURCE_DIR}/c/lib/jsonp
    ${CMAKE_SOURCE_DIR}/c/lib/openai
    ${CMAKE_SOURCE_DIR}/c/ne
)
target_link_libraries(deepsearchexecute PUBLIC
    aiaction
    comparsing
    openai
    jsonp
)

add_library(comparsing SHARED ${CMAKE_SOURCE_DIR}/c/ne/search/command-parsing.c)
target_include_directories(comparsing PUBLIC
    ${CMAKE_SOURCE_DIR}/c/ne/search
    ${CMAKE_SOURCE_DIR}/c/ne/goal
    ${CMAKE_SOURCE_DIR}/c/ne
    ${CMAKE_SOURCE_DIR}/c
)
target_link_libraries(comparsing PUBLIC
    util
    jsonp
    globals
    goal-util
)

add_library(aiaction SHARED ${CMAKE_SOURCE_DIR}/c/ne/search/ai-action.c)
target_include_directories(aiaction PUBLIC
    ${CMAKE_SOURCE_DIR}/c
    ${CMAKE_SOURCE_DIR}/c/ne/search
    ${CMAKE_SOURCE_DIR}/c/ne/goal
    ${CMAKE_SOURCE_DIR}/c/ne
    ${CMAKE_SOURCE_DIR}/c/srv
)
target_link_libraries(aiaction PUBLIC
    jsonp
    util
    search
    goal-info
    user-schedule
    comparsing
    globals
)

add_library(json2graph SHARED ${CMAKE_SOURCE_DIR}/c/ne/input/json-to-graph.c)
target_include_directories(json2graph PUBLIC
    ${CMAKE_SOURCE_DIR}/c/ne/input
    ${CMAKE_SOURCE_DIR}/c
    ${CMAKE_SOURCE_DIR}/c/ne
)
target_link_libraries(json2graph PUBLIC
    util
    jsonp
    node
)

add_library(inputprocessor SHARED ${CMAKE_SOURCE_DIR}/c/ne/input/input-processor.c)
target_include_directories(inputprocessor PUBLIC
    ${CMAKE_SOURCE_DIR}/c/ne/input
    ${CMAKE_SOURCE_DIR}/c/ne
    ${CMAKE_SOURCE_DIR}/c
)
target_link_libraries(inputprocessor PUBLIC
    openai
    util
    jsonp
    node
    json2graph
    userprofile
)

add_library(middleware SHARED ${CMAKE_SOURCE_DIR}/c/middleware/middleware.c)
target_include_directories(middleware PUBLIC
	${CMAKE_SOURCE_DIR}/c
	${CMAKE_SOURCE_DIR}/c/middleware
	${CMAKE_SOURCE_DIR}/c/ne
	${CMAKE_SOURCE_DIR}/c/ne/goal
	${CMAKE_SOURCE_DIR}/c/ne/input
	${CMAKE_SOURCE_DIR}/c/ne/profile
	${CMAKE_SOURCE_DIR}/c/ne/search
	${CMAKE_SOURCE_DIR}/c/lib/openai
	${CMAKE_SOURCE_DIR}/c/lib/util
	${CMAKE_SOURCE_DIR}/c/lib/jsonp
)
target_link_libraries(middleware PUBLIC
	util
	jsonp
	openai
	inputprocessor
	userprofile
	goal
	deepsearchsession
)

add_library(userprofile SHARED ${CMAKE_SOURCE_DIR}/c/ne/profile/user-profile.c)
target_include_directories(userprofile PUBLIC
	${CMAKE_SOURCE_DIR}/c/ne/profile
	${CMAKE_SOURCE_DIR}/c/ne
	${CMAKE_SOURCE_DIR}/c/srv
	${CMAKE_SOURCE_DIR}/c/ne/goal
	${CMAKE_SOURCE_DIR}/c/lib/util
	${CMAKE_SOURCE_DIR}/c/lib/jsonp
	${CMAKE_SOURCE_DIR}/c
)
target_link_libraries(userprofile PUBLIC
	util
	goal-util
	user-management
	jsonp
)

add_dependencies(userprofile user-management)

add_library(http-server SHARED ${CMAKE_SOURCE_DIR}/c/srv/http-server.c)
target_include_directories(http-server PUBLIC
	${CMAKE_SOURCE_DIR}/c
	${CMAKE_SOURCE_DIR}/c/ne
	${CMAKE_SOURCE_DIR}/c/lib/util
	${CMAKE_SOURCE_DIR}/c/lib/jsonp
	${CMAKE_SOURCE_DIR}/c/srv
)
target_link_libraries(http-server PUBLIC
	node
	graphexport
	util
	goal
	inputprocessor
	middleware
	user-management
	pthread
)

add_library(central-server SHARED ${CMAKE_SOURCE_DIR}/c/srv/central-server.c)
target_include_directories(central-server PUBLIC
	${CMAKE_SOURCE_DIR}/c
	${CMAKE_SOURCE_DIR}/c/srv
	${CMAKE_SOURCE_DIR}/c/lib/util
	${CMAKE_SOURCE_DIR}/c/lib/jsonp
)
target_link_libraries(central-server PUBLIC
	util
	jsonp
	user-management
	http-server
	pthread
)

add_library(globals SHARED ${CMAKE_SOURCE_DIR}/c/globals.c)
target_include_directories(globals PUBLIC
	${CMAKE_SOURCE_DIR}/c
	${CMAKE_SOURCE_DIR}/c/lib/hd
)

add_library(goal SHARED ${CMAKE_SOURCE_DIR}/c/ne/goal/goal.c)
target_include_directories(goal PUBLIC
	${CMAKE_SOURCE_DIR}/c/lib/util
	${CMAKE_SOURCE_DIR}/c/lib/jsonp
	${CMAKE_SOURCE_DIR}/c/lib/openai
	${CMAKE_SOURCE_DIR}/c/ne
	${CMAKE_SOURCE_DIR}/c/ne/goal
	${CMAKE_SOURCE_DIR}/c/ne/search
	${CMAKE_SOURCE_DIR}/c/ne/profile
)
target_link_libraries(goal PUBLIC user-schedule goal-ai goal-info goal-util userprofile util openai jsonp node)

add_library(goal-util SHARED ${CMAKE_SOURCE_DIR}/c/ne/goal/goal-util.c)
target_include_directories(goal-util 
	PUBLIC
	${CMAKE_SOURCE_DIR}/c/lib/util
	${CMAKE_SOURCE_DIR}/c/lib/jsonp
	${CMAKE_SOURCE_DIR}/c/ne
	${CMAKE_SOURCE_DIR}/c
	${CMAKE_SOURCE_DIR}/c/ne/goal
)
target_link_libraries(goal-util PUBLIC util globals jsonp)

add_library(journey SHARED ${CMAKE_SOURCE_DIR}/c/srv/journey.c)
target_include_directories(journey PUBLIC
	${CMAKE_SOURCE_DIR}/c/srv
	${CMAKE_SOURCE_DIR}/c/ne
	${CMAKE_SOURCE_DIR}/c/ne/goal
	${CMAKE_SOURCE_DIR}/c/lib/util
	${CMAKE_SOURCE_DIR}/c/lib/jsonp
	${CMAKE_SOURCE_DIR}/c/lib/hd
	${CMAKE_SOURCE_DIR}/c
)
target_link_libraries(journey PUBLIC util)

add_library(goal-info SHARED ${CMAKE_SOURCE_DIR}/c/ne/goal/goal-info.c)
target_include_directories(goal-info 
	PUBLIC
	${CMAKE_SOURCE_DIR}/c
	${CMAKE_SOURCE_DIR}/c/ne/goal
)
target_link_libraries(goal-info PUBLIC goal-util)

add_library(goal-ai SHARED ${CMAKE_SOURCE_DIR}/c/ne/goal/goal-ai.c)
target_include_directories(goal-ai 
	PUBLIC
	${CMAKE_SOURCE_DIR}/c
	${CMAKE_SOURCE_DIR}/c/ne/goal
	${CMAKE_SOURCE_DIR}/c/ne/search
	${CMAKE_SOURCE_DIR}/c/lib/openai
	${CMAKE_SOURCE_DIR}/c/lib/util
)
target_link_libraries(goal-ai PUBLIC util goal-info openai deepsearchsession)

add_library(user-management SHARED ${CMAKE_SOURCE_DIR}/c/srv/user-management.c)
target_include_directories(user-management PUBLIC
	${CMAKE_SOURCE_DIR}/c/srv
	${CMAKE_SOURCE_DIR}/c
	${CMAKE_SOURCE_DIR}/c/lib/util
	${CMAKE_SOURCE_DIR}/c/lib/jsonp
	${CMAKE_SOURCE_DIR}/c/ne/goal
	)
target_link_libraries(user-management PUBLIC util journey)

add_executable(change ${CMAKE_SOURCE_DIR}/c/main.c)
target_include_directories(change PRIVATE
    ${CMAKE_SOURCE_DIR}/c
    ${CMAKE_SOURCE_DIR}/c/ne
    ${CMAKE_SOURCE_DIR}/c/lib
    ${CMAKE_SOURCE_DIR}/c/lib/util
    ${CMAKE_SOURCE_DIR}/c/lib/openaicma
)

target_link_libraries(
	change PRIVATE

	hd jsonp node util ui
	graphexport search deepsearchsession
	deepsearchexecute openai
	mockopenai mocks aiaction json2graph
	graphengine inputprocessor http-server central-server
	goal
)
