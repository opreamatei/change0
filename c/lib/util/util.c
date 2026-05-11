#include "util.h"
#include <stdarg.h>
#include <time.h>
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>
#include <stddef.h>
#include <string.h>
#include <string.h>
#include <stdlib.h>
#include "change-errors.h"

static const char charset[] =
"abcdefghijklmnopqrstuvwxyz"
"ABCDEFGHIJKLMNOPQRSTUVWXYZ"
"0123456789";

void random_id(char *out, size_t len){
	srand((unsigned int)change_time_now());
	size_t charset_size = sizeof(charset) - 1;

	out[0] = 'g';

	for (size_t i = 1; i < len; ++i) {
		out[i] = charset[rand() % charset_size];
	}

	out[len] = '\0';
}


size_t mystrnlen(const char* s, size_t maxlen) {
    size_t i;
    for (i = 0; i < maxlen && s[i] != '\0'; i++);
    return i;
}

char* searchFirstDigit(char *source){
	char* dest = source;
	do{
		if (*dest >= '0' && *dest <= '9') return dest;
	}while(*(++dest) != '\0');
	return NULL;
}

char* searchFirstDigitWithComma(char *source){
	char* dest = source;
	do{
		if (*dest >= '0' && *dest <= '9' || *dest == '.' || *dest == ',') return dest;
	}while(*(++dest) != '\0');
	return NULL;
}

char* searchFirstNonDigitWithComma(char *source){
	char* dest = source;
	do{
		if ((*dest < '0' || *dest > '9') && *dest != '.' && *dest != ',') return dest;
	}while(*(++dest) != '\0');
	return NULL;
}

char* searchFirstNonDigit(char *source){
	char* dest = source;
	do{
		if (*dest < '0' || *dest > '9') return dest;
	}while(*(++dest) != '\0');
	return NULL;
}

char* readFile(char* filename, size_t *size)
{
	FILE* f = fopen(filename, "rb");
	if (!f) {
		fprintf(stderr, "File %s not found.\n", filename);
		return NULL;
	};

	fseek(f, 0, SEEK_END);
	*size = (size_t) ftell(f);
	rewind(f);

	char* buffer = malloc(*size + 1);
	if (!buffer){
		fclose(f);
		fprintf(stderr, "Error allocating \"%s\" in a buffer\n", filename);
		return NULL;
	}

	fread(buffer, 1, *size, f);
	buffer[*size] = '\0';

	fclose(f);
	return buffer;	
}
/*

itoa appeared in the first edition of
Kernighan and Ritchie's
The C Programming Language, 
on page 60.

*/

// Source - https://stackoverflow.com/a/29544416
// Posted by haccks, modified by community. See post 'Timeline' for change history
// Retrieved 2026-03-09, License - CC BY-SA 3.0

 /* reverse:  reverse string s in place */
 void reverse(char s[])
 {
     int i, j;
     char c;

     for (i = 0, j = strlen(s)-1; i<j; i++, j--) {
         c = s[i];
         s[i] = s[j];
         s[j] = c;
     }

}  

// Source - https://stackoverflow.com/a/29544416
// Posted by haccks, modified by community. See post 'Timeline' for change history
// Retrieved 2026-03-09, License - CC BY-SA 3.0

 /* itoa:  convert n to characters in s */
void itoa(int n, char s[])
 {
     int i, sign;

     if ((sign = n) < 0)  /* record sign */
         n = -n;          /* make n positive */
     i = 0;
     do {       /* generate digits in reverse order */
         s[i++] = n % 10 + '0';   /* get next digit */
     } while ((n /= 10) > 0);     /* delete it */
     if (sign < 0)
         s[i++] = '-';
     s[i] = '\0';
     reverse(s);
}  

/*
int atoi(char s[]){
	int n = 0;
	char* dest = s;
	while (*dest != '\0' && *dest >= '0' && *dest <= '9'){
		n *= 10 + *dest - '0';
	}

	return n;
}*/

 void ltoa(long n, char s[])
 {
     int i, sign;

     if ((sign = n) < 0)  /* record sign */
         n = -n;          /* make n positive */
     i = 0;
     do {       /* generate digits in reverse order */
         s[i++] = n % 10 + '0';   /* get next digit */
     } while ((n /= 10) > 0);     /* delete it */
     if (sign < 0)
         s[i++] = '-';
     s[i] = '\0';
     reverse(s);
}  

// This was findable on stack overlflow but I lost it so i head to generate with AI.

void dtoa(double n, char s[], int precision)
{
    int i = 0, sign;

    if ((sign = n < 0)) {
        n = -n;
    }

    int intPart = (int)n;
    double fracPart = n - intPart;

    /* convert integer part */
    do {
        s[i++] = intPart % 10 + '0';
    } while ((intPart /= 10) > 0);

    if (sign)
        s[i++] = '-';

    s[i] = '\0';     
    reverse(s);       

    i = strlen(s);  

    /* add decimal point */
    s[i++] = '.';

    /* convert fractional part */
    for (int j = 0; j < precision; j++) {
        fracPart *= 10;
        int digit = (int)fracPart;
        s[i++] = digit + '0';
        fracPart -= digit;
    }

    s[i] = '\0';
}

double atod(char s[], int precision)
{
	double result = 0.0;
	char* tip = s;
	double i = 1;

	while (*tip != '\0' && tip < s + precision){
		if (*tip == '.' || *tip == ',') {
			tip++;
			continue;
		}
		result = result * 10 + (double)(*tip - '0');
		tip++;
		i*=10;
	}

	if (i == 0) return 0.0;

	return (result / i) * 10;
}

void lowerAll(char** s, size_t len){
	// A -> 65 
	// a -> 97
	char* a = *s;
	for (int i = 0; i < len; i++)
		a[i] = a[i] < 'a' ? a[i] + ('a' - 'A') : a[i];
}

void InitString(String* s, size_t init_cap){
	s->cap = init_cap + 1;
	s->len = 0;
	s->p = malloc(s->cap);
	cassert(s->p, "Coudln't initialize string");
	*s->p = '\0';
	s->used = 0;
	s->init = 1;
}

void FreeString(String* s){
	if (!s || !s->p) return;
	s->used = 0;
	s->init = 0;
	free(c_str(s));
	c_str(s) = NULL;
}

void CatString(String* s, char* c, size_t len){
	change_assert(s, "No String passed...\n");
	if (!s || !s->init) InitString(s, len+2);

	if (s->cap <= len + s->len + 1){
		size_t req_cap = s->cap ? s->cap : 1; // avoid 0
		while (req_cap <= len + s->len) req_cap *= 2;
		ResizeString(s, req_cap);
	}

	memcpy(c_str(s) + s->len, c, len);
	s->len += len;
	*(c_str(s) + s->len) = '\0';

	s->used = 1;
}

// AI INSPIRED
void CatTemplateString(String* s, char *fmt, ...){
	if (massert(s, "No string passed...")) return;
	cassert(s && s->init, "Can't concatinate : String not initialized");

	va_list args;
	va_start(args, fmt);

	va_list args_copy;
	va_copy(args_copy, args);

	long needed = vsnprintf(NULL, 0, fmt, args_copy);
	
	if (needed < 0){
		va_end(args);
		cassert(0, "Formatting failed\n");
		return;
	}

	size_t add_len = (size_t)needed;
	size_t required_len = s->len + add_len;

	if (s->cap <= required_len + 1) {
		size_t new_cap = s->cap ? s->cap : 16;
		while (new_cap <= required_len + 1) 
			new_cap *= 2;
		ResizeString(s, new_cap);
	}

	vsnprintf(c_str(s) + s->len, s->cap - s->len, fmt, args);
	va_end(args);

	s->len += add_len;
	s->used = 1;
}

void ResizeString(String* s, size_t new_cap){

	if (!s->init){
		InitString(s, new_cap);
		return;
	}

	char* tmp = realloc(c_str(s), new_cap + 1);
	if (!tmp){
		fprintf(stderr, "String is |%s|\n", c_str(s));
		cassert(0, "String couldn't grow\n");
	}
	s->cap = new_cap;
	c_str(s) = tmp;
}

// A becomes B
void CopyString(String* a, String *b){
	EmptyString(a);
	CatString(a, c_str(b), b->len);
}

void EmptyString(String* a){
	a->len = 0;
	*c_str(a) = '\0';
}

String* CreateStringFrom(char* p, size_t len){
	String *out = malloc(sizeof(String));
	cassert(out, "Coudln't mem allocate a string");

	InitString(out, len+2);
	CatString(out, p, len);

	return out;
};

// AI generated function
void WaitForInput(void) {
    int c;

    while ((c = getchar()) != '\n' && c != EOF) {
    }
}

size_t mygetline(char **lineptr, size_t *n, FILE *stream) {
    size_t pos;
    int c;

    if (lineptr == NULL || stream == NULL || n == NULL) {
        errno = EINVAL;
        return -1;
    }

    c = getc(stream);
    if (c == EOF) {
        return -1;
    }

    if (*lineptr == NULL) {
        *lineptr = malloc(128);
        if (*lineptr == NULL) {
            return -1;
        }
        *n = 128;
    }

    pos = 0;
    while(c != EOF) {
        if (pos + 1 >= *n) {
            size_t new_size = *n + (*n >> 2);
            if (new_size < 128) {
                new_size = 128;
            }
            char *new_ptr = realloc(*lineptr, new_size);
            if (new_ptr == NULL) {
                return -1;
            }
            *n = new_size;
            *lineptr = new_ptr;
        }

        ((unsigned char *)(*lineptr))[pos ++] = c;
        if (c == '\n') {
            break;
        }
        c = getc(stream);
    }

    (*lineptr)[pos] = '\0';
    return pos;
}

char *json_escape_dup(const char *src){
	cassert(src, "json_escape_dup got NULL.\n");

	size_t need = 1;
	for (const unsigned char *p = (const unsigned char*)src; *p; p++){
		switch (*p){
			case '\"':
			case '\\':
			case '\b':
			case '\f':
			case '\n':
			case '\r':
			case '\t':
				need += 2;
				break;
			default:
				if (*p < 32) need += 6;
				else need += 1;
				break;
		}
	}

	char *out = malloc(need);
	cassert(out, "Failed to allocate escaped json string.\n");

	char *w = out;
	for (const unsigned char *p = (const unsigned char*)src; *p; p++){
		switch (*p){
			case '\"': *w++='\\'; *w++='\"'; break;
			case '\\': *w++='\\'; *w++='\\'; break;
			case '\b': *w++='\\'; *w++='b';  break;
			case '\f': *w++='\\'; *w++='f';  break;
			case '\n': *w++='\\'; *w++='n';  break;
			case '\r': *w++='\\'; *w++='r';  break;
			case '\t': *w++='\\'; *w++='t';  break;
			default:
				if (*p < 32){
					sprintf(w, "\\u%04x", *p);
					w += 6;
				}else{
					*w++ = (char)*p;
				}
				break;
		}
	}
	*w = '\0';
	return out;
}

// AI generated function
json_value *json_object_get(json_value *obj, const char *name)
{
	change_assert(obj && obj->type == json_object, "Expected JSON object.\n");

	for (size_t i = 0; i < obj->u.object.length; i++) {
		json_object_entry entry = obj->u.object.values[i];

		if (strcmp(entry.name, name) == 0)
			return entry.value;
	}

	return NULL;
}
