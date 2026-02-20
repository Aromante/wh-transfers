import type { Config } from 'tailwindcss'

export default {
  content: ['index.html', 'src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // opcional, el shell usa fuentes modernas; esto ayuda a armonizar
        sans: ["Inter", "ui-sans-serif", "system-ui", "Segoe UI", "Roboto", "Helvetica", "Arial", "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji"],
      },
    },
  },
  plugins: [],
} satisfies Config

