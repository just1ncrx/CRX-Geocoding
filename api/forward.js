import fs from "fs";
import path from "path";
import pointOnFeature from "@turf/point-on-feature";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";

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

// Wichtigkeit von OSM "place"-Tags, um bei mehreren gleichnamigen Treffern
// den richtigen (z.B. die Großstadt statt einen Weiler) zu bevorzugen.
const PLACE_RANK = {
  city: 7,
  town: 6,
  municipality: 5,
  borough: 4,
  suburb: 3,
  village: 2,
  hamlet: 1,
  isolated_dwelling: 0,
};

function placeRank(props) {
  return PLACE_RANK[props?.place] ?? 0;
}

function populationOf(props) {
  const n = parseInt(props?.population);
  return Number.isNaN(n) ? 0 : n;
}

// Getrennte Caches für Points (echte Ortsmittelpunkte) und Polygone (Gemeindegrenzen)
let pointFeatures = null;
let polygonFeatures = null;

function loadData() {
  if (pointFeatures && polygonFeatures) {
    return { pointFeatures, polygonFeatures };
  }

  const filePath = path.join(process.cwd(), "data", "deutschland.geojson");
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);

  pointFeatures = parsed.features.filter(
    (f) => f.geometry && f.geometry.type === "Point" && f.properties?.name
  );

  polygonFeatures = parsed.features.filter(
    (f) =>
      f.geometry &&
      (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") &&
      f.properties?.name
  );

  return { pointFeatures, polygonFeatures };
}

function normalize(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // Umlaute/Akzente für Vergleich entfernen
}

function findMatches(features, normalizedQuery) {
  // 1. Exakte Treffer (normalisiert)
  let matches = features.filter(
    (f) => normalize(f.properties.name) === normalizedQuery
  );
  // 2. "beginnt mit"
  if (matches.length === 0) {
    matches = features.filter((f) =>
      normalize(f.properties.name).startsWith(normalizedQuery)
    );
  }
  // 3. "enthält"
  if (matches.length === 0) {
    matches = features.filter((f) =>
      normalize(f.properties.name).includes(normalizedQuery)
    );
  }
  return matches;
}

// Findet das Bundesland eines Punkts per Point-in-Polygon-Check gegen die
// Gemeindegrenzen (nötig, da OSM-Punkte i.d.R. kein SN_L-Feld besitzen).
function findBundeslandForPoint(lon, lat, polygonFeatures) {
  const targetPoint = point([lon, lat]);
  for (const feature of polygonFeatures) {
    if (booleanPointInPolygon(targetPoint, feature)) {
      return BUNDESLAND_MAP[feature.properties.SN_L] ?? null;
    }
  }
  return null;
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
    const { pointFeatures, polygonFeatures } = loadData();
    const normalizedQuery = normalize(query.trim());

    // Point-Treffer finden und nach Wichtigkeit sortieren
    // (place-Typ zuerst, dann Einwohnerzahl - damit "Berlin" die Hauptstadt
    // liefert und nicht einen gleichnamigen Weiler)
    let pointMatches = findMatches(pointFeatures, normalizedQuery);
    pointMatches.sort((a, b) => {
      const rankDiff = placeRank(b.properties) - placeRank(a.properties);
      if (rankDiff !== 0) return rankDiff;
      return populationOf(b.properties) - populationOf(a.properties);
    });


    const matchedNames = new Set(
      pointMatches.map((f) => normalize(f.properties.name))
    );
    const polygonMatches = findMatches(polygonFeatures, normalizedQuery).filter(
      (f) => !matchedNames.has(normalize(f.properties.name))
    );

    if (pointMatches.length === 0 && polygonMatches.length === 0) {
      return res.status(404).json({ error: "Kein Ort gefunden.", query });
    }

    const results = [];

    // Point-Treffer übernehmen (bereits der "echte" Mittelpunkt)
    for (const feature of pointMatches) {
      const [lon, lat] = feature.geometry.coordinates;
      const bundesland =
        BUNDESLAND_MAP[feature.properties.SN_L] ??
        findBundeslandForPoint(lon, lat, polygonFeatures);

      results.push({
        name: feature.properties.name,
        lat,
        lon,
        latitude: lat,
        longitude: lon,
        admin1: bundesland,
        bundesland,
        country: "Deutschland",
        country_code: "de",
        population: populationOf(feature.properties),
        place: feature.properties.place ?? null,
        source: "point",
      });
    }

    // Polygon-Treffer: Punkt innerhalb der Fläche berechnen (statt reinem Zentroid)
    for (const feature of polygonMatches) {
      const p = pointOnFeature(feature);
      const [lon, lat] = p.geometry.coordinates;
      const bundesland = BUNDESLAND_MAP[feature.properties.SN_L] ?? null;

      results.push({
        name: feature.properties.name,
        lat,
        lon,
        latitude: lat,
        longitude: lon,
        admin1: bundesland,
        bundesland,
        country: "Deutschland",
        country_code: "de",
        population: 0,
        place: null,
        source: "polygon",
      });
    }

    return res.status(200).json(results.slice(0, maxResults));
  } catch (err) {
    console.error("Forward-Geocoding-Fehler:", err);
    return res.status(500).json({ error: "Interner Serverfehler." });
  }
}
