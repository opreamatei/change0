# CHANGE

Welcome to the change project, so far the application decomposes user inputs into nodes, forming a cluster of nodes called User Identity. This user identity is used to personalize any kind of goals.
See below a brief overview:

## Concepts overview
### The neuroengine (NE)
The Neuroengine is responsible for managing a User Idenitity, which is obviously akin to a naive neural structure.
#### Deep Search (DS)
The neuroengine supports Deep Search (Or Deep Research) to perform a task tailored to a user's identity
#### Decomposition system
This is the system responsible for input-processing and spliting human readable text into nodes.
#### The goal systems (goals)
This is the system responsible for repairing, updaing, decomponsing and managing goals.
### Server
The client application has a `server` feature, this allows Neuro Engine (And DS) data to be exposed via HTTP protocol. (Read instalation guide for running.)

## Future plans
- Make OpenAI optional, so you can host your own AI
- Create a more intuitive js viewer
- Write the UI for teh actual app
- Much more

## To consider
- Testing the project requires an Open AI API key, you can switch manually to another system if you wish
- The project is 1. Work in progress, 2. Meant to be demo. 
- This is not conisdered safe by any means

# Instalation Guide
- You need linux, mac os or any other unix-like OS.
- You need Open SSL package and a valid Open AI key.
- Other common packages like cmake, gcc compiler are required.
- Optional but recommended : The http-server npm package

### Step 1
Clone this directory
```bash
git clone https://github.com/nita-andrei-cristian/change0.git
```

### Step 2
Open config.h file and modify this line to your project root directory
```c
#define PROJECT_ROOT "/home/nita/dev/c/change0/"
```

### Step 3
Setup an OpenAi key (Or any other key if you use a custom host)
```bash
export OPENAI_API_KEY=my_secret_key
```

### Step 4
Run build.sh
```bash
./build.sh
```

### Step 5
Now you will see terminal Cli interface.
You will most likely only care about the server:
- press `s` to start one. (Port 8085)
- make sure to not close the terminal

PS : If you want to change the port, modify config.h file and graph.html. Swap 8085 with another port

### Step 6
From another terminal:
- enter `change0/js` directory 
- run `http-server` (or any other command to run a server)
- open the received http url in a browser
- on load, pick a user (or create one) in the selection menu — the viewer binds
  that user's client server, so every panel shows that user's data. Use the
  **Switch** button in the Node View sidebar to inspect a different user.

### Step 7
- Use the app, but be patient because OpenAI requests are slow...

# Customizing the flow
You may alter the agents thinking and node formula constants by modfying the macros in config.h.
In other words you will find constants define as such:
```c 
// some examples, see detailed explinations in config.h
#define ACTIVATION_IMPORTANCE_TO_NODE_WEIGHT 0.2 
#define NCOUNT_PENALTY_TO_NODE_WEIGHT 0.2
#define SUPPORT_MERIT_TO_NODE_WEIGHT 0.6
#define NODE_OLD_WEIGHT_RELEVANCE 0.95 
#define ACT_HALFTIME 100.0 
```
You can change the values and **rebuild** the C project and **restart** the server to see the changes.
