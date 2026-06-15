/** @type {import('tailwindcss').Config} */
//
// Chart-Review-Platform v2 theme.
//
// Aesthetic direction: editorial-scientific. Cream paper background, warm
// graphite ink, oxblood accent for decisive actions (lock, submit), ochre
// for marginalia / warnings, sage for validated state. Type stack pairs a
// characterful display serif (Fraunces) with a precise body sans (IBM Plex
// Sans) and Plex Mono for evidence quotes / terminal output.
//
// Tokens are exposed as CSS variables in client/src/index.css so shadcn
// primitives can pick them up (they expect `--background`, `--foreground`,
// etc.). The Tailwind keys below map to those vars so utility classes
// (`bg-background`, `text-muted-foreground`) keep working.
export default {
  darkMode: ["class"],
  content: ["./client/index.html", "./client/src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        // shadcn-style semantic tokens, driven by CSS vars in index.css
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
          foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "hsl(var(--popover) / <alpha-value>)",
          foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
        },
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
        },
        // Editorial palette extras
        ink: "hsl(var(--ink) / <alpha-value>)",
        paper: "hsl(var(--paper) / <alpha-value>)",
        oxblood: "hsl(var(--oxblood) / <alpha-value>)",
        ochre: "hsl(var(--ochre) / <alpha-value>)",
        sage: "hsl(var(--sage) / <alpha-value>)",
        // Legacy slate scale + tokens kept so the old UI (default until the
        // user toggles ?ui=v2) keeps rendering during the migration window.
        slate: {
          50: "#f8fafc", 100: "#f1f5f9", 200: "#e2e8f0", 300: "#cbd5e1",
          400: "#94a3b8", 500: "#64748b", 600: "#475569", 700: "#334155",
          800: "#1e293b", 900: "#0f172a", 950: "#020617",
        },
        ok: { DEFAULT: "#15803d", soft: "#dcfce7", border: "#bbf7d0" },
        warn: { DEFAULT: "#a16207", soft: "#fef9c3", border: "#fde68a" },
        err: { DEFAULT: "#b91c1c", soft: "#fee2e2", border: "#fecaca" },
        cite: { bg: "#fef3c7", edge: "#a16207" },
      },
      fontFamily: {
        // Display: Fraunces — characterful serif with optical-size axis.
        display: ['"Fraunces"', "Georgia", "serif"],
        // Body / UI: IBM Plex Sans — workhorse, more character than Inter.
        sans: [
          '"IBM Plex Sans"',
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: [
          '"IBM Plex Mono"',
          '"JetBrains Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
        // Numeric / data — Plex Sans with tabular figures. Used via a CSS
        // class that toggles font-feature-settings.
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        // Restrained shadows — the cream paper background gives depth on its
        // own, so cards lift with subtle warmth, not glassy glow.
        page: "0 1px 0 0 hsl(var(--border) / 0.4)",
        card: "0 1px 2px 0 hsl(20 15% 25% / 0.04), 0 1px 1px 0 hsl(20 15% 25% / 0.03)",
        pop: "0 8px 24px -8px hsl(20 15% 25% / 0.12), 0 2px 6px -2px hsl(20 15% 25% / 0.06)",
        seal: "0 1px 0 0 hsl(0 60% 25% / 0.18), 0 0 0 0.5px hsl(0 60% 25% / 0.14)",
      },
      backgroundImage: {
        // Faint horizontal rule pattern — like ledger paper, low opacity.
        "ledger": "repeating-linear-gradient(0deg, transparent 0px, transparent 31px, hsl(var(--border) / 0.55) 31px, hsl(var(--border) / 0.55) 32px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "rise-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 200ms ease-out",
        "rise-in": "rise-in 240ms cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [
    // shadcn animation utilities; this gives us `data-[state=open]:animate-in`,
    // `slide-in-from-right`, etc. for the Radix primitives.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("tailwindcss-animate"),
  ],
};
