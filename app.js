/* WardriveMap — static, no-backend version.
   Parses Wigle CSV entirely in the browser; nothing is uploaded or stored.
   The CSV parser is a faithful port of the Python parse_wigle_csv(). */

const map = L.map('map');
window.addEventListener('load', () => setTimeout(() => map.invalidateSize(), 0));
window.addEventListener('resize', () => map.invalidateSize());

// ---- Base map styles (switchable via the layers control, persisted) ----
const baseLayers = {
  'Street': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }),
  'Dark': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  }),
  'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics'
  })
};
const BASEMAP_KEY = 'basemapStyle';
const savedBase = localStorage.getItem(BASEMAP_KEY);
(baseLayers[savedBase] || baseLayers['Street']).addTo(map);
L.control.layers(baseLayers, null, { position: 'topleft' }).addTo(map);
map.on('baselayerchange', e => localStorage.setItem(BASEMAP_KEY, e.name));
map.setView([-33.955, 115.08], 14);

const layers = L.layerGroup().addTo(map);
const arrowLayer = L.layerGroup().addTo(map);
let currentLinePoints = [];
let currentRoutePoints = [];
let sortMode = 'date-desc';

const captureListEl = document.getElementById('captureList');
const summaryEl = document.getElementById('summary');
const mapStatusEl = document.getElementById('mapStatus');
const loadStatusEl = document.getElementById('loadStatus');
const fileInput = document.getElementById('fileInput');
const clearButton = document.getElementById('clearButton');
const captureCountEl = document.getElementById('captureCount');
const deviceListEl = document.getElementById('deviceList');
const devicePanelHintEl = document.getElementById('devicePanelHint');
const deviceCountEl = document.getElementById('deviceCount');
const mapPageEl = document.getElementById('mapPage');
const mapShellEl = document.querySelector('.map-shell');
const dropZoneEl = document.getElementById('dropZone');

// In-memory state only — no persistence.
let captures = [];          // [{ id, ...parsed }]
let nextId = 1;
let selectedId = null;
let selectedDeviceId = null;
let allDevices = [];
let currentDevices = [];
let markerByDeviceId = new Map();
const deviceFilters = { type: 'ALL', auth: new Set() };

function setStatus(element, message, isError = false) {
  if (!element) return;
  element.textContent = message || '';
  element.classList.toggle('error', isError);
}
function setMapStatus(message, isError = false) { setStatus(mapStatusEl, message, isError); }
function setLoadStatus(message, isError = false) { setStatus(loadStatusEl, message, isError); }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

/* ----------------------------------------------------------------------
   MAC vendor (OUI) lookup.
   oui.json is generated from the Wireshark "manuf" database and maps
   24/28/36-bit MAC prefixes to vendor names. It is fetched lazily; lookups
   simply return null until it has arrived.
   ---------------------------------------------------------------------- */

let ouiDb = null;
fetch('oui.json')
  .then(r => (r.ok ? r.json() : null))
  .then(db => {
    ouiDb = db;
    // Refresh names that were rendered before the database arrived.
    if (allDevices.length) renderDeviceList();
  })
  .catch(err => console.warn('OUI vendor database unavailable:', err));

function macVendor(mac) {
  if (!ouiDb || !mac) return null;
  const hex = String(mac).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length < 6) return null;
  // Most-specific prefix wins: 36-bit, then 28-bit, then 24-bit (OUI).
  return ouiDb.p36[hex.slice(0, 9)] || ouiDb.p28[hex.slice(0, 7)] || ouiDb.p24[hex.slice(0, 6)] || null;
}

// Locally administered addresses (bit 0x02 of the first octet) are usually
// randomized MACs and will never match the IEEE registry.
function isLocallyAdministeredMac(mac) {
  const hex = String(mac || '').replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < 2) return false;
  return (parseInt(hex.slice(0, 2), 16) & 0x02) === 0x02;
}

/* ----------------------------------------------------------------------
   CSV parsing — port of the Python backend parse_wigle_csv()
   ---------------------------------------------------------------------- */

function cleanStr(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}
function parseFloatOrNull(value) {
  const t = cleanStr(value);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
function parseIntOrNull(value) {
  const t = cleanStr(value);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function validCoord(lat, lon) {
  return lat !== null && lon !== null && lat !== 0 && lon !== 0 &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}
function normalizeTime(value) {
  const text = cleanStr(value);
  if (!text || text.startsWith('0000-00-00')) return null;
  // Accept the standard Wigle "YYYY-MM-DD HH:MM:SS" form; pass through otherwise.
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  return text;
}

// Minimal RFC-4180-ish CSV row parser (handles quotes and embedded commas).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function displayDate(obj) {
  return obj.capture_date_display || obj.capture_date || '';
}
function displayDatetime(value) {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}:${m[6]}` : value;
}
function isoDateToAU(iso) {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

function parseWigleCsv(text, filename) {
  const lines = text.split(/\r\n|\n|\r/);
  if (!lines.length || !lines[0].startsWith('WigleWifi-')) {
    throw new Error('File does not look like a Wigle CSV export');
  }
  const headerLine = lines[1] || '';
  const header = parseCsvLine(headerLine);
  const idx = {};
  header.forEach((h, i) => { idx[h.trim()] = i; });
  const required = ['MAC', 'FirstSeen', 'CurrentLatitude', 'CurrentLongitude', 'RSSI', 'Type'];
  if (!required.every(col => col in idx)) {
    throw new Error('CSV is missing the expected Wigle header columns');
  }

  const devices = [];
  const route = [];
  const seen = new Set();
  const times = [];
  let wifiCount = 0, bleCount = 0;

  const col = (cells, name) => (idx[name] != null ? cells[idx[name]] : undefined);

  for (let li = 2; li < lines.length; li++) {
    if (!lines[li]) continue;
    const cells = parseCsvLine(lines[li]);
    const mac = cleanStr(col(cells, 'MAC'));
    if (!mac) continue;

    const firstSeen = normalizeTime(col(cells, 'FirstSeen'));
    const lat = parseFloatOrNull(col(cells, 'CurrentLatitude'));
    const lon = parseFloatOrNull(col(cells, 'CurrentLongitude'));
    if (firstSeen) times.push(firstSeen);

    let deviceType = (cleanStr(col(cells, 'Type')) || 'UNKNOWN').toUpperCase();
    if (deviceType === 'WIFI') wifiCount++;
    else if (deviceType === 'BLE' || deviceType === 'BT' || deviceType === 'BLUETOOTH') {
      deviceType = 'BLE'; bleCount++;
    }

    const mapLat = validCoord(lat, lon) ? lat : null;
    const mapLon = validCoord(lat, lon) ? lon : null;
    if (mapLat !== null && mapLon !== null) {
      const key = `${firstSeen}|${mapLat.toFixed(7)}|${mapLon.toFixed(7)}`;
      if (!seen.has(key)) {
        seen.add(key);
        route.push({
          time: firstSeen, lat: mapLat, lon: mapLon,
          altitude: parseFloatOrNull(col(cells, 'AltitudeMeters')),
          accuracy: parseFloatOrNull(col(cells, 'AccuracyMeters'))
        });
      }
    }

    devices.push({
      mac,
      ssid: cleanStr(col(cells, 'SSID')),
      auth_mode: cleanStr(col(cells, 'AuthMode')),
      first_seen: firstSeen,
      first_seen_display: displayDatetime(firstSeen),
      channel: parseIntOrNull(col(cells, 'Channel')),
      frequency: parseIntOrNull(col(cells, 'Frequency')),
      rssi: parseIntOrNull(col(cells, 'RSSI')),
      lat: mapLat, lon: mapLon,
      altitude: parseFloatOrNull(col(cells, 'AltitudeMeters')),
      accuracy: parseFloatOrNull(col(cells, 'AccuracyMeters')),
      rcois: cleanStr(col(cells, 'RCOIs')),
      mfgr_id: cleanStr(col(cells, 'MfgrId')),
      type: deviceType
    });
  }

  if (!devices.length) throw new Error('No device rows found in CSV');

  times.sort();
  const startedAt = times.length ? times[0] : null;
  const endedAt = times.length ? times[times.length - 1] : null;
  const captureDate = (startedAt || new Date().toISOString().slice(0, 19).replace('T', ' ')).slice(0, 10);

  // Chronological order is the source of truth, independent of CSV row order.
  const timeKey = item => {
    const t = ('time' in item) ? item.time : item.first_seen;
    return t || '\uffff'; // missing times sort last
  };
  route.sort((a, b) => timeKey(a).localeCompare(timeKey(b)));
  devices.sort((a, b) => timeKey(a).localeCompare(timeKey(b)));
  // Stable id per device for selection/markers.
  devices.forEach((d, i) => { d.id = i; });

  if (route.length) {
    route[0].role = 'start';
    route[route.length - 1].role = 'end';
  }

  return {
    filename,
    name: filename,
    capture_date: captureDate,
    capture_date_display: isoDateToAU(captureDate),
    started_at: startedAt,
    ended_at: endedAt,
    started_at_display: displayDatetime(startedAt),
    ended_at_display: displayDatetime(endedAt),
    wifi_count: wifiCount,
    ble_count: bleCount,
    route,
    devices
  };
}

/* ----------------------------------------------------------------------
   Device / capture helpers (ported from the original frontend)
   ---------------------------------------------------------------------- */

function deviceLabel(device) {
  if (device.ssid) return { name: device.ssid, source: 'ssid' };
  const vendor = macVendor(device.mac);
  if (vendor) return { name: vendor, source: 'vendor' };
  if (device.mac) {
    return isLocallyAdministeredMac(device.mac)
      ? { name: `${device.mac} (randomized)`, source: 'mac' }
      : { name: device.mac, source: 'mac' };
  }
  return { name: '(unnamed device)', source: 'mac' };
}
function deviceName(device) { return deviceLabel(device).name; }
function deviceTypeClass(device) { return device.type === 'BLE' ? 'ble' : 'wifi'; }
function authPillClass(device) {
  const auth = (device.auth_mode || '').toUpperCase();
  if (!auth || auth.includes('UNKNOWN')) return 'unknown';
  if (auth.includes('OPEN') || auth === '[]') return 'open';
  return 'secure';
}
function authLabel(device) {
  const raw = (device.auth_mode || '').replace(/[\[\]]/g, '').trim();
  if (!raw) return device.type === 'BLE' ? 'BLE' : 'Unknown';
  return raw;
}
function authKey(device) {
  const raw = (device.auth_mode || '').replace(/[\[\]]/g, '').trim().toUpperCase();
  if (!raw || raw === 'UNKNOWN') return 'UNKNOWN';
  return raw;
}
function authKeyLabel(key) {
  if (key === 'UNKNOWN') return 'Unknown';
  if (key === 'OPEN') return 'Open';
  if (key === 'LE') return 'BLE (LE)';
  return key;
}

function sortedCaptures() {
  const list = [...captures];
  list.sort((a, b) => {
    if (sortMode === 'name-asc' || sortMode === 'name-desc') {
      const r = (a.name || a.filename).localeCompare(b.name || b.filename, undefined, { sensitivity: 'base' });
      return sortMode === 'name-asc' ? r : -r;
    }
    const aKey = `${a.capture_date || ''} ${a.started_at || ''} ${a.id}`;
    const bKey = `${b.capture_date || ''} ${b.started_at || ''} ${b.id}`;
    const r = aKey.localeCompare(bKey);
    return sortMode === 'date-asc' ? r : -r;
  });
  return list;
}

function renderCaptureList() {
  captureListEl.innerHTML = '';
  clearButton.hidden = captures.length === 0;
  if (captureCountEl) {
    captureCountEl.hidden = captures.length === 0;
    captureCountEl.textContent = captures.length;
  }
  if (!captures.length) {
    captureListEl.innerHTML = '<p class="muted-block">No captures loaded yet.<br>Use <strong>Load CSV</strong> above or drop files on the map.</p>';
    return;
  }
  for (const cap of sortedCaptures()) {
    const item = document.createElement('div');
    item.className = `capture-item${cap.id === selectedId ? ' active' : ''}`;
    item.dataset.id = cap.id;
    item.innerHTML = `
      <span class="capture-line capture-meta-line">
        <span class="capture-date">${escapeHtml(displayDate(cap))}</span>
        <span class="capture-counts">${cap.wifi_count + cap.ble_count} devices</span>
      </span>
      <span class="capture-row">
        <span class="capture-name" title="${escapeHtml(cap.name || cap.filename)}">${escapeHtml(cap.name || cap.filename)}</span>
        <button type="button" class="capture-remove" data-remove="${cap.id}" title="Remove" aria-label="Remove capture">&times;</button>
      </span>`;
    captureListEl.appendChild(item);
  }
}

function deviceMatchesFilters(device) {
  if (deviceFilters.type === 'WIFI' && device.type === 'BLE') return false;
  if (deviceFilters.type === 'BLE' && device.type !== 'BLE') return false;
  if (deviceFilters.auth.size && !deviceFilters.auth.has(authKey(device))) return false;
  return true;
}

function buildAuthFilterMenu() {
  const menu = document.getElementById('authFilterMenu');
  if (!menu) return;
  const counts = new Map();
  for (const d of allDevices) {
    const k = authKey(d);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const keys = [...counts.keys()].sort((a, b) => authKeyLabel(a).localeCompare(authKeyLabel(b)));
  menu.innerHTML = keys.map(k =>
    `<label class="auth-opt">
       <input type="checkbox" value="${escapeHtml(k)}" ${deviceFilters.auth.has(k) ? 'checked' : ''}>
       <span>${escapeHtml(authKeyLabel(k))}</span>
       <span class="auth-opt-count">${counts.get(k)}</span>
     </label>`
  ).join('');
}

function updateAuthFilterSummary() {
  const summary = document.getElementById('authFilterSummary');
  if (!summary) return;
  const n = deviceFilters.auth.size;
  summary.textContent = n === 0 ? 'All auth types' : `${n} auth type${n > 1 ? 's' : ''}`;
}

function applyDeviceFilters() {
  currentDevices = allDevices.filter(deviceMatchesFilters);
  if (selectedDeviceId != null && !currentDevices.some(d => d.id === selectedDeviceId)) {
    selectedDeviceId = null;
  }
  for (const marker of markerByDeviceId.values()) layers.removeLayer(marker);
  markerByDeviceId = new Map();
  for (const device of currentDevices) {
    if (typeof device.lat === 'number' && typeof device.lon === 'number') {
      const marker = markerFor(device).addTo(layers);
      markerByDeviceId.set(device.id, marker);
    }
  }
  if (selectedDeviceId != null) resetMarkerHighlight();
  const filtered = currentDevices.length !== allDevices.length;
  deviceCountEl.textContent = filtered ? `${currentDevices.length}/${allDevices.length}` : allDevices.length;
  updateAuthFilterSummary();
  renderDeviceList();
}

function renderDeviceList() {
  deviceListEl.innerHTML = '';
  if (!currentDevices.length) {
    deviceListEl.innerHTML = '<p class="muted-block">No devices for this capture.</p>';
    return;
  }
  for (const device of currentDevices) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `device-item${device.id === selectedDeviceId ? ' active' : ''}`;
    item.dataset.deviceId = device.id;
    const label = deviceLabel(device);
    const nameTitle = label.source === 'vendor'
      ? `Vendor: ${label.name} (${device.mac})`
      : label.name;
    item.innerHTML = `
      <span class="device-dot ${deviceTypeClass(device)}" aria-hidden="true"></span>
      <span class="device-body">
        <span class="device-name${label.source === 'vendor' ? ' vendor' : ''}" title="${escapeHtml(nameTitle)}">${escapeHtml(label.name)}</span>
      </span>
      <span class="auth-pill ${authPillClass(device)}">${escapeHtml(authLabel(device))}</span>`;
    deviceListEl.appendChild(item);
  }
}

function resetMarkerHighlight() {
  for (const [id, marker] of markerByDeviceId.entries()) {
    const device = currentDevices.find(item => item.id === id);
    const color = device?.type === 'BLE' ? '#d66efd' : '#2f81f7';
    marker.setStyle({ radius: marker.options.baseRadius || 6, color, fillColor: color, weight: 1, fillOpacity: 0.78 });
  }
}

function selectDevice(deviceId, { openPopup = false, pan = false } = {}) {
  selectedDeviceId = Number(deviceId);
  resetMarkerHighlight();
  const marker = markerByDeviceId.get(selectedDeviceId);
  if (marker) {
    marker.setStyle({ radius: Math.max((marker.options.baseRadius || 6) + 4, 10), color: '#ffd166', fillColor: '#ffd166', weight: 3, fillOpacity: 1 });
    marker.bringToFront();
    if (openPopup) marker.openPopup();
    if (pan) map.panTo(marker.getLatLng());
  }
  renderDeviceList();
  const row = deviceListEl.querySelector(`[data-device-id="${selectedDeviceId}"]`);
  row?.scrollIntoView({ block: 'nearest' });
}

function markerFor(device) {
  const color = device.type === 'BLE' ? '#d66efd' : '#2f81f7';
  const radius = Math.max(4, Math.min(11, 14 + ((device.rssi ?? -90) / 10)));
  const marker = L.circleMarker([device.lat, device.lon], {
    radius, baseRadius: radius, color, fillColor: color, fillOpacity: 0.78, weight: 1
  });
  // Popup content is built on open so vendor names appear once oui.json loads.
  marker.bindPopup(() => {
    const vendor = macVendor(device.mac);
    return `
      <strong>${escapeHtml(deviceName(device))}</strong><br>
      MAC: ${escapeHtml(device.mac)}<br>
      Vendor: ${escapeHtml(vendor || (isLocallyAdministeredMac(device.mac) ? 'Randomized MAC' : 'Unknown'))}<br>
      RSSI: ${escapeHtml(device.rssi ?? 'n/a')} dBm<br>
      Auth: ${escapeHtml(device.auth_mode || 'n/a')}<br>
      Seen: ${escapeHtml(device.first_seen_display || device.first_seen || 'n/a')}<br>
      Type: ${escapeHtml(device.type)}
    `;
  });
  marker.on('click', () => selectDevice(device.id, { openPopup: false }));
  return marker;
}

function endpointMarker(point, label, className) {
  const isStart = className === 'start';
  const icon = L.divIcon({
    className: `endpoint-marker ${className}`,
    html: `<span class="endpoint-label">${label}</span><span class="endpoint-dot"></span>`,
    iconSize: [88, 22],
    iconAnchor: isStart ? [82, 11] : [6, 11]
  });
  return L.marker([point.lat, point.lon], { icon, zIndexOffset: 1000 })
    .bindPopup(`<strong>${label}</strong><br>${escapeHtml(point.time || '')}`);
}

async function fetchStreetRoute(points) {
  if (points.length < 2) return points.map(p => [p.lat, p.lon]);
  const maxWaypoints = 90;
  const streetPoints = [];
  for (let start = 0; start < points.length - 1; start += maxWaypoints - 1) {
    const chunk = points.slice(start, Math.min(points.length, start + maxWaypoints));
    if (chunk.length < 2) continue;
    const coords = chunk.map(p => `${p.lon},${p.lat}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&continue_straight=false`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`OSRM ${response.status}`);
    const data = await response.json();
    const route = data.routes?.[0]?.geometry?.coordinates;
    if (!route?.length) throw new Error('OSRM did not return a route');
    const latLon = route.map(([lon, lat]) => [lat, lon]);
    if (streetPoints.length && latLon.length) latLon.shift();
    streetPoints.push(...latLon);
  }
  return streetPoints.length ? streetPoints : points.map(p => [p.lat, p.lon]);
}

function bearing(a, b) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const lat1 = toRad(a[0]), lat2 = toRad(b[0]);
  const dLon = toRad(b[1] - a[1]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function addRouteArrows(routePoints) {
  arrowLayer.clearLayers();
  if (!routePoints || routePoints.length < 2) return;
  const MIN_SEG_PX = 6;
  const kept = [routePoints[0]];
  const keptPx = [map.latLngToLayerPoint(L.latLng(routePoints[0][0], routePoints[0][1]))];
  for (let i = 1; i < routePoints.length; i++) {
    const px = map.latLngToLayerPoint(L.latLng(routePoints[i][0], routePoints[i][1]));
    if (px.distanceTo(keptPx[keptPx.length - 1]) >= MIN_SEG_PX) {
      kept.push(routePoints[i]);
      keptPx.push(px);
    }
  }
  if (kept.length < 2) return;
  const segLen = [];
  let total = 0;
  for (let i = 1; i < keptPx.length; i++) {
    const d = keptPx[i].distanceTo(keptPx[i - 1]);
    segLen.push(d);
    total += d;
  }
  if (total === 0) return;
  const SPACING = 90;
  const count = Math.max(1, Math.floor(total / SPACING));
  const step = total / (count + 1);
  let target = step, acc = 0;
  for (let i = 1; i < kept.length; i++) {
    const segStart = acc;
    acc += segLen[i - 1];
    while (target <= acc && target < total) {
      const frac = segLen[i - 1] ? (target - segStart) / segLen[i - 1] : 0;
      const lat = kept[i - 1][0] + (kept[i][0] - kept[i - 1][0]) * frac;
      const lon = kept[i - 1][1] + (kept[i][1] - kept[i - 1][1]) * frac;
      const deg = bearing(kept[i - 1], kept[i]);
      const icon = L.divIcon({
        className: 'route-arrow',
        html: `<span style="transform: rotate(${deg}deg)">▲</span>`,
        iconSize: [16, 16], iconAnchor: [8, 8]
      });
      L.marker([lat, lon], { icon, interactive: false, keyboard: false, zIndexOffset: -200 }).addTo(arrowLayer);
      target += step;
    }
  }
}

map.on('zoomend', () => addRouteArrows(currentRoutePoints));

async function drawRoute(route) {
  const routePoints = route.filter(p => typeof p.lat === 'number' && typeof p.lon === 'number');
  if (!routePoints.length) return [];
  currentRoutePoints = routePoints.map(p => [p.lat, p.lon]);
  let linePoints = routePoints.map(p => [p.lat, p.lon]);
  if (routePoints.length > 1) {
    try {
      linePoints = await fetchStreetRoute(routePoints);
      setMapStatus('');
    } catch (err) {
      console.warn('Street route failed, falling back to raw GPS route:', err);
      setMapStatus('Could not snap route to streets; showing raw GPS trace.', true);
    }
    L.polyline(linePoints, { color: '#ffd166', weight: 5, opacity: 0.95 }).addTo(layers);
    L.polyline(routePoints.map(p => [p.lat, p.lon]), { color: '#111820', weight: 2, opacity: 0.45, dashArray: '4 8' }).addTo(layers);
    currentLinePoints = linePoints;
  } else {
    currentLinePoints = [];
    currentRoutePoints = [];
  }
  endpointMarker(routePoints[0], 'START', 'start').addTo(layers);
  endpointMarker(routePoints[routePoints.length - 1], 'END', 'end').addTo(layers);
  return linePoints;
}

async function showCapture(id) {
  const cap = captures.find(c => c.id === Number(id));
  if (!cap) return;
  selectedId = Number(id);
  renderCaptureList();

  layers.clearLayers();
  arrowLayer.clearLayers();
  currentLinePoints = [];
  currentRoutePoints = [];
  markerByDeviceId = new Map();
  selectedDeviceId = null;
  allDevices = cap.devices || [];
  currentDevices = allDevices;
  // Reset filters for the newly selected capture.
  deviceFilters.type = 'ALL';
  deviceFilters.auth = new Set();
  document.querySelectorAll('#typeFilter .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'ALL'));

  devicePanelHintEl.textContent = 'Ordered by capture time';
  deviceCountEl.textContent = allDevices.length;
  deviceCountEl.hidden = false;
  document.getElementById('deviceFilters').hidden = allDevices.length === 0;
  buildAuthFilterMenu();
  updateAuthFilterSummary();
  renderDeviceList();
  setMapStatus('Loading route…');

  const bounds = [];
  const routeLine = await drawRoute(cap.route);
  for (const p of routeLine) bounds.push(p);
  for (const p of cap.route) {
    if (typeof p.lat === 'number' && typeof p.lon === 'number') bounds.push([p.lat, p.lon]);
  }

  applyDeviceFilters();
  for (const device of currentDevices) {
    if (typeof device.lat === 'number' && typeof device.lon === 'number') bounds.push([device.lat, device.lon]);
  }

  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 17 });
  addRouteArrows(currentRoutePoints);

  summaryEl.hidden = false;
  summaryEl.className = 'summary-overlay';
  summaryEl.innerHTML = `
    <button type="button" class="summary-close" aria-label="Close details" title="Close">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
    <div class="summary-title">${escapeHtml(cap.name || cap.filename)}</div>
    <div class="summary-stats">
      <div class="stat wifi"><div class="stat-val">${cap.wifi_count}</div><div class="stat-lbl">WiFi</div></div>
      <div class="stat ble"><div class="stat-val">${cap.ble_count}</div><div class="stat-lbl">BLE</div></div>
      <div class="stat"><div class="stat-val">${cap.route.length}</div><div class="stat-lbl">Points</div></div>
    </div>
    <dl>
      <dt>Date</dt><dd>${escapeHtml(displayDate(cap))}</dd>
      <dt>Start</dt><dd>${escapeHtml(cap.started_at_display || cap.started_at || 'unknown')}</dd>
      <dt>End</dt><dd>${escapeHtml(cap.ended_at_display || cap.ended_at || 'unknown')}</dd>
    </dl>`;
}

/* ----------------------------------------------------------------------
   File loading (in-memory; nothing is uploaded or stored)
   ---------------------------------------------------------------------- */

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

async function loadFiles(fileList) {
  const files = [...fileList].filter(f => f);
  if (!files.length) return;
  setLoadStatus(`Reading ${files.length} file${files.length === 1 ? '' : 's'}…`);
  let added = 0;
  let lastId = null;
  const errors = [];
  for (const file of files) {
    try {
      const text = await readFileText(file);
      const parsed = parseWigleCsv(text, file.name);
      parsed.id = nextId++;
      captures.push(parsed);
      lastId = parsed.id;
      added++;
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
  }
  renderCaptureList();
  if (added) {
    dropZoneEl.hidden = true;
    setLoadStatus(errors.length ? `Loaded ${added}; ${errors.length} failed.` : `Loaded ${added} file${added === 1 ? '' : 's'}.`, errors.length > 0);
    if (lastId != null) {
      await showCapture(lastId);
      if (isMobileLayout()) setMobilePanel('map');
    }
  } else {
    setLoadStatus(errors[0] || 'No valid Wigle CSV found.', true);
  }
  if (errors.length) console.warn('CSV load errors:\n' + errors.join('\n'));
}

function removeCapture(id) {
  id = Number(id);
  captures = captures.filter(c => c.id !== id);
  if (selectedId === id) {
    selectedId = null;
    layers.clearLayers();
    arrowLayer.clearLayers();
    summaryEl.hidden = true;
    allDevices = [];
    currentDevices = [];
    deviceCountEl.hidden = true;
    document.getElementById('deviceFilters').hidden = true;
    devicePanelHintEl.textContent = 'Load a capture to list devices by capture time.';
    deviceListEl.innerHTML = '';
  }
  renderCaptureList();
  if (!captures.length) {
    dropZoneEl.hidden = false;
  } else if (selectedId === null) {
    showCapture(sortedCaptures()[0].id);
  }
}

function clearAll() {
  captures = [];
  selectedId = null;
  layers.clearLayers();
  arrowLayer.clearLayers();
  summaryEl.hidden = true;
  allDevices = [];
  currentDevices = [];
  deviceCountEl.hidden = true;
  document.getElementById('deviceFilters').hidden = true;
  devicePanelHintEl.textContent = 'Load a capture to list devices by capture time.';
  deviceListEl.innerHTML = '';
  renderCaptureList();
  dropZoneEl.hidden = false;
  setLoadStatus('');
}

/* ----------------------------------------------------------------------
   Event wiring
   ---------------------------------------------------------------------- */

fileInput.addEventListener('change', () => {
  loadFiles(fileInput.files).catch(err => setLoadStatus(err.message, true));
  fileInput.value = ''; // allow re-loading the same file
});

clearButton.addEventListener('click', clearAll);

captureListEl.addEventListener('click', async event => {
  const remove = event.target.closest('[data-remove]');
  if (remove) { removeCapture(remove.dataset.remove); return; }
  const item = event.target.closest('.capture-item');
  if (!item) return;
  try {
    await showCapture(item.dataset.id);
    if (isMobileLayout()) setMobilePanel('map');
  } catch (err) {
    setMapStatus(err.message, true);
  }
});

deviceListEl.addEventListener('click', event => {
  const item = event.target.closest('.device-item');
  if (!item) return;
  selectDevice(item.dataset.deviceId, { openPopup: true, pan: true });
  if (isMobileLayout()) setMobilePanel('map');
});

document.getElementById('typeFilter').addEventListener('click', event => {
  const btn = event.target.closest('.seg-btn');
  if (!btn) return;
  deviceFilters.type = btn.dataset.type;
  document.querySelectorAll('#typeFilter .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
  applyDeviceFilters();
});

document.getElementById('authFilterMenu').addEventListener('change', event => {
  const cb = event.target.closest('input[type="checkbox"]');
  if (!cb) return;
  if (cb.checked) deviceFilters.auth.add(cb.value);
  else deviceFilters.auth.delete(cb.value);
  applyDeviceFilters();
});

document.getElementById('sortMenu').addEventListener('click', event => {
  const opt = event.target.closest('.menu-opt');
  if (!opt) return;
  sortMode = opt.dataset.sort;
  document.querySelectorAll('#sortMenu .menu-opt').forEach(o => o.classList.toggle('active', o === opt));
  document.getElementById('sortSummary').textContent = opt.textContent;
  document.getElementById('sortFilter').open = false;
  renderCaptureList();
});

summaryEl.addEventListener('click', event => {
  if (event.target.closest('.summary-close')) summaryEl.hidden = true;
});

// Drag & drop onto the map area.
['dragenter', 'dragover'].forEach(evt =>
  mapShellEl.addEventListener(evt, e => { e.preventDefault(); mapShellEl.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach(evt =>
  mapShellEl.addEventListener(evt, e => { e.preventDefault(); if (evt === 'drop' || e.target === mapShellEl || e.target === dropZoneEl) mapShellEl.classList.remove('dragover'); })
);
mapShellEl.addEventListener('drop', e => {
  const files = e.dataTransfer?.files;
  if (files?.length) loadFiles(files).catch(err => setLoadStatus(err.message, true));
});

// ---- Devices panel drag-to-resize ----
(function setupDevicesResizer() {
  const handle = document.getElementById('devicesResizer');
  const panel = document.querySelector('.devices-panel');
  if (!handle || !panel) return;
  const MIN_W = 240;
  const STORAGE_KEY = 'devicesPanelWidth';
  const maxW = () => Math.round(window.innerWidth * 0.7);
  function applyWidth(px) {
    const w = Math.max(MIN_W, Math.min(maxW(), Math.round(px)));
    document.documentElement.style.setProperty('--devices-w', w + 'px');
    return w;
  }
  const saved = parseInt(localStorage.getItem(STORAGE_KEY) || '', 10);
  if (!Number.isNaN(saved)) applyWidth(saved);
  let dragging = false, pointerId = null;
  function onMove(event) {
    if (!dragging) return;
    applyWidth(window.innerWidth - event.clientX);
    if (map) map.invalidateSize();
  }
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing-devices');
    try { if (pointerId !== null) handle.releasePointerCapture(pointerId); } catch (_) {}
    pointerId = null;
    localStorage.setItem(STORAGE_KEY, parseInt(getComputedStyle(panel).width, 10));
    if (map) map.invalidateSize();
  }
  handle.addEventListener('pointerdown', event => {
    if (isMobileLayout()) return;
    event.preventDefault(); event.stopPropagation();
    dragging = true; pointerId = event.pointerId;
    try { handle.setPointerCapture(event.pointerId); } catch (_) {}
    document.body.classList.add('resizing-devices');
  });
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('lostpointercapture', endDrag);
  handle.addEventListener('keydown', event => {
    const step = event.shiftKey ? 40 : 16;
    let w = parseInt(getComputedStyle(panel).width, 10);
    if (event.key === 'ArrowLeft') w += step;
    else if (event.key === 'ArrowRight') w -= step;
    else return;
    event.preventDefault();
    localStorage.setItem(STORAGE_KEY, applyWidth(w));
    if (map) map.invalidateSize();
  });
  handle.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--devices-w');
    localStorage.removeItem(STORAGE_KEY);
    if (map) map.invalidateSize();
  });
})();

// ---- Captures panel collapse/expand ----
(function setupCapturesToggle() {
  const STORAGE_KEY = 'capturesPanelCollapsed';
  const panel = document.getElementById('capturesPanel');
  const btn = document.getElementById('capturesToggle');
  if (!panel || !btn) return;
  function apply(collapsed) {
    panel.classList.toggle('collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.title = collapsed ? 'Expand panel' : 'Collapse panel';
    btn.setAttribute('aria-label', collapsed ? 'Expand captures panel' : 'Collapse captures panel');
  }
  if (localStorage.getItem(STORAGE_KEY) === '1') apply(true);
  btn.addEventListener('click', () => {
    const collapsed = !panel.classList.contains('collapsed');
    apply(collapsed);
    localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
    // Fallback in case no width transition fires (e.g. reduced motion).
    setTimeout(() => map.invalidateSize(), 250);
  });
  panel.addEventListener('transitionend', event => {
    if (event.propertyName === 'width') map.invalidateSize();
  });
})();

// ---- Mobile segmented panel switcher ----
function setMobilePanel(panel) {
  mapPageEl.dataset.mobilePanel = panel;
  document.querySelectorAll('.mobile-switch .seg').forEach(seg => {
    seg.classList.toggle('active', seg.dataset.panel === panel);
  });
  if (panel === 'map') setTimeout(() => map.invalidateSize(), 50);
}
document.querySelectorAll('.mobile-switch .seg').forEach(seg => {
  seg.addEventListener('click', () => setMobilePanel(seg.dataset.panel));
});
function isMobileLayout() { return window.matchMedia('(max-width: 820px)').matches; }

// Initial state.
renderCaptureList();
if (isMobileLayout()) setMobilePanel('captures');
