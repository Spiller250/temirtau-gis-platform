# 🗺️ Web-GIS Platform: GIS Control & Repair Works (Temirtau)

An interactive geographic information system (GIS) designed for monitoring urban infrastructure, playgrounds, repair and restoration works (RVR), and administrative sectors in Temirtau.

---

## 🚀 Key Features

* **Multi-Segment Map Control**:
* **GIS Control**: Visualization of cadastral boundaries, playgrounds, and administrative sectors.
* **Repair Works (RVR)**: Tracking repair sites, registering defects, and monitoring work completion status.
* **Waste Management**: Integration with the container yard registry and collection history.


* **Administrative Tools**:
* **Polygon Drawing**: Interactive area creation with automatic centroid calculation and optional point-marker generation.
* **Point Placement**: Marker positioning via direct map clicks.
* **Editing & Deletion**: Modifying names, surface area values, cadastral numbers, and descriptions.


* **Interactive Floating Card**:
* Dynamically anchored to map objects during panning, zooming, and rotation.
* Photo attachment support (up to 2 photos per object) with client-side WebP compression and uploads to Firebase Storage.


* **Filtering & Task Management**:
* Filtering repair sites based on pending tasks (e.g., painting, sand filling).
* Status highlighting and administrative task toggles.


* **Spatial Analysis & Registry**:
* Automatic grouping of objects into microdistricts/sectors using a **Point-in-Polygon** (Ray-Casting) algorithm.
* Bulk export and clipboard copying of sector addresses and registry data.
* Walking route generation for residential yards integrated with **Google Maps Directions API**.


* **Bilingual Interface (i18n)**:
* Dynamic language switching with automatic translation of key terms (Russian / Kazakh).


* **Data Synchronization**:
* Hybrid operation: Real-time **Firebase Firestore** updates with automatic fallback to `localStorage` when offline.



---

## 🛠️ Tech Stack

* **Frontend**: HTML5, CSS3 (Custom CSS variables), Vanilla JavaScript (ES6+).
* **Map Engine**: [Leaflet.js](https://leafletjs.com/) (Markers, Polygons, Layers, Geo-events).
* **Backend / Database**:
* **Firebase Firestore** (Real-time DB for storing overrides and new objects).
* **Firebase Storage** (Photo storage).


* **Client Persistence**: `localStorage` (for offline resilience).

---

## 📁 Project Structure

```text
.
├── index.html              # Main page, DOM layout, control panels, map container
├── multi-sections.js       # Core GIS module (UI logic, event listeners, Firestore, Leaflet integration)
├── gis-control-data.js     # Static dataset for GIS Control (window.GIS_CONTROL_DATA)
├── repair-works-data.js    # Static dataset for Repair Works (window.REPAIR_WORKS_DATA)
└── README.md               # Documentation

```

---

## ⚠️ Script Loading Order

`multi-sections.js` relies on global context variables (`window.map`, `window.db`, static data objects). In `index.html`, scripts **must** be loaded in this exact sequence:

```html
<!-- 1. Leaflet & Firebase SDKs -->
<script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>
<script src="https://www.gstatic.com/firebasejs/.../firebase-app.js"></script>
<script src="https://www.gstatic.com/firebasejs/.../firebase-firestore.js"></script>
<script src="https://www.gstatic.com/firebasejs/.../firebase-storage.js"></script>

<!-- 2. Static Data Files -->
<script src="gis-control-data.js"></script>
<script src="repair-works-data.js"></script>

<!-- 3. Map Initialization (Instantiates `window.map`) -->
<script src="main-map-init.js"></script>

<!-- 4. Core GIS Application Logic -->
<script src="multi-sections.js"></script>

```

---

## 📊 Feature Data Schema

Objects in `window.GIS_CONTROL_DATA`, `window.REPAIR_WORKS_DATA`, and Firestore collections must follow this structure:

```json
{
  "id": "repair-0001",
  "name": "№66 — 3rd A Microdistrict...",
  "folder": "Cadastral Zones",
  "description": "Defect details, area size, cadastral numbers...",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[
      {"lat": 50.063155, "lng": 72.953948},
      {"lat": 50.063261, "lng": 72.953870}
    ]]
  },
  "style": {
    "color": "#a52714",
    "opacity": 1,
    "fillColor": "#a52714",
    "fillOpacity": 0.12,
    "weight": 2
  },
  "tasks": {
    "paint": false,
    "sand": true
  },
  "photo1Url": "https://...",
  "photo2Url": "https://..."
}

```

> **Firestore Geometry Note**: Because Firestore restricts deeply nested array structures inside objects, the `geometry` object is serialized (`JSON.stringify(geometry)`) prior to database writes and parsed back into an object upon retrieval.

---

## 🔧 Setup & Local Development

1. Clone the repository:
```bash
git clone https://github.com/your-org/temirtau-gis-map.git

```


2. Place `gis-control-data.js` and `repair-works-data.js` in the root directory alongside `index.html`.
3. Ensure your Firebase configuration is initialized so that `db` (Firestore) and `firebase.storage()` are accessible in the global scope.
4. Serve the directory using a local web server (e.g., Live Server in VS Code or `python -m http.server 8000`).