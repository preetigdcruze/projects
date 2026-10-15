import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const c = (v: string) => `hsl(var(--${v}) / <alpha-value>)`;

export default {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1rem" },
    extend: {
      colors: {
        background: c("background"), foreground: c("foreground"), card: c("card"), "card-foreground": c("foreground"),
        muted: c("muted"), "muted-foreground": c("muted-foreground"), border: c("border"), input: c("border"), ring: c("ring"),
        primary: c("primary"), "primary-foreground": c("primary-foreground"), secondary: c("secondary"), "secondary-foreground": c("secondary-foreground"),
        accent: c("accent"), "accent-foreground": c("accent-foreground"), danger: c("danger"),
        protein: c("protein"), carbs: c("carbs"), fat: c("fat"),
      },
      fontFamily: {
        display: ["var(--font-display)"],
        sans: ["var(--font-sans)"],
      },
      borderRadius: { xl: "1rem", "2xl": "1.25rem", "3xl": "1.75rem" },
      boxShadow: {
        soft: "0 1px 2px hsl(24 20% 12% / 0.04), 0 8px 24px -8px hsl(24 20% 12% / 0.10)",
        lift: "0 2px 4px hsl(24 20% 12% / 0.05), 0 16px 40px -12px hsl(24 20% 12% / 0.18)",
      },
      keyframes: {
        shimmer: { "100%": { transform: "translateX(100%)" } },
        pop: { "0%": { transform: "scale(1)" }, "40%": { transform: "scale(1.3)" }, "100%": { transform: "scale(1)" } },
      },
      animation: { shimmer: "shimmer 1.6s infinite", pop: "pop 0.3s ease-out" },
    },
  },
  plugins: [animate],
} satisfies Config;
