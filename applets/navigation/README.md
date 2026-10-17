# Navigation applet

A dark, 3D, green-vector navigation map for JARVIS. It has:

- tilted vector map, near-black base, neon-green outlines for roads, water, parks and buildings
- translucent extruded buildings and a glowing green route
- live speed readout (km/h ⇄ mph), heading compass, next-turn card and ETA
- a follow-me camera that eases to your position and direction of travel
- traffic: streets shaded darker where traffic is heavy, and little car silhouettes moving around you,
  more and slower on congested roads (see [Traffic](#traffic))

All data is **free and needs no API key** (live traffic can use an optional free key):

| What | Service | Notes |
| --- | --- | --- |
| Map tiles | [OpenFreeMap](https://openfreemap.org) vector tiles (OpenMapTiles schema, OpenStreetMap data) | No key, no registration. Attribution shown on the map. |
| Map engine | [MapLibre GL JS](https://maplibre.org) 5.24.0 from unpkg (fallback jsDelivr) | WebGL; renders 3D extrusions and pitch. |
| Routing | [OSRM](https://project-osrm.org) public demo server (`router.project-osrm.org`) | Driving profile, turn-by-turn steps. |
| Search | [Photon](https://photon.komoot.io), falling back to [Nominatim](https://nominatim.org) | Photon supports search-as-you-type; Nominatim is only asked when Photon fails. |
| Traffic (live) | [TomTom Traffic Flow vector tiles](https://docs.tomtom.com/traffic-api/documentation/tomtom-maps/traffic-flow/vector-flow-tiles) (`relative` flow) | Only with a free TomTom key (`NAV_TOMTOM_KEY`). Free tier: 200K tiles/month, no credit card. Shown as "Traffic © TomTom". |
| Traffic (assumed) | Synthetic model over the OpenFreeMap road network: road class × time of day × closeness to your route | No key. Used when there is no key, TomTom fails or the daily budget is spent. Choice and formulas: [`docs/traffic-source.md`](../../docs/traffic-source.md). |

The browser only fetches tiles, fonts and MapLibre itself. Search, routing and traffic go through this
applet's server, which:

- caches results for 10 minutes
- spaces Nominatim calls at least 1.1 s apart
- sends an identifying `User-Agent`

That keeps us inside the public services' usage policies for personal, low-volume use. For heavy use,
point the URLs at your own OSRM, Photon or Nominatim (see Configuration).

![desktop](docs/screenshot-traffic-desktop.png)

## Run

```bash
node applets/navigation/server.js              # http://127.0.0.1:8731/
# then open http://127.0.0.1:8731/?demo=1      # simulated drive, no GPS needed
```

No build step and no npm install beyond the repo itself. The server is plain Node 22 ESM and serves
everything with **relative URLs**, so it works both at `/` and behind the App Cloud proxy at
`/api/nodes/<node>/apps/navigation/`.

| Endpoint | Returns |
| --- | --- |
| `GET healthz` | `{"ok":true}` |
| `GET config.json` | `{tiles, glyphs, demo, traffic:{source}, provider}`: the public endpoints the browser loads; `traffic.source` is `tomtom`, `synthetic` or `off` (never the key) |
| `GET api/search?q=…&near=lon,lat` | `{results:[{label, detail, lon, lat}]}` |
| `GET api/route?from=lon,lat&to=lon,lat` | `{distance, duration, geometry:[[lon,lat]…], steps:[{type, modifier, name, location, distance, duration}], routeId}` |
| `GET api/traffic?bbox=w,s,e,n&z=…[&route=routeId][&tz=IANA zone][&source=synthetic][&at=ISO time]` | `{source, updated, z, clipped, segments:[{id, coords:[[lon,lat]…], class, congestion 0..1, speedKmh, oneway?}]}`, see [Traffic](#traffic) |

### Demo mode

`?demo=1` fetches a real route through central Budapest, from Deák tér up Andrássy út to Városliget. A
simulated vehicle drives it at 5 Hz:

- it speeds up, cruises between roughly 30 and 75 km/h, and brakes for each turn
- the speed readout, compass, next-turn card, ETA and 3D follow camera all run exactly as with GPS
- at the end it loops

Searching for a destination in demo mode drives there instead. If the routing service is down, the demo
falls back to a built-in line, so it still works.

The demo also shows traffic round the car. Without a TomTom key it asks the assumed-traffic model for
the latest weekday at 17:30 (`at=`), so the evening rush is visible whenever you open it.

## Configuration

Everything is optional. Environment variables win over `~/.rigs/config.json` → `navigation`, which wins
over the defaults:

| Env | `navigation.<key>` | Default |
| --- | --- | --- |
| `NAV_PORT` | `port` | `8731` |
| `NAV_HOST` | `host` | `127.0.0.1` (the App Cloud proxy reaches it locally) |
| `NAV_TILES_URL` | `tilesUrl` | `https://tiles.openfreemap.org/planet` (TileJSON, OpenMapTiles schema) |
| `NAV_GLYPHS_URL` | `glyphsUrl` | `https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf` |
| `NAV_ROUTING_URL` | `routingUrl` | `https://router.project-osrm.org` |
| `NAV_SEARCH_URL` | `searchUrl` | `https://photon.komoot.io` |
| `NAV_NOMINATIM_URL` | `nominatimUrl` | `https://nominatim.openstreetmap.org` |
| — | `demo.from`, `demo.to` | `[19.0548, 47.4979]` → `[19.0838, 47.5155]` (`[lon, lat]`) |
| `NAV_TRAFFIC_SOURCE` | `trafficSource` | `auto`: TomTom when a key is set, else assumed traffic. Also `tomtom`, `synthetic`, `off` (hides the toggle) |
| `NAV_TOMTOM_KEY` | `tomtomKey` | unset. **Secret**: stays on the server, never in `config.json`, logs or errors |
| `NAV_TRAFFIC_DAILY_TILES` | `trafficDailyTiles` | `5000` TomTom tiles per UTC day, then assumed traffic until midnight UTC |
| `NAV_TOMTOM_URL` | `tomtomUrl` | `https://api.tomtom.com` |

```json
{ "navigation": { "demo": { "from": [13.3777, 52.5163], "to": [13.4050, 52.5200] } } }
```

Any OpenMapTiles-schema source works for `tilesUrl`. That includes a self-hosted OpenFreeMap or
Planetiler build, or MapTiler with your own key in the URL. If you put a key there, keep it in
`~/.rigs/config.json` or the environment, never in this repo. Invalid values are ignored with a log
warning that names the setting but not its value.

## The look

The style lives in `public/mapstyle.js`, built in code over the OpenMapTiles layers:

- background `#010403`
- parks and water filled near-black
- roads as `#00ff88`-family strokes; width and brightness go up with road class
- water, park and building edges as thin green lines
- buildings as dark-green translucent extrusions, footprint lines drawn on top
- road, place and water labels in muted green `#3fa774`
- no POI, house-number or peak layers

Change `PALETTE` there to retune it. Traffic shading is `TRAFFIC_SHADE` in the same file.

## Traffic

![traffic on a phone](docs/screenshot-traffic-phone.png)

- **Street shading.** A dark veil over each road stroke, by congestion. Free flow leaves the normal
  green alone. Heavier traffic dims it toward a deep, slightly rust-tinted olive (bands at 0.25, 0.5,
  0.75, 1). It sits under the buildings, the labels and the route, so those stay readable.
- **Cars.** Small top-down silhouettes, drawn as a MapLibre symbol layer from one GeoJSON source and
  updated from one `requestAnimationFrame` loop at up to 30 Hz. There are no DOM markers. Cars are
  heading-aligned and lie flat on the map (`icon-rotation-alignment` and `icon-pitch-alignment: map`),
  so they stay on their streets when you rotate or tilt.
  - **Density:** `2 + 18·congestion` cars/km, halved on minor roads.
  - **Speed:** the road's `speedKmh`, ±6% per car. Cars on heavy roads (≥ 0.5) are amber.
  - **Movement:** cars keep right on two-way roads and turn onto connected roads at the end of a
    segment.
  - **Limit:** at most 260 cars (160 on phones), nearest the vehicle first.
- **Fetching.** The browser asks for a box of about 900 m round the vehicle, snapped to a 0.005° grid,
  so small moves reuse the last answer. It refetches when that box, the zoom band or the route changes,
  or after 60 s. It checks on `moveend` (trailing 500 ms timer) and every 15 s, and nothing runs while
  the tab is hidden.
- **Toggle.** The car button under 3D turns traffic on and off. The setting is remembered in
  `localStorage` (`nav.traffic`).
- **Server.** `api/traffic` serves z12–14 tiles (at most 16, nearest the bbox centre first; `clipped:
  true` says so) and keeps only the roads touching the bbox. It caches:

  | What | How long |
  | --- | --- |
  | OpenFreeMap road lines | 24 h, decoded, in memory, at most 64 tiles; TileJSON re-read every 6 h |
  | TomTom tiles | 60 s, in memory only (TomTom terms: ≤ 24 h) |

  It also shares identical in-flight fetches. When TomTom fails it switches to assumed traffic:

  | TomTom result | Assumed traffic for |
  | --- | --- |
  | 429 | 15 min |
  | 401 or 403 | the rest of this run, with one log line naming `NAV_TOMTOM_KEY` |
  | any other error, or the daily budget spent | this request (the budget resets at midnight UTC) |

  If even the road geometry can't be loaded, it answers `{"source":"none","segments":[]}` and the map
  just shows no traffic. Large answers are gzipped.
- **Assumed traffic** is deterministic. Per road, it is a pure function of road class, local time (a
  one-minute bucket in the browser's time zone) and distance to the active route. So polls don't
  flicker, and the route you drive is a little busier, as the fast path usually is.
- **Formulas, rejected sources and TomTom details:** [`docs/traffic-source.md`](../../docs/traffic-source.md).

## GPS, HTTPS and the secure-context rule

Browsers only allow `navigator.geolocation` in a **secure context**: `https://…` or `http://localhost`.

- **Plain-HTTP tailnet address** (for example `http://100.x.y.z:4719`): the page can't read your
  location. It says so and offers the demo. To use GPS from a phone, reach JARVIS over HTTPS with
  Tailscale's own certificate:
  1. Tailscale admin console → DNS → enable MagicDNS and **HTTPS Certificates** (once per tailnet).
  2. On the RIGS machine: `tailscale serve --bg --https=443 http://127.0.0.1:4719`.
  3. On the phone open `https://<machine>.<tailnet>.ts.net/`. This is tailnet-only, not public.
     Machine names do show up in public certificate-transparency logs.
- **Inside JARVIS**: the app window's iframe grants `geolocation` (`ui/src/apps.js`), so the permission
  prompt comes from the JARVIS page.
- **Speed source**: the readout uses `coords.speed` when the device reports it (tagged `GPS`). Otherwise
  it derives speed from successive fixes with the haversine distance, smoothed over about 4 s, and
  ignores jitter while parked (tagged `CALC`). Demo mode shows `SIM`.

## When something is missing

The page never goes blank. It shows a styled screen with a Retry button if:

- the applet server is unreachable
- MapLibre can't be downloaded
- WebGL is off

See `docs/screenshot-no-webgl.png`. Tile, routing and search failures show a short status line instead
of an error.

## Tests and screenshots

- `npm test` runs `test/navigation.test.js`. It covers:
  - the haversine maths, speed from fixes, unit conversion, route progress and ETA
  - the style rules and config loading
  - the server endpoints against a fake upstream
  - traffic: the vector-tile reader on hand-built tiles, tile clipping, and the assumed-traffic model
    by class, hour, holiday and route
  - `api/traffic` with stubbed OpenFreeMap and TomTom (contract, caching, 429/401/budget fallback, the
    key never leaked)
  - the car simulator (density, speed, heading, keeping right, the car cap)
- `node applets/navigation/scripts/screenshot.js <url> <out.png> 1440x900 --swiftshader` takes a
  headless-Chrome screenshot. It also prints speed samples, console errors and failed requests.
  `--swiftshader` gives headless Chrome a software WebGL.
