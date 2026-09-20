import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
    darkMode: "media",
  theme: {
    extend: {
      colors: {
        ink: "var(--ink)", "ink-soft": "var(--ink-soft)",
        "brand-deep": "var(--brand-deep)", brand: "var(--brand)",
        milk: "var(--milk)", "milk-deep": "var(--milk-deep)",
        surface: "var(--surface)", line: "var(--line)",
        "gold-green": "var(--gold-green)", "gold-green-dark": "var(--gold-green-dark)",
        gold: "var(--gold)", success: "var(--success)", warning: "var(--warning)", danger: "var(--danger)"
      },
      fontFamily: { sans: ["var(--font-inter)", "IBM Plex Sans", "system-ui", "sans-serif"] },
      borderRadius: { card: "10px", input: "8px", modal: "14px" },
      spacing: {
        "4": "4px", "8": "8px", "12": "12px", "16": "16px",
        "24": "24px", "32": "32px", "48": "48px", "64": "64px"
      }
    }
  },
  plugins: []
} satisfies Config;