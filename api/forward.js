import fs from "fs";
import path from "path";
import pointOnFeature from "@turf/point-on-feature";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import bbox from "@turf/bbox";
import { point } from "@turf/helpers";
import RBush from "rbush";

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

function normalize(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Caches: Point-/Polygon-Features (mit vorab normalisiertem Namen)
// + RBush-Index über die Polygon-BBoxen für schnelle Bundesland-Lookups
let pointFeatures = null;
let polygonFeatures = null;
let polygonIndex = null;
let polygonItems = null;

function loadData() {
  if (pointFeatures && polygonFeatures) {
    return { pointFeatures, polygonFeatures, polygonIndex, polygonItems };
  }

  const filePath = path.join(process.cwd(), "data", "deutschland.geojson");
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);

  pointFeatures = parsed.features
    .filter(
      (f) => f.geometry && f.geometry.type === "Point" && f.properties?.name
    )
    // normalisierten Namen einmalig berechnen statt bei jedem Request
    .map((f) => {
      f._normalizedName = normalize(f.properties.name);
      return f;
    });

  polygonFeatures = parsed.features
    .filter(
      (f) =>
        f.geometry &&
        (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") &&
        f.properties?.name
    )
    .map((f) => {
      f._normalizedName = normalize(f.properties.name);
      return f;
    });

  // RBush-Index für schnelle Point-in-Polygon-Kandidatensuche
  polygonItems = polygonFeatures.map((feature) => {
    const [minX, minY, maxX, maxY] = bbox(feature);
    return { minX, minY, maxX, maxY, feature };
  });
  polygonIndex = new RBush();
  polygonIndex.load(polygonItems);

  return { pointFeatures, polygonFeatures, polygonIndex, polygonItems };
}

function findMatches(features, normalizedQuery) {
  // Nutzt jetzt f._normalizedName (vorberechnet) statt normalize(f.properties.name)
  let matches = features.filter((f) => f._normalizedName === normalizedQuery);
  if (matches.length === 0) {
    matches = features.filter((f) =>
      f._normalizedName.startsWith(normalizedQuery)
    );
  }
  if (matches.length === 0) {
    matches = features.filter((f) =>
      f._normalizedName.includes(normalizedQuery)
    );
  }
  return matches;
}

// Nutzt den RBush-Index statt linear über alle Polygone zu iterieren
function findBundeslandForPoint(lon, lat, polygonIndex) {
  const targetPoint = point([lon, lat]);
  const candidates = polygonIndex.search({
    minX: lon,
    minY: lat,
    maxX: lon,
    maxY: lat,
  });
  for (const candidate of candidates) {
    if (booleanPointInPolygon(targetPoint, candidate.feature)) {
      return BUNDESLAND_MAP[candidate.feature.properties.SN_L] ?? null;
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
    const { pointFeatures, polygonFeatures, polygonIndex } = loadData();
    const normalizedQuery = normalize(query.trim());

    let pointMatches = findMatches(pointFeatures, normalizedQuery);
    pointMatches.sort((a, b) => {
      const rankDiff = placeRank(b.properties) - placeRank(a.properties);
      if (rankDiff !== 0) return rankDiff;
      return populationOf(b.properties) - populationOf(a.properties);
    });

    const matchedNames = new Set(pointMatches.map((f) => f._normalizedName));
    const polygonMatches = findMatches(polygonFeatures, normalizedQuery).filter(
      (f) => !matchedNames.has(f._normalizedName)
    );

    if (pointMatches.length === 0 && polygonMatches.length === 0) {
      return res.status(404).json({ error: "Kein Ort gefunden.", query });
    }

    const results = [];

    for (const feature of pointMatches) {
      const [lon, lat] = feature.geometry.coordinates;
      const bundesland =
        BUNDESLAND_MAP[feature.properties.SN_L] ??
        findBundeslandForPoint(lon, lat, polygonIndex);

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