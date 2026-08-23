/**
 * The two questions a queue of photos has to answer, kept apart from
 * the storage that holds them and the engine that drains them.
 *
 *   1. What may go in? Blobs are the only thing this app stores that is
 *      measured in megabytes, and IndexedDB quota is finite and shared
 *      with the records that actually pay the rent. An unbounded queue
 *      does not fail politely — the browser starts refusing writes, and
 *      the write it refuses is as likely to be a gig as a photo.
 *   2. What takes one out again, other than a successful upload? An
 *      image that retries forever is as bad as one that vanishes
 *      silently: the first burns battery and never resolves, the second
 *      leaves a payment claiming proof it does not have.
 *
 * Both answers are pure functions here so they can be reasoned about —
 * and tested — without a database or a network.
 */

/**
 * Ceiling on ONE queued photo.
 *
 * A full-resolution phone photo of a bank confirmation is 2–5 MB, so
 * this accepts the honest case with room to spare. What it refuses is
 * the mis-tap: a video, a scan at print resolution, a 40 MB PDF. Those
 * are refused at the moment the file is chosen, while the user is still
 * looking at the picker and can pick again — not discovered a day later
 * when the link comes back and the server says 413.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Ceiling on the whole queue.
 *
 * Roughly a week of proof photos for a busy freelancer, which is far
 * longer than anyone is realistically offline. The number matters less
 * than the fact that there IS one: without it, a phone in a dead zone
 * fills its origin's quota and the failure lands on whatever the app
 * writes next.
 */
export const MAX_QUEUE_BYTES = 32 * 1024 * 1024;

export type QueueRefusal = "too-large" | "queue-full";

/**
 * Why a photo may not be queued, or null when it may.
 *
 * The full queue is REFUSED, never evicted. Eviction is the usual
 * answer for a bounded cache and the wrong one here: every entry is a
 * photograph of a payment that exists nowhere else, and dropping the
 * oldest to make room for the newest destroys the one the user has
 * been carrying longest. Refusing is the only outcome the user can see
 * and act on — the message tells them the way out is to connect once.
 */
export function refuseQueuedImage(
  incomingBytes: number,
  queuedBytes: number,
): QueueRefusal | null {
  if (incomingBytes > MAX_IMAGE_BYTES) return "too-large";
  if (queuedBytes + incomingBytes > MAX_QUEUE_BYTES) return "queue-full";
  return null;
}

export const QUEUE_REFUSAL_MESSAGE: Record<QueueRefusal, string> = {
  "too-large": `That file is too large to hold on the device — photos up to ${Math.round(
    MAX_IMAGE_BYTES / (1024 * 1024),
  )} MB only.`,
  "queue-full": "Too many photos are already waiting to upload. Get online once to send them, then attach this one.",
};

/**
 * Statuses that say "not now" rather than "not ever".
 *
 * 401/403 are in here deliberately, against the instinct that says an
 * auth failure is the client's fault: a rotated or expired session is a
 * property of the moment, not of the file, and the outbox already
 * treats it that way — a 401 from `/api/sync` throws out of the whole
 * drain and every op stays queued. Throwing the photo away instead
 * would make signing back in a data-losing event.
 */
const RETRYABLE_STATUSES = new Set([401, 403, 408, 425, 429]);

/**
 * Whether a failed upload should be given up on.
 *
 * `null` means the request never got an answer — a dropped connection,
 * a DNS failure, a worker that never woke. That is the link, not the
 * file, so it stays queued.
 *
 * Everything else turns on the 4xx/5xx split, which is exactly the
 * distinction the queue needs: a 4xx is the server saying this request
 * is wrong and will be wrong again (413 too large, 404 the payment was
 * deleted, 415 a file type it will not take), while a 5xx is the server
 * saying it could not cope right now. Retrying the first forever is the
 * failure mode this function exists to prevent; retrying the second is
 * the whole point of a queue.
 *
 * There is deliberately NO attempt cap on the retryable side. The
 * outbox has none either — it drops an op only when the server names it
 * bad, never because it has been tried often — and a cap would be a
 * timer that quietly destroys proof after a long enough outage. The
 * engine's own backoff already paces the retries.
 */
export function isPermanentUploadFailure(status: number | null): boolean {
  if (status === null) return false;
  if (RETRYABLE_STATUSES.has(status)) return false;
  return status >= 400 && status < 500;
}

/** What to tell the user when the upload is over for good. Short, and
 *  about the file rather than the protocol — the status code is in the
 *  log, and the user's next move is to choose a different photo. */
export function uploadFailureReason(status: number): string {
  switch (status) {
    case 404:
      return "that payment no longer exists on the server";
    case 413:
      return "the file was too large for the server";
    case 415:
      return "the server does not accept that kind of file";
    default:
      return `the server rejected it (${status})`;
  }
}
