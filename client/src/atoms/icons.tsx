// Inline SVG icon set ported from ui/src/icons.jsx.
// Uses ReactNode map because most icons are multi-element (polyline, circle, g, etc.)
// rather than single <path> strings.
import { SVGProps, ReactNode } from "react";

export type IconName =
  | "activity"
  | "alert"
  | "arrowLeft"
  | "arrowRight"
  | "book"
  | "branch"
  | "check"
  | "chevronDown"
  | "chevronRight"
  | "chevronUp"
  | "clock"
  | "code"
  | "delta"
  | "eye"
  | "eyeOff"
  | "file"
  | "fileText"
  | "flask"
  | "grid"
  | "helpCircle"
  | "history"
  | "info"
  | "keyboard"
  | "layers"
  | "list"
  | "pencil"
  | "play"
  | "quote"
  | "rotate"
  | "scan"
  | "search"
  | "skipForward"
  | "sparkle"
  | "sparkles"
  | "stethoscope"
  | "tag"
  | "target"
  | "user"
  | "x";

const NODES: Record<IconName, ReactNode> = {
  activity: <polyline points="3 12 7 12 10 5 14 19 17 12 21 12" />,
  alert: (
    <g>
      <path d="M12 3 2 21h20z" />
      <line x1="12" y1="10" x2="12" y2="14" />
      <circle cx="12" cy="17.5" r="0.5" fill="currentColor" />
    </g>
  ),
  arrowLeft: (
    <g>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="11 6 5 12 11 18" />
    </g>
  ),
  arrowRight: (
    <g>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="13 6 19 12 13 18" />
    </g>
  ),
  book: (
    <g>
      <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" />
      <line x1="5" y1="17" x2="19" y2="17" />
    </g>
  ),
  branch: (
    <g>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="19" r="2" />
      <circle cx="6" cy="19" r="2" />
      <path d="M6 7v10" />
      <path d="M6 12c8 0 12-2 12-7" />
    </g>
  ),
  check: <polyline points="4 12 10 18 20 6" />,
  chevronDown: <polyline points="6 9 12 15 18 9" />,
  chevronRight: <polyline points="9 6 15 12 9 18" />,
  chevronUp: <polyline points="6 15 12 9 18 15" />,
  clock: (
    <g>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </g>
  ),
  code: (
    <g>
      <polyline points="8 7 3 12 8 17" />
      <polyline points="16 7 21 12 16 17" />
    </g>
  ),
  delta: <polygon points="12 4 21 20 3 20" />,
  eye: (
    <g>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </g>
  ),
  eyeOff: (
    <g>
      <path d="M2 12s3.5-7 10-7c2.4 0 4.4.95 6 2.2" />
      <path d="M22 12s-3.5 7-10 7c-2.4 0-4.4-.95-6-2.2" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </g>
  ),
  file: (
    <g>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14 3 14 8 19 8" />
    </g>
  ),
  fileText: (
    <g>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14 3 14 8 19 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="15" y2="17" />
    </g>
  ),
  flask: (
    <g>
      <path d="M9 3h6" />
      <path d="M10 3v7l-4 8a2 2 0 0 0 1.8 3h8.4A2 2 0 0 0 18 18l-4-8V3" />
    </g>
  ),
  grid: (
    <g>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </g>
  ),
  helpCircle: (
    <g>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 4" />
      <circle cx="12" cy="17" r="0.5" fill="currentColor" />
    </g>
  ),
  history: (
    <g>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <polyline points="3 4 3 8 7 8" />
      <polyline points="12 8 12 13 15 15" />
    </g>
  ),
  info: (
    <g>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="8" r="0.5" fill="currentColor" />
    </g>
  ),
  keyboard: (
    <g>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <line x1="6" y1="10" x2="6" y2="10" />
      <line x1="10" y1="10" x2="10" y2="10" />
      <line x1="14" y1="10" x2="14" y2="10" />
      <line x1="18" y1="10" x2="18" y2="10" />
      <line x1="7" y1="14" x2="17" y2="14" />
    </g>
  ),
  layers: (
    <g>
      <polygon points="12 3 22 9 12 15 2 9" />
      <polyline points="2 14 12 20 22 14" />
    </g>
  ),
  list: (
    <g>
      <line x1="9" y1="6" x2="20" y2="6" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="9" y1="18" x2="20" y2="18" />
      <circle cx="5" cy="6" r="1" fill="currentColor" />
      <circle cx="5" cy="12" r="1" fill="currentColor" />
      <circle cx="5" cy="18" r="1" fill="currentColor" />
    </g>
  ),
  pencil: (
    <g>
      <path d="M4 20h4l11-11-4-4L4 16z" />
      <line x1="13" y1="6" x2="17" y2="10" />
    </g>
  ),
  play: <polygon points="6 4 20 12 6 20" />,
  quote: (
    <g>
      <path d="M7 7h4v4c0 3-1.5 5-4 6" />
      <path d="M14 7h4v4c0 3-1.5 5-4 6" />
    </g>
  ),
  rotate: (
    <g>
      <path d="M3 12a9 9 0 0 1 15.5-6.3" />
      <polyline points="20 4 19 9 14 8" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3" />
      <polyline points="4 20 5 15 10 16" />
    </g>
  ),
  scan: (
    <g>
      <path d="M4 8V6a2 2 0 0 1 2-2h2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v2" />
      <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
      <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
      <line x1="4" y1="12" x2="20" y2="12" />
    </g>
  ),
  search: (
    <g>
      <circle cx="11" cy="11" r="6" />
      <line x1="20" y1="20" x2="16" y2="16" />
    </g>
  ),
  skipForward: (
    <g>
      <polygon points="5 5 14 12 5 19" />
      <line x1="17" y1="5" x2="17" y2="19" />
    </g>
  ),
  sparkle: (
    <g>
      <path d="M12 3v6" />
      <path d="M12 15v6" />
      <path d="M3 12h6" />
      <path d="M15 12h6" />
      <path d="M6 6l3 3" />
      <path d="M15 15l3 3" />
      <path d="M18 6l-3 3" />
      <path d="M9 15l-3 3" />
    </g>
  ),
  sparkles: (
    <g>
      <path d="M12 4l1.5 4 4 1.5-4 1.5L12 15l-1.5-4-4-1.5 4-1.5z" />
      <path d="M19 14l.7 1.8 1.8.7-1.8.7L19 19l-.7-1.8-1.8-.7 1.8-.7z" />
    </g>
  ),
  stethoscope: (
    <g>
      <path d="M5 4v6a4 4 0 0 0 4 4 4 4 0 0 0 4-4V4" />
      <path d="M9 14v2a4 4 0 0 0 8 0v-2" />
      <circle cx="17" cy="10" r="2" />
    </g>
  ),
  tag: (
    <g>
      <path d="M3 12V4h8l10 10-8 8z" />
      <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" />
    </g>
  ),
  target: (
    <g>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </g>
  ),
  user: (
    <g>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </g>
  ),
  x: (
    <g>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="6" y1="18" x2="18" y2="6" />
    </g>
  ),
};

export interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16, className = "", ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      {...rest}
    >
      {NODES[name] ?? null}
    </svg>
  );
}
