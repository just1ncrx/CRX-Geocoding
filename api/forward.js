// api/geocode.js
//
// Voraussetzung: einmal lokal ausführen
//   node scripts/build-search-index.mjs
// erzeugt data/search-index.json, das diese Datei lädt.
//
// Kein turf, kein RBush, keine Geometrie-Verarbeitung mehr zur Laufzeit -
// dadurch ist auch der Cold Start deutlich schneller als vorher.

import fs from "fs";
import path from "path";

let exactMap = null;    // normalizedName -> entry[]
let sortedEntries = null; // bereits sortiert aus dem Build-Script

function loadData() {
  if (exactMap && sortedEntries) {
    return { exactMap, sortedEntries };
  }

  const filePath = path.join(process.cwd(), "data", "search-index.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  sortedEntries = JSON.parse(raw); // bereits sortiert, kein .sort() nötig

  exactMap = new Map();
  for (const entry of sortedEntries) {
    if (!exactMap.has(entry.normalizedName)) {
      exactMap.set(entry.normalizedName, []);
    }
    exactMap.get(entry.normalizedName).push(entry);
  }

  return { exactMap, sortedEntries };
}

function normalize(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Findet den ersten Index, ab dem entry.normalizedName >= prefix
function lowerBound(arr, prefix) {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].normalizedName < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function prefixSearch(sortedEntries, prefix) {
  const start = lowerBound(sortedEntries, prefix);
  const results = [];
  for (let i = start; i < sortedEntries.length; i++) {
    if (!sortedEntries[i].normalizedName.startsWith(prefix)) break;
    results.push(sortedEntries[i]);
  }
  return results;
}

function findMatches(normalizedQuery, exactMap, sortedEntries) {
  const exact = exactMap.get(normalizedQuery);
  if (exact && exact.length > 0) return exact;

  const prefixMatches = prefixSearch(sortedEntries, normalizedQuery);
  if (prefixMatches.length > 0) return prefixMatches;

  // Fallback: Substring-Suche, nur wenn nötig (selten der Fall)
  return sortedEntries.filter((e) =>
    e.normalizedName.includes(normalizedQuery)
  );
}

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

function placeRank(entry) {
  return PLACE_RANK[entry.place] ?? 0;
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
    const { exactMap, sortedEntries } = loadData();
    const normalizedQuery = normalize(query.trim());

    const matches = findMatches(normalizedQuery, exactMap, sortedEntries);

    if (matches.length === 0) {
      return res.status(404).json({ error: "Kein Ort gefunden.", query });
    }

    // Punkte vor Polygonen, dann nach Place-Rang, dann nach Bevölkerung
    matches.sort((a, b) => {
      if (a.source !== b.source) {
        return a.source === "point" ? -1 : 1;
      }
      const rankDiff = placeRank(b) - placeRank(a);
      if (rankDiff !== 0) return rankDiff;
      return b.population - a.population;
    });

    const results = matches.slice(0, maxResults).map((entry) => ({
      name: entry.name,
      lat: entry.lat,
      lon: entry.lon,
      latitude: entry.lat,
      longitude: entry.lon,
      admin1: entry.bundesland,
      bundesland: entry.bundesland,
      country: "Deutschland",
      country_code: "de",
      population: entry.population,
      place: entry.place,
      source: entry.source,
    }));

    return res.status(200).json(results);
  } catch (err) {
    console.error("Forward-Geocoding-Fehler:", err);
    return res.status(500).json({ error: "Interner Serverfehler." });
  }
}
