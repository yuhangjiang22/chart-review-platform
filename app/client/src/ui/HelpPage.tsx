// HelpPage — quick reference. Keyboard shortcuts, palette tips, walkthrough
// links. Editorial-scientific styling, three-column footnote layout.
import { ExternalLink, Keyboard, ListChecks, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

export function HelpPage() {
  return (
    <div className="mx-auto max-w-[1080px] px-10 py-10 animate-rise-in">
      <header className="mb-8">
        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Reference · keyboard, palette, walkthrough
        </div>
        <h1
          className="mt-1.5 font-display text-[40px] leading-[1.05] tracking-tight"
          style={{ fontVariationSettings: '"opsz" 60, "SOFT" 60' }}
        >
          Help
        </h1>
        <p className="mt-2 max-w-[64ch] text-[14px] leading-relaxed text-muted-foreground">
          Keyboard shortcuts, ⌘K palette syntax, and pointers into the
          step-by-step usage walkthrough. The platform is keyboard-first —
          most reviewer flows don't need the mouse.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-10 md:grid-cols-2">
        {/* Keyboard shortcuts */}
        <section>
          <SectionHeader icon={Keyboard} caption="Note 1" title="Keyboard" />
          <Table
            rows={[
              ["j", "Next leaf criterion"],
              ["k", "Previous leaf criterion"],
              ["a", "Copy agent draft into the annotation form"],
              ["o", "Open the override form"],
              ["f", "Flag this criterion"],
              ["s", "Focus in-note search"],
              ["c", "Toggle the chat (legacy adjudication mode)"],
              ["⏎", "Submit current — commits the reviewer's annotation"],
              ["g a", "Jump to the next assigned patient (sequence within 1.2s)"],
              ["?", "Toggle this help / shortcut overlay"],
            ]}
          />
        </section>

        {/* Command palette */}
        <section>
          <SectionHeader icon={Search} caption="Note 2" title="⌘K Palette" />
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Open from anywhere with{" "}
            <kbd>⌘</kbd>+<kbd>K</kbd> (mac) or{" "}
            <kbd>ctrl</kbd>+<kbd>K</kbd>. The palette has four sections:
          </p>
          <ul className="mt-3 space-y-2 text-[12.5px]">
            <li>
              <Badge variant="outline" className="!text-[10px] mr-1.5">Views</Badge>
              Jump to Queue · Patient · Studio · Audit · Help.
            </li>
            <li>
              <Badge variant="outline" className="!text-[10px] mr-1.5">Patients</Badge>
              Fuzzy match on patient_id, display name, headline.
            </li>
            <li>
              <Badge variant="outline" className="!text-[10px] mr-1.5">Criteria</Badge>
              Visible only when a patient is open. Match on field_id or prompt.
            </li>
            <li>
              <Badge variant="outline" className="!text-[10px] mr-1.5">Cohort actions</Badge>
              Start pilot · Run calibration · Draft methods · Export bundle.
            </li>
          </ul>
        </section>

        {/* Walkthrough */}
        <section>
          <SectionHeader icon={ListChecks} caption="Note 3" title="Walkthrough" />
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Nine scenarios that exercise every load-bearing surface, ~60 min
            end-to-end. Live in the repo at:
          </p>
          <code className="mt-3 block break-all rounded-md border border-border bg-muted/40 px-3 py-2 text-[11.5px] text-foreground">
            chart-review-platform/docs/usage-walkthrough.md
          </code>
          <ol className="mt-3 space-y-1 text-[12.5px] text-muted-foreground">
            <li>1. Methodologist runs the agent on the cohort</li>
            <li>2. Reviewer validates one patient</li>
            <li>3. The chat copilot during review</li>
            <li>4. Override with copilot-suggested reason</li>
            <li>5. Pre-lock check + lock</li>
            <li>6. Pilot iteration → auto-critique → rule proposals</li>
            <li>7. Calibration</li>
            <li>8. Methods / Results / Limitations drafter</li>
            <li>9. Reproducibility bundle export</li>
          </ol>
        </section>

        {/* External pointers */}
        <section>
          <SectionHeader icon={ExternalLink} caption="Note 4" title="Project links" />
          <ul className="space-y-2 text-[12.5px]">
            <Link href="https://github.com/YeechingTiger/Chart-Review-Agents" label="Source on GitHub" />
            <Link
              href="https://openrouter.ai/docs/guides/coding-agents/claude-code-integration"
              label="Claude Agent SDK · OpenRouter routing"
            />
            <Link
              href="https://docs.claude.com/en/agent-sdk/quickstart"
              label="Claude Agent SDK quickstart"
            />
          </ul>
          <Separator className="my-5" />
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            This is the default UI. Pass{" "}
            <code className="font-mono text-[10.5px]">/?ui=v1</code> to fall
            back to the legacy 3-pane app — kept around as a safety net while
            the e2e suite migrates.
          </p>
        </section>
      </div>
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  caption,
  title,
}: {
  icon: typeof Keyboard;
  caption: string;
  title: string;
}) {
  return (
    <header className="mb-4">
      <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">{caption}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <Icon size={14} className="text-muted-foreground/70" strokeWidth={1.75} />
        <h2 className="font-display text-[22px] tracking-tight" style={{ fontVariationSettings: '"opsz" 24, "SOFT" 50' }}>
          {title}
        </h2>
      </div>
    </header>
  );
}

function Table({ rows }: { rows: Array<[string, string]> }) {
  return (
    <table className="w-full border-collapse text-[12.5px]">
      <tbody>
        {rows.map(([key, desc]) => (
          <tr key={key} className="border-b border-border/40">
            <td className="w-24 py-1.5 pr-4">
              {key.split(/(\s+)/).map((part, i) => (
                /\s+/.test(part) ? <span key={i}>{part}</span> : <kbd key={i}>{part}</kbd>
              ))}
            </td>
            <td className="py-1.5 text-muted-foreground">{desc}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Link({ href, label }: { href: string; label: string }) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-foreground underline-offset-4 hover:underline"
      >
        {label} <ExternalLink size={11} strokeWidth={1.5} />
      </a>
    </li>
  );
}
