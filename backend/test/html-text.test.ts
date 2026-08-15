/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { htmlToText } from "../src/capture/html-text.ts";

describe("htmlToText", () => {
  it("keeps the prose and drops the markup", async () => {
    const text = await htmlToText(
      "<html><body><p>Costco on 5th</p><p>$150 for six hours</p></body></html>",
    );
    expect(text).toContain("Costco on 5th");
    expect(text).toContain("$150 for six hours");
    expect(text).not.toContain("<p>");
  });

  it("never treats stylesheet or script source as prose", async () => {
    // A tag-stripping regex fails exactly here, and the failure is
    // expensive: CSS is long, and it would be sent to the model as text.
    const text = await htmlToText(
      "<html><head><style>.a{color:red}</style><title>Ignore me</title></head>" +
        "<body><script>var x = 'hello';</script><p>Real body</p></body></html>",
    );
    expect(text).toBe("Real body");
  });

  it("separates block elements so words do not run together", async () => {
    const text = await htmlToText("<div>Saturday</div><div>10am</div>");
    expect(text).not.toContain("Saturday10am");
  });

  it("breaks table rows and list items apart", async () => {
    const text = await htmlToText(
      "<table><tr><td>Date</td></tr><tr><td>Sat 3rd</td></tr></table>",
    );
    expect(text).not.toContain("DateSat");
  });

  it("decodes the entities a mail client emits", async () => {
    const text = await htmlToText("<p>Ben &amp; Jerry&#39;s&nbsp;booking</p>");
    expect(text).toContain("Ben & Jerry's");
    expect(text).not.toContain("&amp;");
    expect(text).not.toContain("&#39;");
  });

  it("collapses the whitespace that HTML mail is padded with", async () => {
    const text = await htmlToText(
      "<p>   Lots\n\n\n   of      space   </p>\n\n\n<p>here</p>",
    );
    expect(text).toBe("Lots of space\nhere");
  });

  it("is empty for empty input rather than throwing", async () => {
    expect(await htmlToText("")).toBe("");
  });
});
