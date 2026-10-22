/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ["Archivo", "system-ui", "sans-serif"], mono: ["IBM Plex Mono", "monospace"] },
      colors: {
        paper: "#F9F7F1",
        sheet: "#FFFFFF",
        ink: "#1D2521",
        muted: "#6B6F66",
        carbon: { DEFAULT: "#009B77", wash: "#B2E1D6", deep: "#00735A" },
        rule: "#DED0AB",
        margin: "#C8B273",
        stamp: "#B8322A",
        ledger: "#00735A",
        gold: { DEFAULT: "#C8B273", deep: "#7D6A2E" },
      },
    },
  },
  plugins: [],
};
