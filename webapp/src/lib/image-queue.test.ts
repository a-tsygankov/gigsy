import { describe, it, expect } from "vitest";
import {
  MAX_IMAGE_BYTES,
  MAX_QUEUE_BYTES,
  isPermanentUploadFailure,
  refuseQueuedImage,
  uploadFailureReason,
} from "./image-queue.ts";

describe("refuseQueuedImage", () => {
  it("takes an ordinary photo", () => {
    expect(refuseQueuedImage(3 * 1024 * 1024, 0)).toBeNull();
  });

  it("refuses one file that is too big on its own", () => {
    expect(refuseQueuedImage(MAX_IMAGE_BYTES + 1, 0)).toBe("too-large");
  });

  it("takes one exactly at the ceiling", () => {
    // The boundary is stated as "up to N MB" in the message the user
    // reads, so N itself has to be allowed or the message is a lie.
    expect(refuseQueuedImage(MAX_IMAGE_BYTES, 0)).toBeNull();
  });

  it("refuses a photo that would push the queue past its ceiling", () => {
    expect(refuseQueuedImage(1024, MAX_QUEUE_BYTES)).toBe("queue-full");
  });

  it("refuses the NEW photo rather than making room by dropping an old one", () => {
    // The distinction this test exists for: every entry is proof of a
    // payment that exists nowhere else, so the queue is not a cache and
    // its ceiling is not an eviction trigger. The only observable of
    // "refuse rather than evict" at this layer is that a full queue
    // says no — LocalStore.queueImage is where the absence of any
    // deletion is visible, and local-store.test.ts asserts it there.
    expect(refuseQueuedImage(1, MAX_QUEUE_BYTES)).toBe("queue-full");
    expect(refuseQueuedImage(1, MAX_QUEUE_BYTES - 1)).toBeNull();
  });

  it("size is judged before the queue's total, so an oversized file is named as such", () => {
    // Both rules break at once here. "too-large" is the more useful
    // answer: it is about the file the user just chose and tells them
    // to choose a different one, where "queue-full" would send them off
    // to find a connection that would not have helped.
    expect(refuseQueuedImage(MAX_IMAGE_BYTES + 1, MAX_QUEUE_BYTES)).toBe("too-large");
  });
});

describe("isPermanentUploadFailure", () => {
  it("keeps a photo when the request never got an answer", () => {
    // No status at all is a dropped link, a sleeping worker, DNS. The
    // file is fine; the moment is not.
    expect(isPermanentUploadFailure(null)).toBe(false);
  });

  it("keeps a photo through a server-side failure", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isPermanentUploadFailure(status)).toBe(false);
    }
  });

  it("keeps a photo through an expired session", () => {
    // 401/403 look like client faults and are not: a rotated session is
    // a property of the moment. The outbox agrees — a 401 from
    // /api/sync leaves every op queued — and signing back in must not
    // be a data-losing event.
    expect(isPermanentUploadFailure(401)).toBe(false);
    expect(isPermanentUploadFailure(403)).toBe(false);
  });

  it("keeps a photo through the explicit try-again statuses", () => {
    for (const status of [408, 425, 429]) {
      expect(isPermanentUploadFailure(status)).toBe(false);
    }
  });

  it("gives up on the refusals that will not change", () => {
    // Too large, gone, wrong type, malformed. Retrying any of these
    // forever is the failure this function exists to prevent.
    for (const status of [400, 404, 409, 413, 415, 422]) {
      expect(isPermanentUploadFailure(status)).toBe(true);
    }
  });
});

describe("uploadFailureReason", () => {
  it("says what happened in terms of the file, not the protocol", () => {
    expect(uploadFailureReason(413)).toContain("too large");
    expect(uploadFailureReason(404)).toContain("no longer exists");
    expect(uploadFailureReason(415)).toContain("kind of file");
  });

  it("still names an unexpected refusal rather than shrugging", () => {
    expect(uploadFailureReason(451)).toContain("451");
  });
});
