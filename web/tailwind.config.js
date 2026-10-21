/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ["Inter", "system-ui", "sans-serif"], mono: ["JetBrains Mono", "monospace"] },
      colors: { brand: { 50: "#ecfdf8", 100: "#d1faec", 500: "#0f9d84", 600: "#0b8571", 700: "#0a6b5c" } },
    },
  },
  plugins: [],
};
