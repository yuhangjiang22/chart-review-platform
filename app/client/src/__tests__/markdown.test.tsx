import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../markdown";

describe("renderMarkdown", () => {
  it("renders paragraphs", () => {
    const out = renderMarkdown("hello world");
    expect(out).toContain("<p>");
    expect(out).toContain("hello world");
  });
  it("renders bold + italic", () => {
    const out = renderMarkdown("**bold** and *italic*");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
  });
  it("renders ordered + unordered lists", () => {
    const out = renderMarkdown("- a\n- b");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>a</li>");
  });
  it("renders inline code", () => {
    const out = renderMarkdown("use `npm test`");
    expect(out).toContain("<code>npm test</code>");
  });
  it("escapes <, >, & before formatting (XSS hardening)", () => {
    const out = renderMarkdown("<script>alert('x')</script> A & B");
    // The script tag must be escaped, never rendered as HTML
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&amp;");
  });
});
