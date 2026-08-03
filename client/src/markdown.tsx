/** Tiny markdown renderer — paragraphs, **bold**, *italic*, `code`, - lists.
 *  Returns HTML string; consumer renders via `dangerouslySetInnerHTML`. */
export function renderMarkdown(src: string): string {
  if (!src) return "";
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = src.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = escape(raw);
    if (/^\s*-\s+/.test(line)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inlineFmt(line.replace(/^\s*-\s+/, ""))}</li>`);
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      if (line.trim()) out.push(`<p>${inlineFmt(line)}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("");
}

// Known limitation: code spans containing markdown-like syntax (e.g., `*pattern*`)
// will have their content further formatted. Acceptable for author-controlled
// guidance prose; revisit if user-supplied content ever flows through here.
function inlineFmt(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  return <div className={`prose-sm ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />;
}
