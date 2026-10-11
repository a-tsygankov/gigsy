import { describe, expect, it } from "vitest";
import {
  FEEDBACK_MAX_IMAGES,
  FEEDBACK_MAX_MESSAGE,
  FEEDBACK_MAX_TOTAL_BYTES,
  addFeedbackImages,
  feedbackProblem,
} from "./feedback.ts";
import { MAX_IMAGE_BYTES } from "./image-queue.ts";

/** A file whose `size` is whatever the check needs to see, without
 *  allocating it — the bytes are never read (Capture.test.tsx does the
 *  same for its oversize case). */
function image(name: string, size = 10, type = "image/png"): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("addFeedbackImages", () => {
  it("accepts images up to the count cap and refuses nothing", () => {
    const chosen = [image("a.png"), image("b.jpg", 10, "image/jpeg")];
    const result = addFeedbackImages([], chosen);
    expect(result.images).toEqual(chosen);
    expect(result.refused).toEqual([]);
  });

  it("appends to what is already attached", () => {
    const first = image("a.png");
    const second = image("b.png");
    const result = addFeedbackImages([first], [second]);
    expect(result.images).toEqual([first, second]);
  });

  it("refuses a file that is not an image, by name", () => {
    const result = addFeedbackImages([], [image("sheet.pdf", 10, "application/pdf")]);
    expect(result.images).toEqual([]);
    expect(result.refused).toEqual(["sheet.pdf isn't an image."]);
  });

  it("refuses a file over the per-image ceiling, with the limit in the sentence", () => {
    const result = addFeedbackImages([], [image("huge.png", MAX_IMAGE_BYTES + 1)]);
    expect(result.images).toEqual([]);
    expect(result.refused).toEqual(["huge.png is too large — keep each image under 8 MB."]);
  });

  it("keeps a file exactly at the per-image ceiling", () => {
    const result = addFeedbackImages([], [image("edge.png", MAX_IMAGE_BYTES)]);
    expect(result.images).toHaveLength(1);
    expect(result.refused).toEqual([]);
  });

  it("refuses the sixth image and keeps the first five", () => {
    const chosen = Array.from({ length: FEEDBACK_MAX_IMAGES + 1 }, (_, i) =>
      image(`shot-${i}.png`),
    );
    const result = addFeedbackImages([], chosen);
    expect(result.images).toHaveLength(FEEDBACK_MAX_IMAGES);
    expect(result.refused).toEqual([
      `shot-${FEEDBACK_MAX_IMAGES}.png wasn't added — up to ${FEEDBACK_MAX_IMAGES} images per message.`,
    ]);
  });

  it("counts images already attached toward the cap", () => {
    const current = Array.from({ length: FEEDBACK_MAX_IMAGES }, (_, i) =>
      image(`have-${i}.png`),
    );
    const result = addFeedbackImages(current, [image("one-more.png")]);
    expect(result.images).toEqual(current);
    expect(result.refused).toHaveLength(1);
  });

  it("refuses an image that would push the total over the ceiling, with the total in the sentence", () => {
    // Three 7 MB images are each under 8 MB but 21 MB together.
    const seven = 7 * 1024 * 1024;
    const chosen = [image("a.png", seven), image("b.png", seven), image("c.png", seven)];
    const result = addFeedbackImages([], chosen);
    expect(result.images.map((f) => f.name)).toEqual(["a.png", "b.png"]);
    expect(result.refused).toEqual([
      "c.png wasn't added — all images together must stay under 20 MB.",
    ]);
  });

  it("does not let one refusal stop a later acceptable file", () => {
    // A bad file in the middle of a selection is skipped, not fatal.
    const result = addFeedbackImages([], [
      image("a.png"),
      image("notes.txt", 10, "text/plain"),
      image("b.png"),
    ]);
    expect(result.images.map((f) => f.name)).toEqual(["a.png", "b.png"]);
    expect(result.refused).toHaveLength(1);
  });

  it("never mutates the list it was given", () => {
    const current = [image("a.png")];
    addFeedbackImages(current, [image("b.png")]);
    expect(current).toHaveLength(1);
  });

  it("exposes the same numbers the server enforces", () => {
    // The route (backend/src/routes/feedback.ts) checks 5 / 8 MB / 20 MB
    // / 4000. A drift here means a refusal the form never warned about.
    expect(FEEDBACK_MAX_IMAGES).toBe(5);
    expect(FEEDBACK_MAX_TOTAL_BYTES).toBe(20 * 1024 * 1024);
    expect(FEEDBACK_MAX_MESSAGE).toBe(4000);
  });
});

describe("feedbackProblem", () => {
  it("is null for a message with something in it", () => {
    expect(feedbackProblem("The gig list is empty after sync.", [])).toBeNull();
  });

  it("blocks an empty or whitespace-only message", () => {
    expect(feedbackProblem("", [])).toBe("Write what happened first.");
    expect(feedbackProblem("   \n", [])).toBe("Write what happened first.");
  });

  it("blocks a message over the length ceiling, and allows one at it", () => {
    expect(feedbackProblem("x".repeat(FEEDBACK_MAX_MESSAGE), [])).toBeNull();
    expect(feedbackProblem("x".repeat(FEEDBACK_MAX_MESSAGE + 1), [])).toBe(
      "Keep the message under 4000 characters.",
    );
  });

  it("does not block on images alone — they are optional", () => {
    expect(feedbackProblem("ok", [image("a.png")])).toBeNull();
  });

  it("blocks when the attached images somehow exceed the caps", () => {
    // `addFeedbackImages` is the gate, but Send checks again so a list
    // assembled another way can never go out oversize.
    const tooMany = Array.from({ length: FEEDBACK_MAX_IMAGES + 1 }, (_, i) =>
      image(`s-${i}.png`),
    );
    expect(feedbackProblem("ok", tooMany)).toBe("Up to 5 images per message.");
    const heavy = [image("a.png", 11 * 1024 * 1024), image("b.png", 10 * 1024 * 1024)];
    expect(feedbackProblem("ok", heavy)).toBe("All images together must stay under 20 MB.");
  });
});
