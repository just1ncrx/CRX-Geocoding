import fs from "fs";
import path from "path";
import centroid from "@turf/centroid";

const BUNDESLAND_MAP = {
  "01": "Schleswig-Holstein",
  "02": "Hamburg",
  "03": "Niedersachsen",
  "04": "Bremen",
  "05": "Nordrhein-Westfalen",
  "06": "Hessen",
  "07": "Rheinland-Pfalz",
  "08": "Baden-Württemberg",
  "09": "Bayern",
  "10": "Saarland",
  "11": "Berlin",
  "12": "Brandenburg",
  "13": "Mecklenburg-Vorpommern",
  "14": "Sachsen",
  "15": "Sachsen-Anhalt",
  "16": "Thüringen",
};

let germanyFeatures = null;

function loadData() {
  if (germanyFeatures) return germanyFeatures;

  const filePath = path.join(process.cwd(), "data", "deutschland.geojson");
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);

  germanyFeatures = parsed.features.filter(
    (f) =>
      f.geometry &&
      (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") &&
      f.properties &&
      f.properties.name
  );

  return germanyFeatures;
}

function normalize(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // Umlaute/Akzente für Vergleich entfernen
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { q, name, limit } = req.query;
  const query = q ?? name;
  const maxResults = Math.min(parseInt(limit) || 5, 20);

  if (!query || query.trim().length === 0) {
    return res.status(400).json({
      error: "Query-Parameter 'q' (oder 'name') wird benötigt.",
    });
  }

  try {
    const features = loadData();
    const normalizedQuery = normalize(query.trim());

    // 1. Exakte Treffer (normalisiert)
    let matches = features.filter(
      (f) => normalize(f.properties.name) === normalizedQuery
    );

    // 2. Falls kein exakter Treffer: "beginnt mit"
    if (matches.length === 0) {
      matches = features.filter((f) =>
        normalize(f.properties.name).startsWith(normalizedQuery)
      );
    }

    // 3. Falls immer noch nichts: "enthält"
    if (matches.length === 0) {
      matches = features.filter((f) =>
        normalize(f.properties.name).includes(normalizedQuery)
      );
    }

    if (matches.length === 0) {
      return res.status(404).json({ error: "Kein Ort gefunden.", query });
    }

    const results = matches.slice(0, maxResults).map((feature) => {
      const c = centroid(feature);
      const [lon, lat] = c.geometry.coordinates;
      const bundesland = BUNDESLAND_MAP[feature.properties.SN_L] ?? null;

      return {
        name: feature.properties.name,
        lat,
        lon,
        bundesland,
      };
    });

    return res.status(200).json(results);
  } catch (err) {
    console.error("Forward-Geocoding-Fehler:", err);
    return res.status(500).json({ error: "Interner Serverfehler." });
  }
}
