/**
 * The readable text of an HTML email body.
 *
 * Booking platforms routinely send HTML-only mail. PostalMime then
 * leaves `text` empty, and extraction used to see the subject line and
 * nothing else — a draft built from six words.
 *
 * HTMLRewriter rather than a regex or a new dependency: it is the
 * runtime's own streaming parser, so it costs no bundle size and it
 * will not mistake the contents of <style> for prose the way a
 * tag-stripping regex does.
 */

/** Tags whose boundary is a line break, so words do not run together. */
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "br",
  "tr",
  "li",
  "table",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

/**
 * Marks a block boundary while the document is being walked.
 *
 * A literal newline cannot do this job: newlines inside HTML text
 * content are only whitespace — mail is hard-wrapped at 70-odd columns,
 * so a single paragraph arrives full of them — and the breaks that mean
 * something have to stay distinguishable from the ones that do not
 * until after the source whitespace has been collapsed.
 */
const BREAK = "\u0000";

/**
 * The handful of entities worth decoding by hand. Everything numeric is
 * covered generically; the named set is deliberately short because mail
 * clients emit these and little else.
 */
function decodeEntities(text: string): string {
  return (
    text
      .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
      .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) =>
        String.fromCodePoint(parseInt(h, 16)),
      )
      .replace(/&nbsp;/gi, " ")
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      // Ampersand last: decoding it first would turn "&amp;lt;" into "<".
      .replace(/&amp;/gi, "&")
  );
}

export async function htmlToText(html: string): Promise<string> {
  if (html.trim() === "") return "";

  const out: string[] = [];
  let skipDepth = 0;

  const rewriter = new HTMLRewriter()
    .on("script, style, title", {
      element(el) {
        skipDepth += 1;
        el.onEndTag(() => {
          skipDepth -= 1;
        });
      },
    })
    .on("*", {
      element(el) {
        if (BLOCK_TAGS.has(el.tagName.toLowerCase())) out.push(BREAK);
      },
      text(chunk) {
        if (skipDepth === 0) out.push(chunk.text);
      },
    });

  await rewriter.transform(new Response(html)).text();

  return (
    decodeEntities(out.join(""))
      // Every run of source whitespace becomes one space. \s covers the
      // non-breaking space too, and never matches the BREAK marker.
      .replace(/\s+/g, " ")
      .replace(/ ?\u0000 ?/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim()
  );
}
