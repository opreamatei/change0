#ifndef CHANGE_UTIL_FUNCTIONS
#define CHANGE_UTIL_FUNCTIONS
#include <stddef.h>

#define MAX(a,b) ((a) > (b) ? (a) : (b))
#define MIN(a,b) ((a) < (b) ? (a) : (b))
#define ABS(a) ((a) > 0 ? (a) : -(a))
#define CLAMP(mi,mx,v) ((v) < (mi) ? (mi) : ((v) > (mx) ? (mx) : (v)))

// ai generated strnlen
size_t mystrnlen(const char* s, size_t maxlen);
#endif

#ifndef READ_FILE_FUNC
#define READ_FILE_FUNC

#include <stdio.h>
#include "change-errors.h"
#include "json.h"

char* readFile(char* filename, size_t *bytes);

void WaitForInput(void);

size_t mygetline(char **lineptr, size_t *n, FILE *stream);

char *json_escape_dup(const char *src);

json_value *json_object_get(json_value *obj, const char *name);

#endif

#ifndef CONVERSION_FUNCTIONS
#define CONVERSION_FUNCTIONS
void itoa(int n, char s[]);
void ltoa(long n, char s[]);
void dtoa(double n, char s[], int precision);
double atod(char s[], int precision);
#endif

#ifndef STRING_SEARCH_FUNCTIONS
#define STRING_SEARCH_FUNCTIONS

char* searchFirstDigit(char *source);

char* searchFirstDigitWithComma(char *source);

char* searchFirstNonDigitWithComma(char *source);

char* searchFirstNonDigit(char *source);

#endif

#ifndef STRING_CUSTOM_UTIL
#define STRING_CUSTOM_UTIL

#define c_str(s) ((s)->p)
#define CatFixed(dest, source) (CatString((dest), (source), FSIZE((source))))

void random_id(char *out, size_t len);
void lowerAll(char** s, size_t len);

typedef struct {
	char* p;
	size_t len;
	size_t cap;
	_Bool used;
	_Bool init;
} String;

void InitString(String* s, size_t init_cap);
void FreeString(String* s);
void CatString(String* s, char* c, size_t len);
void CatTemplateString(String* s, char *fmt, ...);
void CopyString(String* a, String* b);
void EmptyString(String* a);
void ResizeString(String* a, size_t new_cap);
String* CreateStringFrom(char* p, size_t len);

#endif
