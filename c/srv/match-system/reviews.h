#ifndef REVIEWS_H
#define REVIEWS_H

#include "util.h"
#include <stddef.h>
#include <time.h>

#define SUBMISSION_ID_SIZE   33
#define REVIEW_ID_SIZE       33
#define SUBMISSION_LABEL_MAX 64
#define SUBMISSION_MAX_FILES  8
#define SUBMISSION_FNAME_MAX 256
#define MAX_SUBMISSIONS      256

typedef char submission_id_like[SUBMISSION_ID_SIZE];

typedef struct {
    submission_id_like id;
    char ai_label[SUBMISSION_LABEL_MAX];
    String ai_description;
    String user_description;
    char files[SUBMISSION_MAX_FILES][SUBMISSION_FNAME_MAX];
    int  file_count;
    _Bool authentic;
    time_t submitted_at;
} GoalSubmission;

void InitReviewSystem(void);
void FreeReviewSystem(void);

/* Creates a submission directory + metadata.json. Returns new entry or NULL. */
GoalSubmission *CreateSubmission(const char *ai_label,
                                 const char *ai_description,
                                 const char *user_description);

/* Writes data into <sub_id>/attachments/<filename>. Returns 0 on success. */
int AddSubmissionFile(const char *sub_id, const char *filename,
                      const void *data, size_t len);

/* Looks up a submission in the in-memory table. */
GoalSubmission *FindSubmission(const char *sub_id);

/* Returns 1 if this reviewer has already reviewed the given submission. */
int HasReviewerReviewed(const char *sub_id, const char *reviewer_id);

/* Reads an attachment into *out_data/*out_len (caller must free). */
int ReadSubmissionFile(const char *sub_id, const char *filename,
                       void **out_data, size_t *out_len);

/* Fills out[] with pending submissions for the reviewer (not reviewed, not authentic).
 * Submissions matching reviewer_label are placed first. Returns count. */
size_t ListPendingForReviewer(const char *reviewer_id,
                               const char *reviewer_label,
                               GoalSubmission **out, size_t max);

/* Stores a review score. Returns: 0=ok, 1=daily_limit, 2=already_reviewed, -1=error. */
int SubmitReview(const char *sub_id, const char *reviewer_id, int score);

/* Returns how many reviews this user submitted in the past 24 hours. */
int GetReviewsTodayCount(const char *reviewer_id);

#endif
