/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ["Archivo", "system-ui", "sans-serif"], mono: ["IBM Plex Mono", "monospace"] },
      colors: {
        paper: "#EEEDF5",
        sheet: "#FFFFFF",
        ink: "#1E1B33",
        muted: "#68657F",
        carbon: { DEFAULT: "#4338A8", wash: "#ECEAF8", deep: "#2F2780" },
        rule: "#D6DBEC",
        margin: "#E28A85",
        stamp: "#B8322A",
        ledger: "#2F7A55",
      },
    },
  },
  plugins: [],
};
