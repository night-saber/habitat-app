# Habitat — Property, organised

A web app that connects **property owners** with **trade workers**, so tasks travel as photos and pinned locations instead of texts and guesswork.

## Features

- **Photo Tasks** — Take a photo, describe what needs doing, pin it to the map
- **Live Map** — See every task and property on a map. Tap to add new tasks
- **Trade Workers** — Plumbing, electrical, HVAC, roofing, landscaping
- **Crews** — Group workers and assign them to properties
- **Mobile Ready** — Install as a PWA, works offline
- **Private & Secure** — Data stays in your browser, no server

## Try It

Open `index.html` in a browser, or serve with:

```bash
python -m http.server 8000
```

Click **Try Demo** to explore with sample data.

## Tech

- Vanilla JS (ES modules)
- Leaflet + OpenStreetMap for maps
- localStorage for data
- PWA with service worker
