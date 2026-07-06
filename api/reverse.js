import fs from "fs";
import path from "path";
import { point } from "@turf/helpers";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import centroid from "@turf/centroid";
import bbox from "@turf/bbox";
import distance from "@turf/distance";
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

// Modul-Scope-Cache (gilt pro warmer Serverless-Instanz)
let index = null;      // RBush-Index über BBoxen
let items = null;      // { minX, minY, maxX, maxY, feature, centroid } je Feature

function loadData() {
  if (index) return { index, items };

  const filePath = path.join(process.cwd(), "data", "deutschland.geojson");
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);

  const features = parsed.features.filter(
    (f) =>
      f.geometry &&
      (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
  );

  // Für jedes Feature BBox + Centroid einmalig vorberechnen
  items = features.map((feature) => {
    const [minX, minY, maxX, maxY] = bbox(feature);
    return {
      minX,
      minY,
      maxX,
      maxY,
      feature,
      centroidCoord: centroid(feature).geometry.coordinates,
    };
  });

  index = new RBush();
  index.load(items);

  return { index, items };
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
    const { index, items } = loadData();
    const targetPoint = point([longitudeNum, latitude]);

    // 1. Nur Kandidaten aus dem R-Tree holen, deren BBox den Punkt enthält
    const candidates = index.search({
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

    // 2. Fallback: nächstgelegenes Feature per vorab berechnetem Centroid
    if (!match) {
      let bestDist = Infinity;
      for (const item of items) {
        const d = distance(
          targetPoint,
          point(item.centroidCoord),
          { units: "kilometers" }
        );
        if (d < bestDist) {
          bestDist = d;
          match = item.feature;
        }
      }
    }

    if (!match) {
      return res.status(404).json({ error: "Kein Treffer gefunden." });
    }

    const p = match.properties;
    const bundesland = BUNDESLAND_MAP[p.SN_L] ?? null;

    return res.status(200).json({
      lat: latitude,
      lon: longitudeNum,
      name: p.name ?? null,
      bundesland,
    });
  } catch (err) {
    console.error("Reverse-Geocoding-Fehler:", err);
    return res.status(500).json({ error: "Interner Serverfehler." });
  }
}