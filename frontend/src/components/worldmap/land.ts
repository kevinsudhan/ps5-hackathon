// Land shapes for the globe, bundled (Natural Earth 1:110m via world-atlas): no texture downloads.
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson'
import { feature } from 'topojson-client'
import type { GeometryCollection, Topology } from 'topojson-specification'
import countries from 'world-atlas/countries-110m.json'

let cache: object[] | null = null

// h3 (behind the dotted land) throws on degenerate rings, e.g. North Korea's 1:110m outline has one
const solid = (poly: Position[][]) => new Set(poly[0]?.map(p => `${p[0]},${p[1]}`)).size >= 3

/** Every country except Antarctica, as GeoJSON features for the dotted-land layer. */
export function landFeatures(): object[] {
  if (cache) return cache
  const topo = countries as unknown as Topology<{ countries: GeometryCollection }>
  const out: object[] = []
  for (const f of feature(topo, topo.objects.countries).features as Feature<Polygon | MultiPolygon>[]) {
    if (f.id === '010' || !f.geometry) continue
    if (f.geometry.type === 'Polygon') {
      if (solid(f.geometry.coordinates)) out.push(f)
    } else {
      const polys = f.geometry.coordinates.filter(solid)
      if (polys.length) out.push({ ...f, geometry: { type: 'MultiPolygon', coordinates: polys } })
    }
  }
  cache = out
  return cache
}
