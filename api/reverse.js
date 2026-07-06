import fs from "fs";
import path from "path";
import { point } from "@turf/helpers";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import centroid from "@turf/centroid";
import distance from "@turf/distance";

// GeoJSON nur einmal einlesen und im Modul-Scope cachen
let germanyFeatures = null;

function loadData() {
  if (germanyFeatures) return germanyFeatures;

  const filePath = path.join(process.cwd(), "data", "deutschland.geojson");
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);

  // Nur Polygon/MultiPolygon-Features behalten (Verwaltungsgrenzen)
  germanyFeatures = parsed.features.filter(
    (f) =>
      f.geometry &&
      (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
  );

  return germanyFeatures;
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
    const features = loadData();
    const targetPoint = point([longitudeNum, latitude]);

    // 1. Exakte Prüfung: liegt der Punkt in einem der Polygone?
    let match = null;
    for (const feature of features) {
      if (booleanPointInPolygon(targetPoint, feature)) {
        match = feature;
        break;
      }
    }

    // 2. Fallback: falls kein Treffer (z. B. Punkt knapp außerhalb / auf See),
    //    nächstgelegenes Polygon anhand des Zentroid-Abstands finden.
    let distanceKm = 0;
    if (!match) {
      let bestDist = Infinity;
      for (const feature of features) {
        const c = centroid(feature);
        const d = distance(targetPoint, c, { units: "kilometers" });
        if (d < bestDist) {
          bestDist = d;
          match = feature;
        }
      }
      distanceKm = bestDist;
    }

    if (!match) {
      return res.status(404).json({ error: "Kein Treffer gefunden." });
    }

    const p = match.properties;

    return res.status(200).json({
      query: { lat: latitude, lon: longitudeNum },
      result: {
        name: p.name ?? null,
        bez: p.BEZ ?? null, // z.B. "Gemeinschaftsfreie Gemeinde"
        ars: p.ARS ?? null, // Amtlicher Regionalschlüssel
        ags: p.AGS ?? null, // Amtlicher Gemeindeschlüssel
        nuts: p.NUTS ?? null,
        bundesland_code: p.SN_L ?? null,
        exact_match: distanceKm === 0,
        distance_km: distanceKm > 0 ? Number(distanceKm.toFixed(3)) : 0,
      },
      raw: match,
    });
  } catch (err) {
    console.error("Reverse-Geocoding-Fehler:", err);
    return res.status(500).json({ error: "Interner Serverfehler." });
  }
}
