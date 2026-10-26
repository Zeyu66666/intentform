/**
 * Tailwind 只做一件事：把 `styles/tokens.css` 里的 CSS 变量接到工具类名上。
 * 主题值不写在这里——写在这里就会有两份真相，`tokens.css` 改一个颜色而
 * 工具类不跟着变，是这类项目最常见的样式漂移。
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--color-bg)",
        surface: "var(--color-surface)",
        line: "var(--color-border)",
        ink: "var(--color-text)",
        muted: "var(--color-text-muted)",
        accent: "var(--color-accent)",
      },
      fontSize: {
        xs: ["var(--text-xs)", { lineHeight: "var(--leading-tight)" }],
        sm: ["var(--text-sm)", { lineHeight: "var(--leading-tight)" }],
        base: ["var(--text-base)", { lineHeight: "var(--leading-normal)" }],
        lg: ["var(--text-lg)", { lineHeight: "var(--leading-snug)" }],
        xl: ["var(--text-xl)", { lineHeight: "var(--leading-snug)" }],
      },
      spacing: {
        1: "var(--space-1)",
        2: "var(--space-2)",
        3: "var(--space-3)",
        4: "var(--space-4)",
        5: "var(--space-5)",
        6: "var(--space-6)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
      },
    },
  },
  plugins: [],
};
