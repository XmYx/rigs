# Traffic data for the navigation applet

Decision record for the project goal: draw little moving cars around you and shade streets darker where
traffic is heavy, in `applets/navigation`. It covers where per-road traffic comes from and the server
contract the applet will use. It does not implement anything.

## Decision

| | Source | Needs | Used when |
| --- | --- | --- | --- |
| **Primary** | **TomTom Traffic Flow vector tiles** (`relative` flow, MVT) | free TomTom key in `NAV_TOMTOM_KEY` | a key is configured and the daily budget is not spent |
| **Fallback** | **Synthetic "assumed traffic"** from OpenFreeMap road classes + time-of-day + closeness to the route | nothing | no key, any TomTom error (401/403/429/5xx/timeout), budget spent, or `NAV_TRAFFIC_SOURCE=synthetic` |

No TomTom key exists on the mesh today (checked env and `~/.rigs/config.json` on magix-system,
2026-10-17). So **out of the box the applet runs on the synthetic model**. That still meets the project goal ("based
on assumed traffic"), and real data turns on as soon as a key is added.

Why TomTom:

- **Real per-road data, no credit card.** Its free plan has no credit card and gives 200K vector-tile
  requests a month, which is generous for one driver.
- **Same format and vocabulary as the map we already draw.** TomTom flow tiles are Mapbox Vector Tiles on
  the same z/x/y grid as the OpenFreeMap tiles the applet already shows. Their optional `road_category`
  tag uses the same class names as OpenMapTiles (`motorway … tertiary`, `street`). So one small MVT
  decoder and one class table serve both the live source and the fallback.
- **Covers Hungary**, which is where Sir drives and where the demo route is.

Why not WorldView: it has no traffic data to reverse-engineer (next section).

Runner-up is HERE Traffic API v7 (`/v7/flow`). It returns plain JSON per bbox, which is easier, but its free
traffic allowance couldn't be confirmed (see the survey). It is a drop-in second provider behind the same
contract if TomTom ever stops working for us.

## What WorldView actually uses

"WorldView" is Sir's own app. It is registered in the App Cloud as `worldview` on magix-system (port 8199,
`worldview.service`), and its source is at `/home/magix/apps/worldview`: commit `db607a4`, upstream
`github.com/kevtoe/worldview`. It is not NASA's Worldview (worldview.earthdata.nasa.gov), which is
satellite imagery with no traffic layer.

**Finding: WorldView's "STREET TRAFFIC" layer has no live traffic source.** The roads are real
OpenStreetMap geometry, but the cars and their speeds are invented in the browser. Nothing measures
congestion.

Evidence, from source, the shipped bundle and the running server:

1. **The only traffic call** is `GET /api/traffic/roads?south=&west=&north=&east=`, in
   `src/hooks/useTraffic.ts:102`. The same call is in the shipped bundle
   `dist/assets/index-s0dZWiha.js`: `fetch(\`/api/traffic/roads?${H}\`)`. No other traffic host
   (TomTom, HERE, Google, Waze) appears anywhere in the bundle.
2. **Server route** `server/index.js:241`. It POSTs an Overpass QL query to `overpass-api.de`, then falls
   back to `overpass.kumi.systems` (`server/index.js:297-363`):
   ```
   [out:json][timeout:10];
   way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential)$"](S,W,N,E);
   out geom;
   ```
   It turns each way into `{id:"way:<osm id>", name, highway, maxspeed (default 50), geometry:[{lat,lon}], length_meters}`.
   Results are cached 24 h in node-cache (`Cache-Control: public, s-maxage=86400`). When Overpass fails,
   the fallback is a static Sydney CBD file (`server/data/sydneyRoads.js`, 353 roads). Anywhere else it
   returns `{"roads":[],"source":"none"}`.
3. **The "traffic" is synthetic.**
   - Vehicles are evenly spaced at a fixed density per class:
     `spawnTrafficVehicles` / `getVehicleDensity`, `useTraffic.ts:205,255`. Motorway gets 2/km, residential 0.2/km.
   - Each class gets a fixed speed (`getVehicleBaseSpeed`, `useTraffic.ts:237`): motorway 110, residential 30 km/h.
   - Cars loop back to the start at the end of a road.
4. **There is no congestion.** `TrafficLayer.tsx:172-177`: with `congestionMode` on, every road is painted
   `#00FF00`, with the comment "This would be enhanced with real traffic data". `App.tsx:403` passes
   `congestionMode={false}`.
5. **Live capture, 2026-10-17 12:59Z.**
   - Request: `curl 'http://127.0.0.1:8199/api/traffic/roads?south=47.495&west=19.050&north=47.500&east=19.058'`
     (Budapest, Deák tér).
   - Response: `200 {"roads":[],"cached":false,"source":"none"}`.
   - Service journal: `[TRAFFIC] Rate limited by https://overpass.kumi.systems/api/interpreter` →
     `Overpass API HTTP 429` → `No data available for bbox`.
   - So the public Overpass mirrors also make it unreliable as a geometry source.

REA was not needed. The full source is on disk, so the shipped bundle and a live request were checked
directly, which is stronger evidence than a network capture. In the UI the layer is off by default
(`traffic:!1`), so a passive capture would not have shown the request anyway.

**What carries over from WorldView:** the idea, not the data path. That idea is cars spaced by road class,
moving at a class speed, headed along the road's bearing. Our synthetic model below is the same idea with
time of day and congestion added. It reads geometry from the vector tiles the applet already loads,
instead of from rate-limited Overpass.

## Survey of free sources

| Source | Per-road flow? | Key / cost | Verdict |
| --- | --- | --- | --- |
| **TomTom Traffic Flow, vector tiles** (`/traffic/map/4/tile/flow/{type}/{z}/{x}/{y}.pbf`) | yes, `traffic_level` per segment, `road_closure` | free key, no credit card. Official pricing page: 200K tile req/month free | **chosen** |
| TomTom Flow Segment Data (`/traffic/services/4/flowSegmentData/...`) | one segment per point query | free key; 20K non-tile req/month | no: one request per road point, can't cover an area |
| HERE Traffic API v7 `/v7/flow?in=bbox:w,s,e,n&locationReferencing=shape` | yes: JSON, `currentFlow.speed`, `freeFlow`, `jamFactor` 0–10, shape points | key; free band for traffic not confirmed on the pricing pages (Base plan lists 0–30K tx/month free for most APIs) | runner-up / second provider |
| Waze | yes | Waze for Cities feed only for partner organisations under agreement; the live-map JSON is internal and scraping it is against the ToS | no |
| Google Maps traffic layer | raster picture only | key + billing; ToS forbids extracting data | no |
| BKK (Budapest) open data, FUTÁR | **no road traffic**: GTFS / GTFS-realtime for public transport only | free key | no |
| Budapest Közút loop-detector counts (shown on bkk.hu "Közúti mérőeszközök adatai") | daily aggregated counts, charts only, no documented API | – | no |
| OpenStreetMap via Overpass | **geometry only**, no traffic; public instances rate-limit (429 seen live above) | none | no as a traffic source. Geometry comes from OpenFreeMap tiles instead |

Not evaluated in depth: Mapbox Traffic v1 vector tileset (needs a Mapbox account; terms tie data to Mapbox maps).

## Primary: TomTom Traffic Flow vector tiles

**Key-gated.** Put the key in env `NAV_TOMTOM_KEY` or in `~/.rigs/config.json` →
`navigation.tomtomKey`, never in this repo. Free key: developer.tomtom.com → register → "Keys".
The key stays on the server: it must not appear in `config.json`, in logs, or in error messages. The
warning style in `loadNavConfig` (name the setting, never the value) already does this.

### Request

One tile per z/x/y, on the same grid as the OpenFreeMap tiles. For the demo start (Deák tér, z14):

```bash
curl -s --compressed -o flow.pbf -w 'HTTP %{http_code} %{content_type}\n' \
  "https://api.tomtom.com/traffic/map/4/tile/flow/relative/14/9059/5729.pbf?key=$NAV_TOMTOM_KEY&tags=[road_category,road_subcategory,traffic_level,traffic_road_coverage,left_hand_traffic,road_closure]"
```

- `relative`: `traffic_level` = current speed ÷ free-flow speed, `0.00`–`1.00`. `absolute` would give km/h
  instead, but without a free-flow reference, so `relative` is the one to use.
- `tags=[…]`: asks for `road_category`, which is off by default, next to the default tags. The brackets in
  the array syntax follow TomTom's own `roadTypes={[2,4,5]}` example. **Check it the first time you use a key**:
  if the server rejects it, drop `tags` and map `road_type` instead (table below).
- Zoom 0–22 is allowed. We ask at the same tile zoom as the geometry, so tiles line up 1:1 (see the contract).

### Response

`200 image/pbf`, possibly gzip-encoded. One vector layer named **`Traffic flow`**, extent 4096, with
LineString features carrying these properties:

| Tag | Values | Our use |
| --- | --- | --- |
| `traffic_level` | `0.00`–`1.00` (relative) | `congestion = 1 − traffic_level` |
| `road_category` (on demand) | `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `street` | `class` (`street` → `minor`) |
| `road_subcategory` (on demand) | `connecting`, `major_local`, `local`, `minor_local` | ignored |
| `road_type` (default) | `Motorway`, `International road`, `Major road`, `Secondary road`, `Connecting road`, `Major local road`, `Local road`, `Minor local road`, `Non public road`, `Parking road` | class if `road_category` is missing: Motorway→motorway, International→trunk, Major→primary, Secondary→secondary, Connecting/Major local→tertiary, Local/Minor local→minor, the rest→service |
| `traffic_road_coverage` | `one_side` \| `full` | `one_side`: a two-way road comes as one feature per direction, so `oneway: true` on each |
| `left_hand_traffic` | `true` or absent | which side cars drive on |
| `road_closure` | `true` or absent | `congestion = 1`, `speedKmh = 0` |

The decoded features look like this. The values are illustrative: without a key no real TomTom tile could be captured.

```json
{ "layer": "Traffic flow", "extent": 4096,
  "features": [
    { "type": "LineString", "geometry": [[1820, 2311], [1906, 2254], [1990, 2199]],
      "properties": { "road_category": "primary", "traffic_level": 0.31, "traffic_road_coverage": "one_side" } } ] }
```

Errors come back as JSON: `{"detailedError":{"code":"Unauthorized","message":"You are missing valid authentication credentials"}}`.
That body with HTTP 401 is exactly what the request above returned on 2026-10-17 without a key and with a
bogus key. Other codes: 400 for bad params/zoom, 403 for a key not valid for this API, 429 when over the
limit, 503 when the service is down.

**`speedKmh`:** `relative` gives a ratio, not a speed, so `speedKmh = freeFlowKmh(class) × traffic_level`,
using the same free-flow table as the synthetic model. Exact km/h would need a second `absolute` tile;
the cars don't need that precision.

### Limits and terms

- **Quota.** TomTom's official pricing page lists 200K free tile requests a month and 20K non-tile, with
  no credit card. Older pages and the July 2026 price announcement show per-day figures (50,000 tiles /
  2,500 non-tile), so treat the monthly number as current and re-check when the key is created. Over the
  limit the API answers `429`.
- **Our budget.** The server stops calling TomTom after `NAV_TRAFFIC_DAILY_TILES` tile fetches per UTC day
  (default 5000, about 150K a month) and serves the synthetic model for the rest of that day.
- **Storage.** TomTom's third-party terms (2019 edition, the most recent text found) forbid keeping
  TomTom Traffic data on our servers for more than 24 hours. Our cache holds it for 60 s, in memory only.
- **Attribution.** Show "Traffic © TomTom" in the map attribution while live data is on screen.
- **Use.** The free tier is for personal, low-volume use, which fits a single-user mesh applet.

## Fallback: synthetic "assumed traffic"

This needs no key and uses no new outside service. Road geometry and class come from the OpenFreeMap tiles
the applet already uses (`tilesUrl`, a TileJSON whose `tiles[0]` is today
`https://tiles.openfreemap.org/planet/20261011_080001_pt/{z}/{x}/{y}.pbf`, maxzoom 14). Layer
`transportation`, LineStrings, property `class`.

Checked on 2026-10-17 by decoding z14 tile 9059/5729 (Deák tér) with a dependency-free MVT reader. Line
counts by `class`: minor 389, path 125, secondary 122, service 88, tertiary 48, transit 15, primary 14.
Each line has `oneway` and `ramp`, but no name and no maxspeed.

```bash
curl -s https://tiles.openfreemap.org/planet | jq -r '.tiles[0]'      # tile template (re-read: the version changes)
curl -s -o t.pbf "https://tiles.openfreemap.org/planet/20261011_080001_pt/14/9059/5729.pbf"   # 200, ~620 KB
```

### The model

Inputs per segment: `class`, the local time `t` (weekday, hour `h` as a fraction), and the distance `d` to
the active route. All numbers are tuning defaults, kept in one table in code.

1. **Classes kept:** motorway, trunk, primary, secondary, tertiary, minor, service. `path`, `track`,
   `transit`, `rail`, `ferry`, `pier`, `*_construction` are dropped. Below zoom 13, only motorway…secondary;
   below zoom 15, minor and service are left out too.
2. **Per-class load `L` and free-flow speed `V`** (urban Hungary; the 50 km/h urban limit sets primary
   and secondary):

   | class | motorway | trunk | primary | secondary | tertiary | minor | service |
   | --- | --- | --- | --- | --- | --- | --- | --- |
   | `L` | 0.60 | 0.55 | 0.50 | 0.42 | 0.32 | 0.14 | 0.06 |
   | `V` km/h | 100 | 80 | 50 | 50 | 40 | 30 | 15 |

3. **Time-of-day demand `D(h)`**, 0..1, with `g(h,μ,σ) = exp(−(h−μ)²/2σ²)`:
   - weekday: `D = min(1, 0.08 + 0.42·g(h,12.5,3.2) + 0.55·g(h,7.75,1.1) + 0.60·g(h,16.75,1.5))`
   - Saturday, Sunday and public holidays: `D = min(1, 0.06 + 0.50·g(h,13.5,3.5))`

   | h | 03 | 06 | 07:45 | 09 | 12 | 15 | 16:45 | 19 | 21 |
   | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
   | weekday | 0.09 | 0.29 | **0.77** | 0.60 | 0.50 | 0.69 | **0.85** | 0.33 | 0.10 |
   | weekend | 0.07 | 0.11 | 0.19 | 0.28 | 0.52 | 0.52 | 0.38 | 0.21 | 0.11 |

   Local time comes from the optional `tz` parameter (an IANA zone the browser sends), else the server's zone.
4. **Closeness to the route `R`:** `0.12` within 100 m of the active route, falling linearly to 0 at
   500 m. The route OSRM picks is the fast path, so it is also the one other drivers pick. The bump also
   puts more cars where the driver is looking. Without a route, `R = 0`.
5. **Variation `J`:** deterministic, so polls don't flicker. `u = hash(segment id) ∈ [0,1)`, `m` = local
   minutes since midnight:
   `J = 0.16·(u − 0.5) + 0.06·sin(2π(m/20 + u))`. This gives a fixed ±0.08 per street plus a ±0.06 drift
   with a 20-minute period.
6. **Result:**
   - `congestion = clamp(L·(0.2 + 1.2·D) + R + J, 0, 0.95)`. The synthetic model never claims a full
     stop; only live closures give 1.
   - `speedKmh = max(3, round(V·(1 − congestion)))`.

Without `R` and `J`, a weekday 17:30 (`D = 0.73`) gives motorway 0.65, primary 0.54, tertiary 0.35 and
minor 0.15. At 03:00 everything stays under 0.18. Worked example: a primary road on the route, weekday
17:30, `u = 0.73` → `J = 0.096` → `congestion = 0.76`, `speedKmh = 12`.

## Server contract: `GET api/traffic`

This is a new endpoint on the navigation applet server, with a relative path like the others (it is
reached as `/api/nodes/<node>/apps/navigation/api/traffic`).

### Request

`GET api/traffic?bbox=w,s,e,n&z=<map zoom>[&route=<routeId>][&tz=<IANA zone>][&source=synthetic]`

| Param | Required | Meaning |
| --- | --- | --- |
| `bbox` | yes | `west,south,east,north` in degrees. Usually the visible map bounds plus a margin. |
| `z` | yes | current map zoom (float, 0–22). It sets the tile zoom `tz = clamp(round(z), 12, 14)` and the class filter. |
| `route` | no | `routeId` from `api/route`, for the closeness term. Unknown or expired ids are ignored. |
| `tz` | no | IANA time zone for the time-of-day curve, e.g. `Europe/Budapest`. Defaults to the server's zone. |
| `source` | no | `synthetic` forces the fallback (for testing and the demo). Otherwise `NAV_TRAFFIC_SOURCE` decides. |

**Validation:** 400 `{error}` if `bbox` is not 4 finite numbers with w<e and s<n, or if `z` is missing.

**Size cap:** if the bbox covers more than 16 tiles at `tz`, the server serves the 16 tiles nearest the
bbox centre and sets `"clipped": true`. It never errors for a bbox that is too large.

To make `route` work, `api/route` gains a `routeId` field: a short hash of `from`/`to`. The server keeps
the last 20 route geometries for 30 min, keyed by that id. That way the client never has to upload a long
polyline.

### Response

`200 application/json`, `Cache-Control: private, max-age=30`. In this example the coordinates are the real first
points of a primary road in tile 14/9059/5729; the feature index and the numbers come from the worked example above:

```json
{
  "source": "synthetic",
  "updated": "2026-10-17T15:30:00.000Z",
  "z": 14,
  "clipped": false,
  "segments": [
    {
      "id": "omt:14/9059/5729:212:0",
      "coords": [[19.060464, 47.494436], [19.060072, 47.494483], [19.060003, 47.494502], [19.059933, 47.494549]],
      "class": "primary",
      "congestion": 0.76,
      "speedKmh": 12,
      "oneway": true
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `source` | `"tomtom"` \| `"synthetic"` \| `"none"`. The client shows "Traffic © TomTom" only for `tomtom`. |
| `updated` | ISO time the data is for. For `tomtom` it is when the tiles were fetched; for `synthetic`, the time the model was computed for. |
| `segments[].id` | Stable while the tile version and source stay the same: `<src>:<tz>/<x>/<y>:<feature index>:<part index>`, with `src` = `omt` or `tt`. The client keeps a car on its segment across polls by id. |
| `segments[].coords` | `[[lon, lat], …]`, ≥ 2 points, rounded to 6 decimals. **Clipped to the tile's own bounds** (no tile buffer), so roads that cross tile edges aren't doubled. |
| `segments[].class` | `motorway` \| `trunk` \| `primary` \| `secondary` \| `tertiary` \| `minor` \| `service` (OpenMapTiles names) |
| `segments[].congestion` | 0..1, scale below |
| `segments[].speedKmh` | current speed for the cars on this segment, ≥ 0 |
| `segments[].oneway` | optional. `true`: cars move in the drawing direction only. Absent or false: both ways. |

Clients must ignore fields they don't know. `z` and `clipped` are informational.

If every source fails, even OpenFreeMap, the response is `200 {"source":"none","updated":…,"segments":[]}`.
The applet then just draws no cars; it never shows an error screen for traffic.

### Congestion scale

`congestion = 1 − current speed ÷ free-flow speed`. It means the same for both sources:

| congestion | band | shading (suggested) | cars |
| --- | --- | --- | --- |
| 0.00 – 0.25 | free | normal road green | sparse, at full speed |
| 0.25 – 0.50 | moderate | slightly darker | denser |
| 0.50 – 0.75 | heavy | darker | dense, slow |
| 0.75 – 1.00 | jammed / stopped | darkest | queued; 1.0 = closed (TomTom `road_closure` only) |

"Darker" fits the neon-on-black style: lower the stroke brightness from the class green toward
near-black as congestion rises. A suggested car density is `cars/km = 2 + 18·congestion` on arterials,
halved on minor roads. The exact look belongs to the UI task.

### Caching and rate limits

- **OpenFreeMap geometry:**
  - Fetch tiles only at z12–14 and cache them in memory for 24 h. The tile URLs are versioned and immutable.
  - Re-read the TileJSON every 6 h to pick up a new version.
  - Cache the *decoded, clipped* lines rather than raw buffers: a central z14 tile is about 620 KB raw.
    Keep at most 64 tiles.
- **TomTom tiles:** cache in memory for 60 s per `tz/x/y`, matching TomTom's roughly one-minute flow
  update. Never write them to disk (24 h storage limit above).
- **Concurrent requests:** identical in-flight upstream fetches are shared, never duplicated.
- **TomTom budget and failures:**
  - Count tiles fetched per UTC day; at `NAV_TRAFFIC_DAILY_TILES` (default 5000), switch to synthetic until midnight UTC.
  - A 429 → synthetic for 15 min.
  - A 401/403 → synthetic until restart, with one log line naming `NAV_TOMTOM_KEY` but not its value.
- **Synthetic results:** a pure function of (tile lines, time bucket, route). Compute on every request,
  with a 60 s time bucket so repeated polls within a minute return identical numbers.
- **Client polling:** re-fetch every 60 s while the map is visible, plus on `moveend` debounced 500 ms.
  Send `bbox` snapped outward to the `tz` tile grid so the server cache hits.

  At z14 that is about 4–9 tiles per poll. A 1-hour drive costs about 540 TomTom tiles worst case, well
  inside the budget.
- **Upstream requests** use the applet's existing `User-Agent` (`rigs-navigation-applet/0.1 …`) and a
  10 s timeout, like the other upstream calls.

### Configuration (to add to `loadNavConfig`)

| Env | `navigation.<key>` | Default |
| --- | --- | --- |
| `NAV_TRAFFIC_SOURCE` | `trafficSource` | `auto`: TomTom when a key is set, else synthetic. Also `tomtom`, `synthetic`, `off`. |
| `NAV_TOMTOM_KEY` | `tomtomKey` | unset. Secret; never sent to the browser or logged. |
| `NAV_TRAFFIC_DAILY_TILES` | `trafficDailyTiles` | `5000` |
| `NAV_TOMTOM_URL` | `tomtomUrl` | `https://api.tomtom.com` |

### Implementation notes for the next tasks

- **No new npm dependency.** A minimal MVT reader (protobuf varints, zig-zag, MoveTo/LineTo commands; about
  100 lines) decodes both OpenFreeMap and TomTom tiles. It was proved against the live z14 Budapest tile
  while writing this doc.
- **Tests** can use the existing fake-upstream pattern in `test/navigation.test.js`:
  - a tiny hand-built MVT buffer for the decoder
  - fixed `t`/`tz` inputs for `D(h)`
  - a forced TomTom 429 to check the fallback switch

## Sources

- WorldView source: `/home/magix/apps/worldview` @ `db607a4`. Live service on magix-system:8199 and its
  `journalctl --user -u worldview.service` (2026-10-17).
- TomTom Vector Flow Tiles: https://docs.tomtom.com/traffic-api/documentation/tomtom-maps/traffic-flow/vector-flow-tiles
- TomTom pricing: https://docs.tomtom.com/pricing and https://docs.tomtom.com/pricing/price-announcement
- TomTom third-party terms (24 h traffic storage): https://download.tomtom.com/open/banners/third-party-product-terms-eula-2019-09.pdf
- HERE Traffic API v7: https://docs.here.com/traffic-api/reference and https://docs.here.com/traffic-api/docs/migrate-flow ; pricing https://developer.here.com/pricing
- BKK open data: https://opendata.bkk.hu ; road counts https://bkk.hu/rolunk/forgalmi-adatok-diagramok/kozuti-meroeszkozok-adatai/
- OpenFreeMap: https://openfreemap.org ; OpenMapTiles `transportation` schema: https://openmaptiles.org/schema/
