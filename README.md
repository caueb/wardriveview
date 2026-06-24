# WardriveMap

View Wigle wardriving CSV exports on a map — route, WiFi access points, and
Bluetooth (BLE) devices. Everything runs in your browser; files are never
uploaded or stored.

## Use

Open the site, then **Load CSV** (or drag a file onto the map). Loaded data
lives only in memory — refresh to clear it.

- Route is street-snapped (via OSRM) with direction arrows and START/END markers.
- Device dots: blue = WiFi, pink = BLE.
- Filter devices by type and auth; switch between multiple loaded files.

## Notes

Map tiles from OpenStreetMap; route snapping via the public OSRM server (falls
back to the raw GPS trace if unavailable). Both require an internet connection.
