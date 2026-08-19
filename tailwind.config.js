/*
  Ersetzt die frühere Inline-Konfiguration der Tailwind-CDN. Gescannt werden
  index.html und die JSX-Quelle; alle Klassennamen stehen dort als vollständige
  Zeichenketten, auch die in Template-Literalen und in Funktionen wie
  getScoreColor — dynamisch zusammengesetzte Namen (`text-${x}-500`) gibt es
  bewusst nicht, die würde der Scanner nicht finden.
*/
module.exports = {
  content: ["./index.html", "./src/**/*.jsx"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        slate: { 850: "#151f32", 950: "#020617" },
      },
    },
  },
};
