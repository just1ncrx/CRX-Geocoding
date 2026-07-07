import fs from "fs";
import path from "path";
import bbox from "@turf/bbox";

const SRC = path.join(process.cwd(), "data", "deutschland.geojson");
const OUT = path.join(process.cwd(), "data", "deutschland.index.json");

function build() {
  const raw = fs.readFileSync(SRC, "utf-8");
  const parsed = JSON.parse(raw);

  const features = parsed.features.filter(
    (f) =>
      f.geometry &&
      (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
  );

  const items = features.map((feature) => {
    const [minX, minY, maxX, maxY] = bbox(feature);
    return {
      minX,
      minY,
      maxX,
      maxY,
      feature: {
        type: "Feature",
        properties: {
          SN_L: feature.properties.SN_L,
          name: feature.properties.name,
        },
        geometry: feature.geometry,
      },
    };
  });

  fs.writeFileSync(OUT, JSON.stringify({ items }));
  console.log(`Index geschrieben: ${OUT} (${items.length} Features)`);
}

build();
