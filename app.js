/*
 * Quelle der Anwendung. Wird mit `npm run build:js` nach app.js übersetzt;
 * ausgeliefert wird die Übersetzung, nicht diese Datei. Vor den Änderungen
 * transpilierte Babel dieses JSX bei jedem Seitenaufruf im Browser — das
 * kostete rund drei Megabyte Babel-Download pro Besuch und lud die
 * Bibliotheken von fremden Servern.
 */

const {
  useState,
  useEffect,
  useRef
} = React;

// ------------------------------------------------------------------
// DARSTELLUNG DER VORFÄLLE
// ------------------------------------------------------------------
// Die frühere Lagekarte wurde durch eine zeitlich geordnete
// Vorfallsliste ersetzt: jeder Eintrag ist an eine belegte Quelle
// gebunden, sodass die Darstellung durchgehend "grounded" bleibt und
// kein Vorfall mehr an fehlenden Koordinaten scheitert.
const severityColor = sev => {
  if (sev === 'hoch') return '#dc2626';
  if (sev === 'mittel') return '#f59e0b';
  return '#10b981';
};
const severityLabel = sev => {
  if (sev === 'hoch') return 'Hohe Schwere';
  if (sev === 'mittel') return 'Mittlere Schwere';
  return 'Niedrige Schwere';
};

// Vorfälle absteigend nach Datum sortieren (neueste zuerst). Einträge
// ohne Datum wandern ans Ende. Datumsformat "YYYY-MM-DD" lässt sich als
// Zeichenkette korrekt vergleichen.
const sortByDateDesc = list => [...list].sort((a, b) => {
  const da = a.date || '';
  const db = b.date || '';
  if (da === db) return 0;
  if (!da) return 1;
  if (!db) return -1;
  return db.localeCompare(da);
});
const formatDate = value => {
  if (!value) return 'Datum unbekannt';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });
};
const hostOf = url => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return 'Quelle';
  }
};

// --- ICONS ---
const Icon = ({
  name,
  size = 24,
  className = ""
}) => {
  const icons = {
    Shield: /*#__PURE__*/React.createElement("path", {
      d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
    }),
    Activity: /*#__PURE__*/React.createElement("path", {
      d: "M22 12h-4l-3 9L9 3l-3 9H2"
    }),
    Terminal: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("polyline", {
      points: "4 17 10 11 4 5"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "12",
      y1: "19",
      x2: "20",
      y2: "19"
    })),
    Search: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
      cx: "11",
      cy: "11",
      r: "8"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "21",
      y1: "21",
      x2: "16.65",
      y2: "16.65"
    })),
    Zap: /*#__PURE__*/React.createElement("polygon", {
      points: "13 2 3 14 12 14 11 22 21 10 12 10 13 2"
    }),
    ExternalLink: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
      d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
    }), /*#__PURE__*/React.createElement("polyline", {
      points: "15 3 21 3 21 9"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "10",
      y1: "14",
      x2: "21",
      y2: "3"
    })),
    Globe: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "10"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "2",
      y1: "12",
      x2: "22",
      y2: "12"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
    })),
    RefreshCw: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
      d: "M23 4v6h-6"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M1 20v-6h6"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"
    })),
    AlertCircle: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "10"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "12",
      y1: "8",
      x2: "12",
      y2: "12"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "12",
      y1: "16",
      x2: "12.01",
      y2: "16"
    })),
    CheckCircle2: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
      d: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"
    }), /*#__PURE__*/React.createElement("path", {
      d: "m9 12 2 2 4-4"
    })),
    Link: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
      d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
    })),
    Info: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "10"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "12",
      y1: "16",
      x2: "12",
      y2: "12"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "12",
      y1: "8",
      x2: "12.01",
      y2: "8"
    })),
    Server: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
      x: "2",
      y: "2",
      width: "20",
      height: "8",
      rx: "2",
      ry: "2"
    }), /*#__PURE__*/React.createElement("rect", {
      x: "2",
      y: "14",
      width: "20",
      height: "8",
      rx: "2",
      ry: "2"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "6",
      y1: "6",
      x2: "6.01",
      y2: "6"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "6",
      y1: "18",
      x2: "6.01",
      y2: "18"
    })),
    Clock: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "10"
    }), /*#__PURE__*/React.createElement("polyline", {
      points: "12 6 12 12 16 14"
    })),
    Calendar: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
      x: "3",
      y: "4",
      width: "18",
      height: "18",
      rx: "2",
      ry: "2"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "16",
      y1: "2",
      x2: "16",
      y2: "6"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "8",
      y1: "2",
      x2: "8",
      y2: "6"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "3",
      y1: "10",
      x2: "21",
      y2: "10"
    })),
    Sparkles: /*#__PURE__*/React.createElement("path", {
      d: "M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"
    })
  };
  return /*#__PURE__*/React.createElement("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className: className
  }, icons[name] || /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "10"
  }));
};

// --- ZEITLICH GEORDNETE VORFALLSLISTE ---
// Ersetzt die Karte. Jeder Eintrag zeigt Datum, Ort, Kategorie,
// Schwere, eine kurze Beschreibung sowie die belegende Quelle und einen
// Verifikationsstatus. Die vertikale Zeitleiste macht die zeitliche
// Ordnung unmittelbar sichtbar.
const IncidentTimeline = ({
  incidents
}) => {
  if (incidents.length === 0) return null;
  return /*#__PURE__*/React.createElement("ol", {
    className: "relative ml-3 border-l-2 border-slate-100 space-y-6"
  }, incidents.map((inc, i) => {
    const color = severityColor(inc.severity);
    return /*#__PURE__*/React.createElement("li", {
      key: i,
      className: "ml-6"
    }, /*#__PURE__*/React.createElement("span", {
      className: "absolute -left-[9px] flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-white",
      style: {
        background: color
      },
      "aria-hidden": "true"
    }), /*#__PURE__*/React.createElement("div", {
      className: "rounded-lg border border-slate-100 bg-slate-50 p-4 hover:border-blue-200 transition-colors"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex flex-wrap items-center justify-between gap-2 mb-2"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1.5 text-[11px] font-bold text-slate-500 uppercase tracking-wide"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "Calendar",
      size: 12,
      className: "text-slate-400"
    }), formatDate(inc.date)), /*#__PURE__*/React.createElement("span", {
      className: "text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full",
      style: {
        background: `${color}1a`,
        color
      }
    }, severityLabel(inc.severity))), /*#__PURE__*/React.createElement("h4", {
      className: "text-sm font-bold text-slate-800 leading-snug"
    }, inc.title), /*#__PURE__*/React.createElement("div", {
      className: "text-[11px] text-slate-500 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5"
    }, inc.location && /*#__PURE__*/React.createElement("span", null, inc.location), inc.location && inc.category && /*#__PURE__*/React.createElement("span", {
      className: "text-slate-300"
    }, "\xB7"), inc.category && /*#__PURE__*/React.createElement("span", {
      className: "font-medium text-slate-600"
    }, inc.category)), inc.description && /*#__PURE__*/React.createElement("p", {
      className: "text-xs text-slate-600 mt-2 leading-relaxed"
    }, inc.description), /*#__PURE__*/React.createElement("div", {
      className: "flex flex-wrap items-center gap-2 mt-3"
    }, inc.sourceUrl && /*#__PURE__*/React.createElement("a", {
      href: inc.sourceUrl,
      target: "_blank",
      rel: "noopener noreferrer",
      className: "flex items-center gap-1 text-[10px] font-medium text-slate-600 bg-white px-2 py-1 rounded border border-slate-200 hover:text-blue-600 hover:border-blue-300"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "Link",
      size: 10
    }), /*#__PURE__*/React.createElement("span", {
      className: "truncate max-w-[220px]"
    }, inc.sourceTitle || hostOf(inc.sourceUrl))), inc.verified ? /*#__PURE__*/React.createElement("span", {
      className: "flex items-center gap-1 text-[10px] text-emerald-600 bg-emerald-50 px-2 py-1 rounded"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "CheckCircle2",
      size: 10
    }), " Durch Quelle verifiziert") : /*#__PURE__*/React.createElement("span", {
      className: "flex items-center gap-1 text-[10px] text-amber-600 bg-amber-50 px-2 py-1 rounded"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "Info",
      size: 10
    }), " Ungepr\xFCft"), inc.dateVerified && /*#__PURE__*/React.createElement("span", {
      className: "flex items-center gap-1 text-[10px] text-blue-600 bg-blue-50 px-2 py-1 rounded"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "Calendar",
      size: 10
    }), " Quelldatum: ", formatDate(inc.publishedDate)), inc.dateAdjusted && /*#__PURE__*/React.createElement("span", {
      className: "flex items-center gap-1 text-[10px] text-slate-500 bg-slate-100 px-2 py-1 rounded",
      title: `Ursprünglich gemeldetes Datum: ${formatDate(inc.reportedDate)}`
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "RefreshCw",
      size: 10
    }), " Datum an Quelle angeglichen"))));
  }));
};

// --- TITELSEITE / THEMENEINFÜHRUNG ---
// Cover-Seite, die das Thema vor dem Live-Lagebild einführt. Inhalt und
// Gestaltung folgen der begleitenden Präsentation (dunkles Marineblau,
// goldene Akzente, Serifentitel); die vollständige Präsentation ist als
// PDF verlinkt.
const KEY_FINDINGS = [{
  value: '93',
  text: 'Straftaten wertete das BKA für 2025 als gezielte Sabotage an der deutschen Verkehrsinfrastruktur (2023: 78, 2024: 58).'
}, {
  value: '≥ 11',
  text: 'Kabel wurden seit Oktober 2023 im Ostseeraum beschädigt oder durchtrennt – bei nahezu konstantem Vorgehensmuster.'
}, {
  value: '45.000',
  text: 'Haushalte waren im Januar 2026 im Südwesten Berlins fast eine Woche ohne Strom – der längste Ausfall seit Kriegsende.'
}, {
  value: '17.03.26',
  text: 'trat das KRITIS-Dachgesetz in Kraft – rund 17 Monate nach Ablauf der EU-Umsetzungsfrist.'
}];
const LEITFRAGEN = [{
  n: 1,
  t: 'Akteure',
  d: 'Welche Gruppen greifen an – und mit welchen Motivlagen?'
}, {
  n: 2,
  t: 'Muster',
  d: 'Welche empirischen Muster zeigen Schiene, Luftverkehr, Stromnetz und Seekabel?'
}, {
  n: 3,
  t: 'Länder',
  d: 'Wie unterscheiden sich Deutschland, Baltikum und Polen in Profil und Reaktionsfähigkeit?'
}, {
  n: 4,
  t: 'Regulierung',
  d: 'Welche Gegenmaßnahmen greifen – und wo bestehen belegbare Lücken?'
}];
const IntroCover = ({
  onEnter
}) => {
  const NAVY = '#1e2a56';
  const GOLD = '#e0a83a';
  return /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 overflow-y-auto text-white",
    style: {
      backgroundColor: NAVY
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "min-h-full max-w-6xl mx-auto px-6 md:px-12 py-12 md:py-16 flex flex-col"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] md:text-xs font-bold tracking-[0.2em] uppercase",
    style: {
      color: GOLD
    }
  }, "Bedrohungslage kritischer Infrastrukturen \xB7 EU 2022\u20132026"), /*#__PURE__*/React.createElement("h1", {
    className: "mt-6 font-serif font-bold leading-tight text-4xl md:text-6xl"
  }, "Sabotage gegen Verkehrs- und Energieinfrastrukturen in der EU"), /*#__PURE__*/React.createElement("p", {
    className: "mt-6 text-lg md:text-xl text-slate-300 max-w-3xl"
  }, "Eine evidenzbasierte \xDCbersicht mit Schwerpunkt auf Deutschland, dem Baltikum und Polen"), /*#__PURE__*/React.createElement("div", {
    className: "mt-6 h-1 w-16 rounded",
    style: {
      backgroundColor: GOLD
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "mt-4 text-sm text-slate-400"
  }, "Stand: 18. Juli 2026"), /*#__PURE__*/React.createElement("div", {
    className: "mt-12"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] font-bold tracking-[0.2em] uppercase mb-4",
    style: {
      color: GOLD
    }
  }, "Vier Kernbefunde"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
  }, KEY_FINDINGS.map((k, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "rounded-xl p-5 bg-white/5 border border-white/10"
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-1 w-8 rounded mb-3",
    style: {
      backgroundColor: GOLD
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "font-serif font-bold text-3xl md:text-4xl"
  }, k.value), /*#__PURE__*/React.createElement("p", {
    className: "mt-2 text-[13px] leading-relaxed text-slate-300"
  }, k.text)))), /*#__PURE__*/React.createElement("p", {
    className: "mt-3 text-xs italic text-slate-400"
  }, "Die vier Zahlen stammen aus vier verschiedenen Erhebungssystemen und sind nicht miteinander verrechenbar.")), /*#__PURE__*/React.createElement("div", {
    className: "mt-12"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] font-bold tracking-[0.2em] uppercase mb-4",
    style: {
      color: GOLD
    }
  }, "Leitfragen und Aufbau"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5"
  }, LEITFRAGEN.map(q => /*#__PURE__*/React.createElement("div", {
    key: q.n,
    className: "flex items-start gap-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex-shrink-0 h-9 w-9 rounded-full flex items-center justify-center font-bold text-sm",
    style: {
      backgroundColor: GOLD,
      color: NAVY
    }
  }, q.n), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "font-bold"
  }, q.t), /*#__PURE__*/React.createElement("div", {
    className: "text-[13px] text-slate-300 leading-snug"
  }, q.d)))))), /*#__PURE__*/React.createElement("div", {
    className: "mt-14 flex flex-col sm:flex-row items-stretch sm:items-center gap-3"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onEnter,
    className: "flex items-center justify-center gap-2 px-6 py-3 rounded-lg font-black uppercase tracking-wide text-sm shadow-lg hover:opacity-90 transition-opacity",
    style: {
      backgroundColor: GOLD,
      color: NAVY
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "Activity",
    size: 16
  }), " Zum Live-Lagebild"), /*#__PURE__*/React.createElement("a", {
    href: "/infrastruktur-und-sabotage.pdf",
    target: "_blank",
    rel: "noopener noreferrer",
    className: "flex items-center justify-center gap-2 px-6 py-3 rounded-lg font-bold uppercase tracking-wide text-sm border border-white/25 text-white hover:bg-white/10 transition-colors"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "ExternalLink",
    size: 16
  }), " Vollst\xE4ndige Pr\xE4sentation \xF6ffnen")), /*#__PURE__*/React.createElement("div", {
    className: "mt-auto pt-12 text-xs text-slate-500"
  }, "Dr. Pantaleon Fassbender \xB7 pantaleonfassbender@gmail.com", ' · ', /*#__PURE__*/React.createElement("a", {
    href: "/impressum.html",
    className: "underline hover:text-slate-300"
  }, "Impressum und Datenschutz"))));
};
const App = () => {
  // Der Monitor deckt drei Fokusgebiete in je eigenen Tabs ab. Jeder
  // Tab hält seinen eigenen Lagebericht, Scan- und Fehlerstatus.
  const REGIONS = [{
    id: 'de',
    label: 'Deutschland',
    sub: 'Google News & Tagesschau · deutschsprachig'
  }, {
    id: 'baltics-poland',
    label: 'Baltikum & Polen',
    sub: 'Google News · englischsprachig'
  }, {
    id: 'eu',
    label: 'Restliche EU',
    sub: 'Google News · englischsprachig'
  }];
  const [activeRegion, setActiveRegion] = useState('de');
  // Die Titelseite (Themeneinführung) wird beim Öffnen zuerst gezeigt.
  const [showIntro, setShowIntro] = useState(true);
  const [dataByRegion, setDataByRegion] = useState({});
  const [scanningByRegion, setScanningByRegion] = useState({});
  const [errorByRegion, setErrorByRegion] = useState({});
  const [logs, setLogs] = useState([]);
  const logEndRef = useRef(null);
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({
        behavior: 'smooth'
      });
    }
  }, [logs]);
  const addLog = (msg, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString('de-DE');
    setLogs(prev => [...prev, {
      time: timestamp,
      msg,
      type
    }]);
  };

  // Beim Öffnen für jede Region den zuletzt gecachten Lagebericht laden,
  // damit in jedem Tab sofort der jüngste bekannte Stand sichtbar ist –
  // ohne neuen Modelllauf.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const r of REGIONS) {
        try {
          const res = await fetch(`/api/scan-status?region=${r.id}`);
          if (!res.ok) continue;
          const record = await res.json();
          if (!cancelled && record?.status === 'done' && record.result) {
            setDataByRegion(prev => ({
              ...prev,
              [r.id]: record.result
            }));
            addLog(`Letzter Stand „${r.label}“ geladen (${new Date(record.result.generatedAt).toLocaleString('de-DE')}).`, "info");
          }
        } catch (e) {
          /* Kein Cache vorhanden – stiller Start. */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const runLiveScan = async region => {
    const meta = REGIONS.find(r => r.id === region) || REGIONS[0];
    setScanningByRegion(prev => ({
      ...prev,
      [region]: true
    }));
    setErrorByRegion(prev => ({
      ...prev,
      [region]: null
    }));
    addLog(`Starte OSINT-Scan „${meta.label}“ via Netlify AI Gateway (Google Gemini)...`, "info");
    addLog(`„${meta.label}“: Quellen: ${meta.sub}`, "info");
    try {
      // Die Nachrichten kommen aus echten RSS-Feeds und werden von
      // Gemini nur klassifiziert. Das läuft in Sekunden, daher ein
      // einziger synchroner Aufruf statt Hintergrundjob + Polling.
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          region
        })
      });

      // Die Antwort defensiv lesen: Bei einem Zeitlimit- oder
      // Gateway-Fehler liefert die Plattform eine HTML-Seite statt
      // JSON. Ein direktes response.json() würde daran mit dem
      // kryptischen „Unexpected token '<'" scheitern – deshalb erst
      // den Text lesen und kontrolliert parsen.
      const rawBody = await response.text();
      let payload;
      try {
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch (parseErr) {
        // Ein 504 ist eindeutig: Die Plattform hat die Function wegen
        // Zeitüberschreitung abgebrochen und eine HTML-Seite geschickt.
        // Das mit „AI Gateway noch nicht aktiv" zu vermengen, schickte
        // die Fehlersuche früher in die falsche Richtung — ein fehlendes
        // Gateway liefert schnell einen Baseline-Bericht, keinen 504.
        throw new Error(response.status === 504 ? `Die Auswertung hat das Zeitlimit der Function überschritten (Status 504) und wurde von der ` + `Plattform abgebrochen. Der zuletzt gespeicherte Lagebericht bleibt sichtbar. Tritt das wiederholt auf, ` + `ist der Durchlauf für das Zeitlimit zu umfangreich — Stellschrauben sind SCAN_BUDGET_MS und die Zahl ` + `der ausgewerteten Artikel.` : `Der Analyse-Dienst hat keine gültige JSON-Antwort geliefert (Status ${response.status}). ` + `Bitte den Scan erneut starten. Hinweis: Das AI Gateway ist erst nach mindestens einem ` + `Produktions-Deployment aktiv.`);
      }
      if (!response.ok) {
        throw new Error(payload?.error || `Scan fehlgeschlagen (Status ${response.status}).`);
      }
      const result = payload;
      const incidents = Array.isArray(result.incidents) ? result.incidents : [];
      const verifiedCount = incidents.filter(i => i.verified).length;
      addLog(`„${meta.label}“: Analyse abgeschlossen (Engine: ${result.model}).`, "success");
      addLog(`„${meta.label}“: ${(result.sources || []).length} Artikel ausgewertet.`, "info");
      addLog(`„${meta.label}“: ${incidents.length} Vorfall/Vorfälle erkannt, ${verifiedCount} durch Quellen verifiziert.`, "success");
      if (result.dateAdjustments > 0) {
        addLog(`„${meta.label}“: ${result.dateAdjustments} Vorfallsdatum/-daten an das echte Veröffentlichungsdatum der Quelle angeglichen.`, "info");
      }
      if (result.staleRemoved > 0) {
        addLog(`„${meta.label}“: ${result.staleRemoved} wieder hochgespülte Altmeldung(en) außerhalb des 30-Tage-Fensters verworfen.`, "warning");
      }
      if (result.degraded) {
        const hasSources = (result.sources || []).length > 0;
        addLog(`„${meta.label}“: ${hasSources ? 'KI-Auswertung nicht möglich (Zeitlimit oder Gateway) – Baseline-Lagebericht auf Basis der abgerufenen Quellen.' : 'Die Nachrichten-Feeds waren nicht erreichbar – Baseline-Lagebericht ohne aktuelle Quellen.'}`, "warning");
      }
      setDataByRegion(prev => ({
        ...prev,
        [region]: result
      }));
    } catch (err) {
      console.error(err);
      const msg = err.message || "Unbekannter Fehler.";
      setErrorByRegion(prev => ({
        ...prev,
        [region]: msg
      }));
      addLog(`„${meta.label}“: ${msg}`, "error");
    }
    setScanningByRegion(prev => ({
      ...prev,
      [region]: false
    }));
  };
  const getScoreColor = score => {
    if (score > 75) return 'text-red-600';
    if (score > 45) return 'text-amber-500';
    return 'text-emerald-600';
  };
  const activeMeta = REGIONS.find(r => r.id === activeRegion) || REGIONS[0];
  const intelData = dataByRegion[activeRegion] || null;
  const isScanning = !!scanningByRegion[activeRegion];
  const error = errorByRegion[activeRegion] || null;
  const incidents = intelData?.incidents || [];
  const orderedIncidents = sortByDateDesc(incidents);
  const sources = intelData?.sources || [];

  // Vor dem Live-Lagebild zuerst die Themeneinführung anzeigen.
  if (showIntro) {
    return /*#__PURE__*/React.createElement(IntroCover, {
      onEnter: () => setShowIntro(false)
    });
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "min-h-screen bg-slate-50 text-slate-900 font-sans flex flex-col h-screen"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col md:flex-row flex-1 overflow-hidden"
  }, /*#__PURE__*/React.createElement("aside", {
    className: "w-full md:w-64 bg-white border-b md:border-r border-slate-200 flex flex-col shrink-0 z-20"
  }, /*#__PURE__*/React.createElement("div", {
    className: "p-6 border-b border-slate-100"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 text-blue-600 mb-1"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "Shield",
    size: 24
  }), /*#__PURE__*/React.createElement("span", {
    className: "font-black text-lg tracking-tighter uppercase"
  }, "Infrastruktur")), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-8"
  }, "Radar Deutschland")), /*#__PURE__*/React.createElement("div", {
    className: "p-4 space-y-4 flex-grow overflow-y-auto"
  }, /*#__PURE__*/React.createElement("div", {
    className: "p-4 bg-slate-100 rounded-lg"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 mb-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: `h-2 w-2 rounded-full ${isScanning ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`
  }), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-bold text-slate-500 uppercase"
  }, "System Status")), /*#__PURE__*/React.createElement("p", {
    className: "text-xs font-medium text-slate-600"
  }, isScanning ? "Suche läuft..." : "Bereit (Netlify Gateway)"), /*#__PURE__*/React.createElement("p", {
    className: "text-[9px] text-slate-400 mt-1 flex items-center gap-1"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "Sparkles",
    size: 10
  }), " Engine: ", intelData?.model || 'Google Gemini')), /*#__PURE__*/React.createElement("div", {
    className: "p-4 bg-slate-100 rounded-lg"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] font-bold text-slate-500 uppercase mb-2"
  }, "Schweregrad"), /*#__PURE__*/React.createElement("div", {
    className: "space-y-1.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 text-[11px] text-slate-600"
  }, /*#__PURE__*/React.createElement("span", {
    className: "h-2.5 w-2.5 rounded-full",
    style: {
      background: '#dc2626'
    }
  }), " Hohe Schwere"), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 text-[11px] text-slate-600"
  }, /*#__PURE__*/React.createElement("span", {
    className: "h-2.5 w-2.5 rounded-full",
    style: {
      background: '#f59e0b'
    }
  }), " Mittlere Schwere"), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 text-[11px] text-slate-600"
  }, /*#__PURE__*/React.createElement("span", {
    className: "h-2.5 w-2.5 rounded-full",
    style: {
      background: '#10b981'
    }
  }), " Niedrige Schwere"))), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 text-slate-300 p-3 rounded-lg text-[9px] font-mono h-48 overflow-y-auto shadow-inner"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mb-2 font-bold text-slate-500 uppercase sticky top-0 bg-slate-900 pb-1 border-b border-slate-800"
  }, "System Log"), logs.length === 0 && /*#__PURE__*/React.createElement("span", {
    className: "opacity-50 italic"
  }, "Warte auf Start..."), logs.map((log, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: `mb-1 ${log.type === 'error' ? 'text-red-400' : log.type === 'success' ? 'text-emerald-400' : log.type === 'warning' ? 'text-amber-400' : 'text-slate-300'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "opacity-50"
  }, "[", log.time, "]"), " ", log.msg)), /*#__PURE__*/React.createElement("div", {
    ref: logEndRef
  }))), /*#__PURE__*/React.createElement("div", {
    className: "p-4 border-t border-slate-100"
  }, /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-slate-500 leading-tight"
  }, "(C) 2026 - Dr. Pantaleon Fassbender - pantaleonfassbender@gmail.com"), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-slate-500 leading-tight mt-1"
  }, /*#__PURE__*/React.createElement("a", {
    href: "/impressum.html",
    className: "underline hover:text-slate-700"
  }, "Impressum und Datenschutz")))), /*#__PURE__*/React.createElement("main", {
    className: "flex-1 flex flex-col overflow-hidden bg-slate-50"
  }, /*#__PURE__*/React.createElement("header", {
    className: "px-8 py-6 bg-white border-b border-slate-200 flex justify-between items-center shrink-0 shadow-sm"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    className: "text-xl font-black uppercase text-slate-800 tracking-tight"
  }, "Echtzeit Lagebild (OSINT)"), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2 mt-1"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "Globe",
    size: 12
  }), " ", activeMeta.label, " \xB7 ", activeMeta.sub)), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowIntro(true),
    className: "hidden sm:flex items-center gap-2 px-4 py-2.5 text-slate-700 bg-slate-100 rounded-lg text-[11px] font-bold uppercase tracking-wide hover:bg-slate-200 transition-all"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "Info",
    size: 14
  }), " Themeneinf\xFChrung"), /*#__PURE__*/React.createElement("button", {
    onClick: () => runLiveScan(activeRegion),
    disabled: isScanning,
    className: `flex items-center gap-2 px-5 py-2.5 text-white rounded-lg text-[11px] font-black uppercase tracking-wide transition-all shadow-md ${isScanning ? 'bg-slate-400 cursor-not-allowed' : 'bg-slate-900 hover:opacity-90'}`
  }, isScanning ? /*#__PURE__*/React.createElement(Icon, {
    name: "RefreshCw",
    size: 14,
    className: "animate-spin"
  }) : /*#__PURE__*/React.createElement(Icon, {
    name: "Search",
    size: 14
  }), isScanning ? 'Suche...' : 'Scan Aktualisieren'))), /*#__PURE__*/React.createElement("nav", {
    className: "bg-white border-b border-slate-200 px-8 flex gap-1 shrink-0 overflow-x-auto"
  }, REGIONS.map(r => {
    const isActive = r.id === activeRegion;
    const busy = !!scanningByRegion[r.id];
    const data = dataByRegion[r.id];
    return /*#__PURE__*/React.createElement("button", {
      key: r.id,
      onClick: () => setActiveRegion(r.id),
      className: `relative px-4 py-3 text-[11px] font-black uppercase tracking-wide border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 ${isActive ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-400 hover:text-slate-600'}`
    }, busy && /*#__PURE__*/React.createElement(Icon, {
      name: "RefreshCw",
      size: 11,
      className: "animate-spin"
    }), r.label, data && typeof data.score === 'number' && /*#__PURE__*/React.createElement("span", {
      className: `text-[9px] font-black px-1.5 py-0.5 rounded-full bg-slate-100 ${getScoreColor(data.score)}`
    }, data.score));
  })), /*#__PURE__*/React.createElement("div", {
    className: "flex-1 overflow-y-auto p-6 md:p-8"
  }, error && /*#__PURE__*/React.createElement("div", {
    className: "mb-6 max-w-4xl mx-auto p-6 bg-red-100 border-2 border-red-200 rounded-xl text-red-700 flex flex-col gap-3 shadow-sm"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3 font-bold text-lg"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "AlertCircle",
    size: 24
  }), "System-Meldung"), /*#__PURE__*/React.createElement("div", {
    className: "text-sm font-medium"
  }, error), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-red-600/80"
  }, "Tipp: Die Analyse liest Live-Nachrichten aus Google News und der Tagesschau und l\xE4sst sie von Gemini auswerten. Bitte den Scan erneut starten. (Das AI Gateway ist erst nach mindestens einem Produktions-Deployment aktiv.)")), /*#__PURE__*/React.createElement("div", {
    className: "max-w-4xl mx-auto space-y-6"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-white rounded-xl border border-slate-200 p-6 shadow-sm"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col md:flex-row items-center gap-6"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex-shrink-0"
  }, /*#__PURE__*/React.createElement("div", {
    className: `p-4 rounded-full bg-slate-50 ${isScanning ? 'animate-pulse' : ''}`
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "Activity",
    size: 32,
    className: getScoreColor(intelData?.score || 0)
  }))), /*#__PURE__*/React.createElement("div", {
    className: "flex-grow text-center md:text-left"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-bold text-slate-500 uppercase tracking-widest mb-1"
  }, "Echtzeit Risiko-Index"), isScanning ? /*#__PURE__*/React.createElement("div", {
    className: "h-10 w-48 bg-slate-100 rounded animate-pulse"
  }) : /*#__PURE__*/React.createElement("div", {
    className: "flex items-baseline justify-center md:justify-start gap-3"
  }, /*#__PURE__*/React.createElement("span", {
    className: `text-5xl font-black ${getScoreColor(intelData?.score || 0)}`
  }, intelData?.score ?? '--', " / 100"), /*#__PURE__*/React.createElement("span", {
    className: "text-sm font-medium text-slate-400"
  }, intelData?.level || (intelData?.score > 70 ? 'KRITISCH' : intelData?.score > 40 ? 'LATENT' : 'RUHIG'))))), /*#__PURE__*/React.createElement("div", {
    className: "mt-6 pt-6 border-t border-slate-100"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-start gap-3"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "Server",
    size: 16,
    className: "text-blue-500 mt-0.5 shrink-0"
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h4", {
    className: "text-[11px] font-black uppercase text-slate-700 mb-1"
  }, "Score-Berechnung"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-3 gap-2 mt-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-50 p-2 rounded border border-slate-100"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] font-bold text-emerald-600"
  }, "35-45 Pkt"), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] text-slate-400"
  }, "Baseline (Latenz)")), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-50 p-2 rounded border border-slate-100"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] font-bold text-amber-500"
  }, "50-70 Pkt"), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] text-slate-400"
  }, "Neue Warnhinweise")), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-50 p-2 rounded border border-slate-100"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] font-bold text-red-600"
  }, "75+ Pkt"), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] text-slate-400"
  }, "Akuter Angriff"))))))), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-800 p-8 min-h-[220px] relative shadow-xl"
  }, /*#__PURE__*/React.createElement("div", {
    className: "absolute top-4 right-4 opacity-20"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "Terminal",
    size: 24,
    className: "text-slate-400"
  })), /*#__PURE__*/React.createElement("div", {
    className: "mb-6 pb-4 border-b border-white/10"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "font-bold text-white text-lg"
  }, "Lagebericht (30 Tage)"), /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-slate-400 mt-1"
  }, "KI-Synthese (Gemini) aus verifizierten Quellen.")), isScanning ? /*#__PURE__*/React.createElement("div", {
    className: "space-y-4 animate-pulse py-10"
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-4 bg-white/10 rounded w-3/4"
  }), /*#__PURE__*/React.createElement("div", {
    className: "h-4 bg-white/10 rounded w-1/2"
  }), /*#__PURE__*/React.createElement("div", {
    className: "pt-8 text-center text-xs text-slate-500 font-mono"
  }, "Recherche & Validierung l\xE4uft...")) : intelData ? /*#__PURE__*/React.createElement("div", {
    className: "prose prose-invert prose-sm max-w-none text-slate-300 leading-relaxed whitespace-pre-wrap font-sans"
  }, intelData.summary) : /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col items-center justify-center h-48 text-slate-500 italic"
  }, "Bitte Scan starten.")), /*#__PURE__*/React.createElement("div", {
    className: "bg-white rounded-xl border border-slate-200 p-6 shadow-sm"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between gap-2 mb-5 pb-2 border-b border-slate-100"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "Clock",
    size: 16,
    className: "text-blue-600"
  }), /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-black text-slate-500 uppercase tracking-widest"
  }, "Chronologische Vorfallsliste")), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-bold text-slate-400 uppercase"
  }, orderedIncidents.length, " ", orderedIncidents.length === 1 ? 'Vorfall' : 'Vorfälle')), isScanning ? /*#__PURE__*/React.createElement("div", {
    className: "space-y-3"
  }, [1, 2, 3].map(i => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "h-24 bg-slate-100 rounded-lg animate-pulse"
  }))) : orderedIncidents.length > 0 ? /*#__PURE__*/React.createElement(IncidentTimeline, {
    incidents: orderedIncidents
  }) : (
  /*
    Eine leere Liste hat zwei völlig
    verschiedene Ursachen, und sie zu
    vermengen war der teuerste Fehler dieser
    Oberfläche: Entweder hat das Modell
    ausgewertet und nichts Belegtes gefunden —
    oder es hat gar nicht geantwortet. Der
    Server weiß das (degraded), also wird es
    hier auch gesagt.
  */
  intelData && intelData.degraded ? /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-center py-10 bg-amber-50 rounded-lg border border-dashed border-amber-300 text-amber-800 px-6"
  }, /*#__PURE__*/React.createElement("div", {
    className: "font-black uppercase tracking-wide mb-1"
  }, "Auswertung nicht zustande gekommen"), /*#__PURE__*/React.createElement("p", {
    className: "leading-relaxed"
  }, "Die Vorfallsliste ist leer, weil die KI-Auswertung in diesem Durchlauf nicht gelaufen ist \u2014 nicht, weil es nichts zu berichten g\xE4be. Der Score ist deshalb nur die Baseline."), intelData.degradedReason && /*#__PURE__*/React.createElement("p", {
    className: "mt-2 font-mono text-[10px] text-amber-700 break-words"
  }, intelData.degradedReason), /*#__PURE__*/React.createElement("p", {
    className: "mt-2 text-amber-700"
  }, (intelData.sources || []).length, " Artikel wurden abgerufen und stehen unten als Quellen \u2014 nur eingeordnet wurden sie nicht.")) : /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-400 text-center py-10 bg-slate-50 rounded-lg border border-dashed border-slate-200"
  }, intelData ? "Keine akuten, durch Quellen belegten Vorfälle in den letzten 30 Tagen. Der Score basiert auf der Baseline-Bedrohungslage." : "Warte auf Scan..."))), sources.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "bg-white rounded-xl border border-slate-200 p-6 shadow-sm"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 mb-4 pb-2 border-b border-slate-100"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "Globe",
    size: 16,
    className: "text-blue-600"
  }), /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-black text-slate-500 uppercase tracking-widest"
  }, "Recherchierte Quellen (", sources.length, ")")), /*#__PURE__*/React.createElement("div", {
    className: "space-y-2 max-h-[280px] overflow-y-auto pr-2"
  }, sources.map((s, i) => /*#__PURE__*/React.createElement("a", {
    key: i,
    href: s.url,
    target: "_blank",
    rel: "noopener noreferrer",
    className: "flex items-center gap-2 text-[11px] text-slate-600 hover:text-blue-600 group"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "ExternalLink",
    size: 11,
    className: "text-slate-300 group-hover:text-blue-500 shrink-0"
  }), /*#__PURE__*/React.createElement("span", {
    className: "truncate"
  }, s.title))))))))));
};
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(/*#__PURE__*/React.createElement(App, null));
