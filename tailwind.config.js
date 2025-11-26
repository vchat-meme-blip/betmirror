/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./*.{js,ts,jsx,tsx}"
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        poly: {
          50: '#f0f9ff',
          900: '#0c4a6e',
        },
        terminal: {
          bg: '#050505',
          card: '#0a0a0a',
          border: '#1f1f1f',
          accent: '#3b82f6',
          success: '#10b981',
          danger: '#ef4444',
          warn: '#eab308'
        }
      }
    },
  },
  plugins: [],
}