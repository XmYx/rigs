// The dark green-vector MapLibre style, built over OpenMapTiles-schema vector tiles (OpenFreeMap by
// default). Fills are off or near-black; roads, water, parks and buildings are thin neon-green
// strokes; buildings rise as translucent dark-green extrusions; labels are muted green; no POIs.

export const PALETTE = {
  bg: '#010403',
  fill: '#020a06',
  water: '#010c09',
  neon: '#00ff88',
  neonDim: '#00c46a',
  neonFaint: '#0a6b40',
  label: '#3fa774',
  labelHalo: '#010403',
  building: '#03170e',
  route: '#00ff88',
  routeCore: '#c8ffe4',
};

const z = (stops) => ['interpolate', ['exponential', 1.6], ['zoom'], ...stops.flat()];
const name = ['coalesce', ['get', 'name:latin'], ['get', 'name']];
const notTunnel = ['!=', ['get', 'brunnel'], 'tunnel'];

const ROADS = [
  // id, classes, width stops, colour, opacity, minzoom
  ['road-path', ['path', 'track'], [[14, 0.3], [18, 1.2]], PALETTE.neonFaint, 0.7, 14],
  ['road-service', ['service'], [[13, 0.3], [18, 1.6]], PALETTE.neonFaint, 0.9, 13],
  ['road-minor', ['minor'], [[12, 0.3], [18, 2.2]], PALETTE.neonDim, 0.8, 11],
  ['road-tertiary', ['tertiary'], [[10, 0.4], [18, 2.6]], PALETTE.neonDim, 0.95, 9],
  ['road-secondary', ['secondary'], [[8, 0.4], [18, 3]], PALETTE.neon, 0.8, 8],
  ['road-primary', ['primary'], [[7, 0.5], [18, 3.4]], PALETTE.neon, 0.9, 6],
  ['road-trunk', ['trunk'], [[5, 0.5], [18, 3.8]], PALETTE.neon, 0.95, 5],
  ['road-motorway', ['motorway'], [[4, 0.6], [18, 4.2]], PALETTE.neon, 1, 4],
];

/**
 * @param {{tiles: string, glyphs: string}} src  TileJSON URL of an OpenMapTiles vector source and
 *   the glyph (font) URL template.
 */
export function buildStyle({ tiles, glyphs }) {
  const layers = [
    { id: 'background', type: 'background', paint: { 'background-color': PALETTE.bg } },
    { id: 'park-fill', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': PALETTE.fill, 'fill-opacity': 0.9 } },
    { id: 'water-fill', type: 'fill', source: 'omt', 'source-layer': 'water', filter: notTunnel, paint: { 'fill-color': PALETTE.water } },
    { id: 'park-edge', type: 'line', source: 'omt', 'source-layer': 'park', minzoom: 9, paint: { 'line-color': PALETTE.neonDim, 'line-width': z([[9, 0.3], [16, 0.9]]), 'line-opacity': 0.45, 'line-dasharray': [3, 2] } },
    { id: 'landcover-edge', type: 'line', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass']]], minzoom: 12, paint: { 'line-color': PALETTE.neonFaint, 'line-width': 0.5, 'line-opacity': 0.5 } },
    { id: 'water-edge', type: 'line', source: 'omt', 'source-layer': 'water', filter: notTunnel, paint: { 'line-color': PALETTE.neon, 'line-width': z([[4, 0.4], [16, 1.4]]), 'line-opacity': 0.75 } },
    { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', filter: notTunnel, minzoom: 8, paint: { 'line-color': PALETTE.neonDim, 'line-width': z([[8, 0.3], [16, 1.2]]), 'line-opacity': 0.6 } },
    { id: 'boundary', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['<=', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': PALETTE.neonFaint, 'line-width': 0.8, 'line-dasharray': [4, 3], 'line-opacity': 0.7 } },
    { id: 'aeroway', type: 'line', source: 'omt', 'source-layer': 'aeroway', minzoom: 11, filter: ['in', ['get', 'class'], ['literal', ['runway', 'taxiway']]], paint: { 'line-color': PALETTE.neonFaint, 'line-width': z([[11, 0.5], [17, 6]]), 'line-opacity': 0.5 } },
    // Soft glow under the major roads, then the strokes themselves.
    { id: 'road-glow', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['all', notTunnel, ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': PALETTE.neon, 'line-width': z([[6, 2], [18, 14]]), 'line-blur': z([[6, 2], [18, 10]]), 'line-opacity': 0.16 } },
    { id: 'road-tunnel', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['==', ['get', 'brunnel'], 'tunnel'], minzoom: 12, paint: { 'line-color': PALETTE.neonFaint, 'line-width': z([[12, 0.5], [18, 2]]), 'line-dasharray': [2, 2], 'line-opacity': 0.6 } },
    { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['all', notTunnel, ['in', ['get', 'class'], ['literal', ['rail', 'transit']]]], minzoom: 10, paint: { 'line-color': PALETTE.neonFaint, 'line-width': z([[10, 0.4], [18, 1.6]]), 'line-dasharray': [3, 3], 'line-opacity': 0.8 } },
    ...ROADS.map(([id, classes, width, color, opacity, minzoom]) => ({
      id, type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom,
      filter: ['all', notTunnel, ['in', ['get', 'class'], ['literal', classes]]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': z(width), 'line-opacity': opacity },
    })),
    {
      id: 'building-3d', type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 14,
      filter: ['!=', ['get', 'hide_3d'], true],
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, PALETTE.building, 80, '#052b1b', 250, '#0a4a2f'],
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.5, ['coalesce', ['get', 'render_height'], 8]],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.9,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    // Footprints drawn after the extrusions: green line-art over the dark blocks.
    { id: 'building-edge', type: 'line', source: 'omt', 'source-layer': 'building', minzoom: 13, paint: { 'line-color': PALETTE.neon, 'line-width': z([[13, 0.2], [18, 1]]), 'line-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.25, 16, 0.55] } },
    // Labels: muted green, small, never POIs.
    {
      id: 'water-label', type: 'symbol', source: 'omt', 'source-layer': 'water_name', minzoom: 10,
      layout: { 'text-field': name, 'text-font': ['Noto Sans Italic'], 'text-size': 11, 'symbol-placement': 'point', 'text-letter-spacing': 0.15 },
      paint: { 'text-color': PALETTE.neonFaint, 'text-halo-color': PALETTE.labelHalo, 'text-halo-width': 1 },
    },
    {
      id: 'road-label', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 13,
      filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']]],
      layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': z([[13, 9], [18, 13]]), 'symbol-placement': 'line', 'text-letter-spacing': 0.08, 'text-max-angle': 30 },
      paint: { 'text-color': PALETTE.label, 'text-halo-color': PALETTE.labelHalo, 'text-halo-width': 1.4, 'text-opacity': 0.9 },
    },
    {
      id: 'place-minor', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 11,
      filter: ['in', ['get', 'class'], ['literal', ['suburb', 'quarter', 'neighbourhood', 'village', 'hamlet']]],
      layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-transform': 'uppercase', 'text-letter-spacing': 0.2 },
      paint: { 'text-color': PALETTE.label, 'text-halo-color': PALETTE.labelHalo, 'text-halo-width': 1.2, 'text-opacity': 0.75 },
    },
    {
      id: 'place-major', type: 'symbol', source: 'omt', 'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
      layout: { 'text-field': name, 'text-font': ['Noto Sans Bold'], 'text-size': z([[4, 11], [12, 16]]), 'text-transform': 'uppercase', 'text-letter-spacing': 0.25 },
      paint: { 'text-color': PALETTE.label, 'text-halo-color': PALETTE.labelHalo, 'text-halo-width': 1.5 },
    },
  ];
  return {
    version: 8,
    name: 'RIGS dark green vector',
    glyphs,
    sources: { omt: { type: 'vector', url: tiles } },
    // Dim light so extruded walls stay near-black; the shading still separates faces.
    light: { anchor: 'viewport', color: '#ffffff', intensity: 0.22, position: [1.4, 210, 35] },
    sky: {
      'sky-color': '#000a06',
      'horizon-color': '#00402a',
      'fog-color': '#010806',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.7,
      'fog-ground-blend': 0.75,
    },
    layers,
  };
}

/** Layers the app adds on top for the active route (a wide blurred glow under a bright core). */
export function routeLayers(sourceId = 'route') {
  return [
    { id: 'route-glow', type: 'line', source: sourceId, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': PALETTE.route, 'line-width': z([[10, 8], [18, 30]]), 'line-blur': z([[10, 6], [18, 18]]), 'line-opacity': 0.45 } },
    { id: 'route-line', type: 'line', source: sourceId, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': PALETTE.route, 'line-width': z([[10, 3], [18, 8]]), 'line-opacity': 0.95 } },
    { id: 'route-core', type: 'line', source: sourceId, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': PALETTE.routeCore, 'line-width': z([[10, 1], [18, 2.5]]), 'line-opacity': 0.9 } },
  ];
}
