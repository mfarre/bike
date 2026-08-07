"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_VIEW = { center: [46.8, 8.25], zoom: 8 };

const TERRAIN = {
  descent: { label: "Descent", color: "#2f9e44" },
  flat: { label: "Flat / rolling", color: "#7a8288" },
  climb: { label: "Climb", color: "#e0a800" },
  strongClimb: { label: "Strong climb", color: "#d62828" },
  unknown: { label: "No elevation", color: "#1769aa" },
};

const SLOPE = {
  smoothingWindowKm: 0.12,
  descentBelowPct: -2,
  climbAbovePct: 2,
  strongClimbAbovePct: 10,
};

const elements = {
  routeList: document.getElementById("route-list"),
  routeCount: document.getElementById("route-count"),
  listMessage: document.getElementById("list-message"),
  trackTitle: document.getElementById("track-title"),
  trackMeta: document.getElementById("track-meta"),
  downloadLink: document.getElementById("download-link"),
  mapStatus: document.getElementById("map-status"),
  profile: document.getElementById("elevation-profile"),
  profileSummary: document.getElementById("profile-summary"),
};

const state = {
  tracks: [],
  selectedFile: null,
  routeLayers: L.featureGroup(),
  hoverMarker: null,
  requestController: null,
};

const map = L.map("map", {
  preferCanvas: true,
  zoomControl: true,
}).setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

state.routeLayers.addTo(map);
showProfileMessage("Choose a route to see its elevation profile.");

window.addEventListener("popstate", () => {
  const requestedFile = new URL(window.location.href).searchParams.get("track");
  const track = state.tracks.find((item) => item.file === requestedFile);
  if (track && track.file !== state.selectedFile) {
    void selectTrack(track, { updateUrl: false });
  }
});

void initialise();

async function initialise() {
  try {
    const response = await fetch("./tracks.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`tracks.json returned HTTP ${response.status}`);
    }

    const manifest = await response.json();
    state.tracks = Array.isArray(manifest) ? manifest : manifest.tracks;

    if (!Array.isArray(state.tracks)) {
      throw new Error("tracks.json has an invalid format");
    }

    renderRouteList();

    if (state.tracks.length === 0) {
      elements.routeCount.textContent = "0 routes";
      showListMessage("No GPX files found. Add one to the tracks folder and push again.");
      showMapStatus("No GPX files found.");
      return;
    }

    elements.routeCount.textContent = `${state.tracks.length} ${state.tracks.length === 1 ? "route" : "routes"}`;

    const requestedFile = new URL(window.location.href).searchParams.get("track");
    const initialTrack = state.tracks.find((item) => item.file === requestedFile) ?? state.tracks[0];
    await selectTrack(initialTrack, { updateUrl: requestedFile !== initialTrack.file });
  } catch (error) {
    console.error(error);
    elements.routeCount.textContent = "Could not load routes";
    showListMessage("The route index could not be loaded. Check the latest GitHub Actions run.", true);
    showMapStatus("Could not load tracks.json.", true);
  }
}

function renderRouteList() {
  elements.routeList.replaceChildren();

  for (const track of state.tracks) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "route-button";
    button.dataset.file = track.file;
    button.setAttribute("aria-current", "false");

    const date = document.createElement("span");
    date.className = "route-date";
    date.textContent = formatDate(track.addedAt);

    const separator = document.createTextNode(" - ");
    const title = document.createElement("span");
    title.textContent = track.title;

    button.append(date, separator, title);
    button.addEventListener("click", () => void selectTrack(track, { updateUrl: true }));
    elements.routeList.append(button);
  }
}

async function selectTrack(track, { updateUrl }) {
  if (!track || !track.file) {
    return;
  }

  state.selectedFile = track.file;
  markSelectedRoute(track.file);
  elements.trackTitle.textContent = track.title;
  elements.trackMeta.textContent = `${formatDate(track.addedAt)} · Loading…`;
  elements.downloadLink.hidden = true;
  elements.profileSummary.textContent = "Loading…";
  showProfileMessage("Loading elevation data…");
  showMapStatus("Loading route…");

  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set("track", track.file);
    window.history.pushState({}, "", url);
  }

  if (state.requestController) {
    state.requestController.abort();
  }
  state.requestController = new AbortController();

  const trackUrl = encodeRelativePath(track.file);

  try {
    const response = await fetch(trackUrl, {
      cache: "no-store",
      signal: state.requestController.signal,
    });

    if (!response.ok) {
      throw new Error(`${track.file} returned HTTP ${response.status}`);
    }

    const gpxText = await response.text();
    const parsed = parseGpx(gpxText);

    if (state.selectedFile !== track.file) {
      return;
    }

    drawRoute(parsed);
    drawElevationProfile(parsed.profilePoints);

    const stats = formatStats(parsed);
    elements.trackMeta.textContent = `${formatDate(track.addedAt)} · ${stats}`;
    elements.profileSummary.textContent = elevationSummary(parsed);
    elements.downloadLink.href = trackUrl;
    elements.downloadLink.download = track.file.split("/").pop() || "route.gpx";
    elements.downloadLink.hidden = false;
    hideMapStatus();
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }

    console.error(error);
    clearRoute();
    elements.trackMeta.textContent = `${formatDate(track.addedAt)} · Could not load GPX`;
    elements.profileSummary.textContent = "Unavailable";
    showProfileMessage("This GPX file could not be parsed or contains no track points.");
    showMapStatus("Could not display this GPX file.", true);
  }
}

function parseGpx(gpxText) {
  const xml = new DOMParser().parseFromString(gpxText, "application/xml");
  if (xml.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Invalid GPX XML");
  }

  let segments = Array.from(xml.getElementsByTagNameNS("*", "trkseg"))
    .map((segment) => Array.from(segment.getElementsByTagNameNS("*", "trkpt")).map(parsePoint).filter(Boolean))
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    const routePoints = Array.from(xml.getElementsByTagNameNS("*", "rtept")).map(parsePoint).filter(Boolean);
    if (routePoints.length > 0) {
      segments = [routePoints];
    }
  }

  if (segments.length === 0) {
    throw new Error("No trkpt or rtept elements found");
  }

  let totalDistanceKm = 0;
  let elevationGainM = 0;
  let pointCount = 0;
  const profilePoints = [];

  for (const segment of segments) {
    let previousPoint = null;
    let previousElevation = null;

    for (const point of segment) {
      if (previousPoint) {
        totalDistanceKm += haversineKm(previousPoint, point);
      }

      point.distanceKm = totalDistanceKm;

      if (Number.isFinite(point.elevation)) {
        if (Number.isFinite(previousElevation)) {
          const climb = point.elevation - previousElevation;
          if (climb > 1) {
            elevationGainM += climb;
          }
        }
        previousElevation = point.elevation;
        profilePoints.push(point);
      }

      previousPoint = point;
      pointCount += 1;
    }
  }

  annotateTerrain(profilePoints);

  return {
    segments,
    profilePoints,
    totalDistanceKm,
    elevationGainM,
    pointCount,
  };
}

function annotateTerrain(points) {
  if (points.length < 2) {
    return;
  }

  const halfWindow = SLOPE.smoothingWindowKm / 2;
  let left = 0;
  let right = 0;

  for (let index = 0; index < points.length; index += 1) {
    const centerDistance = points[index].distanceKm;

    while (left < index && points[left + 1].distanceKm <= centerDistance - halfWindow) {
      left += 1;
    }

    right = Math.max(right, index);
    while (right + 1 < points.length && points[right].distanceKm < centerDistance + halfWindow) {
      right += 1;
    }

    let before = left;
    let after = right;

    if (before === after) {
      if (before > 0) before -= 1;
      if (after + 1 < points.length) after += 1;
    }

    const horizontalM = (points[after].distanceKm - points[before].distanceKm) * 1000;
    if (horizontalM < 5) {
      points[index].slopePct = 0;
      points[index].terrainCategory = "flat";
      continue;
    }

    const slopePct = ((points[after].elevation - points[before].elevation) / horizontalM) * 100;
    points[index].slopePct = slopePct;
    points[index].terrainCategory = terrainCategory(slopePct);
  }
}

function terrainCategory(slopePct) {
  if (slopePct < SLOPE.descentBelowPct) return "descent";
  if (slopePct > SLOPE.strongClimbAbovePct) return "strongClimb";
  if (slopePct > SLOPE.climbAbovePct) return "climb";
  return "flat";
}

function terrainRuns(segment) {
  if (segment.length < 2) return [];

  const runs = [];
  let current = null;

  for (let index = 1; index < segment.length; index += 1) {
    const first = segment[index - 1];
    const second = segment[index];
    const category = second.terrainCategory ?? first.terrainCategory ?? "unknown";

    if (!current || current.category !== category) {
      current = { category, points: [first, second] };
      runs.push(current);
    } else {
      current.points.push(second);
    }
  }

  return runs;
}

function parsePoint(node) {
  const latitude = Number.parseFloat(node.getAttribute("lat"));
  const longitude = Number.parseFloat(node.getAttribute("lon"));

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  const elevationNode = Array.from(node.children).find((child) => child.localName === "ele");
  const elevation = elevationNode ? Number.parseFloat(elevationNode.textContent) : Number.NaN;

  return {
    latitude,
    longitude,
    elevation,
  };
}

function drawRoute(parsed) {
  clearRoute();

  for (const segment of parsed.segments) {
    for (const run of terrainRuns(segment)) {
      const latLngs = run.points.map((point) => [point.latitude, point.longitude]);
      const style = TERRAIN[run.category] ?? TERRAIN.unknown;
      const slopes = run.points.map((point) => point.slopePct).filter(Number.isFinite);
      const averageSlope = slopes.length ? slopes.reduce((sum, value) => sum + value, 0) / slopes.length : null;

      const line = L.polyline(latLngs, {
        color: style.color,
        weight: run.category === "strongClimb" ? 6 : 5,
        opacity: 0.94,
        lineCap: "round",
        lineJoin: "round",
      });

      if (averageSlope !== null) {
        line.bindTooltip(`${style.label} · ${averageSlope.toFixed(1)}%`, { sticky: true });
      } else {
        line.bindTooltip(style.label, { sticky: true });
      }

      line.addTo(state.routeLayers);
    }
  }

  const firstPoint = parsed.segments[0][0];
  const lastSegment = parsed.segments[parsed.segments.length - 1];
  const lastPoint = lastSegment[lastSegment.length - 1];

  L.circleMarker([firstPoint.latitude, firstPoint.longitude], {
    radius: 6,
    color: "#ffffff",
    weight: 2,
    fillColor: "#18864b",
    fillOpacity: 1,
  }).bindTooltip("Start").addTo(state.routeLayers);

  L.circleMarker([lastPoint.latitude, lastPoint.longitude], {
    radius: 6,
    color: "#ffffff",
    weight: 2,
    fillColor: "#b54032",
    fillOpacity: 1,
  }).bindTooltip("Finish").addTo(state.routeLayers);

  const bounds = state.routeLayers.getBounds();
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 17 });
  }
}

function clearRoute() {
  state.routeLayers.clearLayers();
  if (state.hoverMarker) {
    map.removeLayer(state.hoverMarker);
    state.hoverMarker = null;
  }
}

function drawElevationProfile(points) {
  elements.profile.replaceChildren();

  if (points.length < 2) {
    showProfileMessage("This GPX file has no usable elevation data.");
    return;
  }

  const width = Math.max(Math.round(elements.profile.clientWidth), 320);
  const height = 220;
  const margin = { top: 18, right: 18, bottom: 34, left: 62 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const maxDistance = Math.max(points[points.length - 1].distanceKm, 0.001);
  let rawMin = Number.POSITIVE_INFINITY;
  let rawMax = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    rawMin = Math.min(rawMin, point.elevation);
    rawMax = Math.max(rawMax, point.elevation);
  }
  const elevationRange = Math.max(rawMax - rawMin, 20);
  const minElevation = rawMin - elevationRange * 0.08;
  const maxElevation = rawMax + elevationRange * 0.08;

  const x = (distanceKm) => margin.left + (distanceKm / maxDistance) * plotWidth;
  const y = (elevation) => margin.top + ((maxElevation - elevation) / (maxElevation - minElevation)) * plotHeight;

  const svg = svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    "aria-hidden": "true",
  });

  const gridValues = [rawMax, (rawMax + rawMin) / 2, rawMin];
  for (const value of gridValues) {
    const gridY = y(value);
    svg.append(svgElement("line", {
      class: "profile-grid",
      x1: margin.left,
      x2: width - margin.right,
      y1: gridY,
      y2: gridY,
    }));

    const label = svgElement("text", {
      class: "profile-axis-label",
      x: margin.left - 10,
      y: gridY + 4,
      "text-anchor": "end",
    });
    label.textContent = `${Math.round(value)} m`;
    svg.append(label);
  }

  const startLabel = svgElement("text", {
    class: "profile-axis-label",
    x: margin.left,
    y: height - 9,
    "text-anchor": "start",
  });
  startLabel.textContent = "0 km";
  svg.append(startLabel);

  const endLabel = svgElement("text", {
    class: "profile-axis-label",
    x: width - margin.right,
    y: height - 9,
    "text-anchor": "end",
  });
  endLabel.textContent = `${maxDistance.toFixed(maxDistance < 10 ? 1 : 0)} km`;
  svg.append(endLabel);

  const chartPoints = downsampleProfile(points, Math.max(Math.round(plotWidth * 2), 600));
  const linePath = chartPoints
    .map((point, index) => `${index === 0 ? "M" : "L"} ${x(point.distanceKm).toFixed(2)} ${y(point.elevation).toFixed(2)}`)
    .join(" ");

  const areaPath = `${linePath} L ${x(maxDistance).toFixed(2)} ${(margin.top + plotHeight).toFixed(2)} L ${margin.left} ${(margin.top + plotHeight).toFixed(2)} Z`;
  svg.append(svgElement("path", { class: "profile-area", d: areaPath }));
  svg.append(svgElement("path", { class: "profile-line-base", d: linePath }));

  for (const run of terrainRuns(chartPoints)) {
    const path = run.points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${x(point.distanceKm).toFixed(2)} ${y(point.elevation).toFixed(2)}`)
      .join(" ");
    const style = TERRAIN[run.category] ?? TERRAIN.unknown;
    svg.append(svgElement("path", {
      class: "profile-terrain-line",
      d: path,
      stroke: style.color,
    }));
  }

  const hoverLine = svgElement("line", {
    class: "profile-hover-line",
    y1: margin.top,
    y2: margin.top + plotHeight,
    hidden: "",
  });
  const hoverDot = svgElement("circle", {
    class: "profile-hover-dot",
    r: 5,
    hidden: "",
  });
  const tooltipBackground = svgElement("rect", {
    class: "profile-tooltip-bg",
    width: 176,
    height: 28,
    rx: 5,
    hidden: "",
  });
  const tooltipText = svgElement("text", {
    class: "profile-tooltip-text",
    y: 19,
    "text-anchor": "middle",
    hidden: "",
  });

  svg.append(hoverLine, hoverDot, tooltipBackground, tooltipText);

  const hitArea = svgElement("rect", {
    class: "profile-hit-area",
    x: margin.left,
    y: margin.top,
    width: plotWidth,
    height: plotHeight,
  });

  hitArea.addEventListener("pointermove", (event) => {
    const bounds = svg.getBoundingClientRect();
    const viewBoxX = ((event.clientX - bounds.left) / bounds.width) * width;
    const distanceKm = clamp(((viewBoxX - margin.left) / plotWidth) * maxDistance, 0, maxDistance);
    const point = closestProfilePoint(points, distanceKm);
    const pointX = x(point.distanceKm);
    const pointY = y(point.elevation);

    hoverLine.removeAttribute("hidden");
    hoverDot.removeAttribute("hidden");
    tooltipBackground.removeAttribute("hidden");
    tooltipText.removeAttribute("hidden");

    hoverLine.setAttribute("x1", pointX);
    hoverLine.setAttribute("x2", pointX);
    hoverDot.setAttribute("cx", pointX);
    hoverDot.setAttribute("cy", pointY);

    const tooltipX = clamp(pointX, margin.left + 88, width - margin.right - 88);
    const tooltipY = clamp(pointY - 39, margin.top, margin.top + plotHeight - 28);
    tooltipBackground.setAttribute("x", tooltipX - 88);
    tooltipBackground.setAttribute("y", tooltipY);
    tooltipText.setAttribute("x", tooltipX);
    tooltipText.setAttribute("y", tooltipY + 19);
    tooltipText.textContent = `${point.distanceKm.toFixed(1)} km · ${Math.round(point.elevation)} m · ${Number.isFinite(point.slopePct) ? `${point.slopePct.toFixed(1)}%` : "—"}`;

    showHoverPoint(point);
  });

  hitArea.addEventListener("pointerleave", () => {
    hoverLine.setAttribute("hidden", "");
    hoverDot.setAttribute("hidden", "");
    tooltipBackground.setAttribute("hidden", "");
    tooltipText.setAttribute("hidden", "");
    if (state.hoverMarker) {
      map.removeLayer(state.hoverMarker);
      state.hoverMarker = null;
    }
  });

  svg.append(hitArea);
  elements.profile.append(svg);
}

function showHoverPoint(point) {
  if (!state.hoverMarker) {
    state.hoverMarker = L.circleMarker([point.latitude, point.longitude], {
      radius: 5,
      color: "#17202a",
      weight: 2,
      fillColor: "#ffffff",
      fillOpacity: 1,
      interactive: false,
    }).addTo(map);
  } else {
    state.hoverMarker.setLatLng([point.latitude, point.longitude]);
  }
}

function downsampleProfile(points, maximumPoints) {
  if (points.length <= maximumPoints) {
    return points;
  }

  const sampled = [points[0]];
  const step = (points.length - 1) / (maximumPoints - 1);
  for (let index = 1; index < maximumPoints - 1; index += 1) {
    sampled.push(points[Math.round(index * step)]);
  }
  sampled.push(points[points.length - 1]);
  return sampled;
}

function closestProfilePoint(points, targetDistanceKm) {
  let low = 0;
  let high = points.length - 1;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].distanceKm < targetDistanceKm) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  if (low === 0) {
    return points[0];
  }

  const before = points[low - 1];
  const after = points[low];
  return targetDistanceKm - before.distanceKm <= after.distanceKm - targetDistanceKm ? before : after;
}

function formatStats(parsed) {
  const parts = [`${formatDistance(parsed.totalDistanceKm)}`, `${Math.round(parsed.elevationGainM)} m ascent`];
  return parts.join(" · ");
}

function elevationSummary(parsed) {
  if (parsed.profilePoints.length < 2) {
    return `${formatDistance(parsed.totalDistanceKm)} · No elevation data`;
  }
  return `${formatDistance(parsed.totalDistanceKm)} · ${Math.round(parsed.elevationGainM)} m ascent`;
}

function formatDistance(distanceKm) {
  return `${distanceKm.toFixed(distanceKm < 10 ? 1 : 0)} km`;
}

function formatDate(value) {
  if (typeof value !== "string" || value.length < 10) {
    return "Unknown date";
  }
  return value.slice(0, 10);
}

function markSelectedRoute(file) {
  for (const button of elements.routeList.querySelectorAll(".route-button")) {
    button.setAttribute("aria-current", button.dataset.file === file ? "true" : "false");
  }
}

function showListMessage(message, isError = false) {
  elements.listMessage.textContent = message;
  elements.listMessage.style.color = isError ? "var(--danger)" : "";
  elements.listMessage.hidden = false;
}

function showMapStatus(message, isError = false) {
  elements.mapStatus.textContent = message;
  elements.mapStatus.classList.toggle("error", isError);
  elements.mapStatus.hidden = false;
}

function hideMapStatus() {
  elements.mapStatus.hidden = true;
  elements.mapStatus.classList.remove("error");
}

function showProfileMessage(message) {
  elements.profile.replaceChildren();
  const placeholder = document.createElement("div");
  placeholder.className = "profile-placeholder";
  placeholder.textContent = message;
  elements.profile.append(placeholder);
}

function encodeRelativePath(path) {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function haversineKm(first, second) {
  const earthRadiusKm = 6371.0088;
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const deltaLatitude = toRadians(second.latitude - first.latitude);
  const deltaLongitude = toRadians(second.longitude - first.longitude);
  const latitude1 = toRadians(first.latitude);
  const latitude2 = toRadians(second.latitude);

  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function svgElement(tagName, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tagName);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}
