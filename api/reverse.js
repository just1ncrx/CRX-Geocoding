import fs from "fs";
import path from "path";
import { point } from "@turf/helpers";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import RBush from "rbush";

const BUNDESLAND_MAP = {
  "01": "Schleswig-Holstein", "02": "Hamburg", "03": "Niedersachsen",
  "04": "Bremen", "05": "Nordrhein-Westfalen", "06": "Hessen",
  "07": "Rheinland-Pfalz", "08": "Baden-Württemberg", "09": "Bayern",
  "10": "Saarland", "11": "Berlin", "12": "Brandenburg",
  "13": "Mecklenburg-Vorpommern", "14": "Sachsen", "15": "Sachsen-Anhalt",
  "16": "Thüringen",
};

let polygonIndex = null;

const CACHE_MAX_ENTRIES = 5000;
const resultCache = new Map();

function cacheKey(lat, lon) {
  return lat.toFixed(3) + "," + lon.toFixed(3);
}
function cacheGet(key) {
  if (!resultCache.has(key)) return undefined;
  const value = resultCache.get(key);
  resultCache.delete(key);
  resultCache.set(key, value);
  return value;
}
function cacheSet(key, value) {
  if (resultCache.size >= CACHE_MAX_ENTRIES) {
    resultCache.delete(resultCache.keys().next().value);
  }
  resultCache.set(key, value);
}

function loadData() {
  if (polygonIndex) return { polygonIndex };

  // Liest jetzt die vorberechnete, schlanke Indexdatei statt Rohdaten zu parsen
  const filePath = path.join(process.cwd(), "data", "deutschland.index.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  const { items } = JSON.parse(raw);

  polygonIndex = new RBush();
  polygonIndex.load(items); // items enthalten schon minX/minY/maxX/maxY

  return { polygonIndex };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { lat, lon, lng } = req.query;
  const longitude = lon ?? lng;
  if (lat === undefined || longitude === undefined) {
    return res.status(400).json({
      error: "Query-Parameter 'lat' und 'lon' (oder 'lng') werden benötigt.",
    });
  }

  const latitude = parseFloat(lat);
  const longitudeNum = parseFloat(longitude);
  if (Number.isNaN(latitude) || Number.isNaN(longitudeNum)) {
    return res.status(400).json({ error: "lat/lon müssen gültige Zahlen sein." });
  }
  if (latitude < -90 || latitude > 90 || longitudeNum < -180 || longitudeNum > 180) {
    return res.status(400).json({ error: "lat/lon außerhalb des gültigen Bereichs." });
  }

  const key = cacheKey(latitude, longitudeNum);
  const cached = cacheGet(key);
  if (cached) {
    return res.status(200).json(cached);
  }

  try {
    const { polygonIndex } = loadData();
    const targetPoint = point([longitudeNum, latitude]);

    const candidates = polygonIndex.search({
      minX: longitudeNum,
      minY: latitude,
      maxX: longitudeNum,
      maxY: latitude,
    });

    let match = null;
    for (const candidate of candidates) {
      if (booleanPointInPolygon(targetPoint, candidate.feature)) {
        match = candidate.feature;
        break;
      }
    }

    if (!match) {
      return res.status(404).json({ error: "Kein Treffer gefunden." });
    }

    const p = match.properties;
    const bundesland = BUNDESLAND_MAP[p.SN_L] ?? null;

    const responseBody = {
      lat: latitude,
      lon: longitudeNum,
      name: p.name ?? null,
      bundesland,
    };

    cacheSet(key, responseBody);
    return res.status(200).json(responseBody);
  } catch (err) {
    console.error("Reverse-Geocoding-Fehler:", err);
    return res.status(500).json({ error: "Interner Serverfehler." });
  }
}
