import fs from "fs";
import path from "path";
import { point, featureCollection } from "@turf/helpers";
import nearestPoint from "@turf/nearest-point";

let germanyFC = null;

function loadData() {
  if (germanyFC) return germanyFC;

  const filePath = path.join(process.cwd(), "data", "deutschland.geojson");
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);

  // Nur Point-Features behalten, falls die Datei auch andere Geometrien enthält
  const points = parsed.features.filter(
    (f) => f.geometry && f.geometry.type === "Point"
  );

  germanyFC = featureCollection(points);
  return germanyFC;
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

  try {
    const fc = loadData();
    const targetPoint = point([longitudeNum, latitude]);

    const nearest = nearestPoint(targetPoint, fc);

    if (!nearest) {
      return res.status(404).json({ error: "Kein Treffer gefunden." });
    }

    const distanceKm = nearest.properties.distanceToPoint; // von turf gesetzt

    return res.status(200).json({
      query: { lat: latitude, lon: longitudeNum },
      result: {
        name: nearest.properties.name ?? null,
        place: nearest.properties.place ?? null,
        postal_code: nearest.properties.postal_code ?? null,
        population: nearest.properties.population ?? null,
        wikidata: nearest.properties.wikidata ?? null,
        wikipedia: nearest.properties.wikipedia ?? null,
        coordinates: nearest.geometry.coordinates,
        distance_km: distanceKm,
      },
      raw: nearest,
    });
  } catch (err) {
    console.error("Reverse-Geocoding-Fehler:", err);
    return res.status(500).json({ error: "Interner Serverfehler." });
  }
}
