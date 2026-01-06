import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  Bookmark,
  CircleStop,
  ChevronLeft,
  ChevronRight,
  Check,
  Expand,
  History,
  Loader2,
  RefreshCw,
  Star,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/use-mobile";

const formatCoord = (value) => value.toFixed(4);

type SavedPlace = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  summary: string;
  images: string[];
  sources: string[];
  placesGroups: unknown[];
  placesError?: string;
  placesStatus?: string;
  weather?: unknown;
  weatherStatus?: string;
  weatherError?: string;
  image?: string;
  savedAt: number;
};

type SidebarMode = "details" | "bookmarks" | "history";

const BOOKMARKS_STORAGE_KEY = "geoplexer.bookmarks";
const HISTORY_STORAGE_KEY = "geoplexer.history";
const PLACE_CACHE_RADIUS_METERS = 1000;
const PLACE_NAME_RADIUS_METERS = 10_000;
const HISTORY_LIMIT = 40;
const SUMMARY_SNIPPET_LENGTH = 220;

const buildPlaceId = (lat, lng) => `${lat.toFixed(4)},${lng.toFixed(4)}`;

const truncateText = (value, maxLength) => {
  if (!value) return "";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trimEnd()}...`;
};

const stripCitationMarkers = (value) =>
  value.replace(/\[\d+\]/g, "").replace(/\s{2,}/g, " ").trim();

const stripMarkdown = (value) => {
  if (!value) return "";
  let output = value;
  output = output.replace(/!\[[^\]]*]\([^)]*\)/g, "");
  output = output.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  output = output.replace(/`([^`]+)`/g, "$1");
  output = output.replace(/\*\*(.*?)\*\*/g, "$1");
  output = output.replace(/__(.*?)__/g, "$1");
  output = output.replace(/\*(.*?)\*/g, "$1");
  output = output.replace(/_(.*?)_/g, "$1");
  output = output.replace(/~~(.*?)~~/g, "$1");
  output = output.replace(/<[^>]+>/g, "");
  return output.replace(/\s{2,}/g, " ").trim();
};

const loadStoredPlaces = (key) => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item === "object");
  } catch {
    return [];
  }
};

const saveStoredPlaces = (key, value) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures.
  }
};

const normalizePlaceKey = (value) =>
  typeof value === "string"
    ? value.trim().toLowerCase().replace(/\s+/g, " ")
    : "";

const normalizeGroupKey = (value) =>
  typeof value === "string"
    ? value.trim().toLowerCase().replace(/\s+/g, " ")
    : "";

const getPlaceNameKey = (place) => {
  if (!place || typeof place !== "object") return "";
  return normalizePlaceKey(place.title) || normalizePlaceKey(place.id) || "";
};

const distanceMeters = (a, b) => {
  if (!a || !b) return Infinity;
  const lat1 = a.lat;
  const lng1 = a.lng;
  const lat2 = b.lat;
  const lng2 = b.lng;
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return Infinity;
  }
  const toRad = (value) => (value * Math.PI) / 180;
  const radius = 6_371_000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const latRad1 = toRad(lat1);
  const latRad2 = toRad(lat2);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat + Math.cos(latRad1) * Math.cos(latRad2) * sinLng * sinLng;
  return 2 * radius * Math.asin(Math.sqrt(h));
};

const isSamePlaceByRadius = (a, b, radius = PLACE_CACHE_RADIUS_METERS) => {
  const distance = distanceMeters(a, b);
  return Number.isFinite(distance) && distance <= radius;
};

const isSamePlaceByName = (a, b) => {
  const keyA = getPlaceNameKey(a);
  const keyB = getPlaceNameKey(b);
  return Boolean(keyA && keyB && keyA === keyB);
};

const isSamePlaceForLists = (a, b) =>
  isSamePlaceByRadius(a, b) ||
  (isSamePlaceByName(a, b) &&
    isSamePlaceByRadius(a, b, PLACE_NAME_RADIUS_METERS));

const isSamePlaceForCache = (a, b) => isSamePlaceByRadius(a, b);

const dedupePlaces = (places) => {
  const next = [];
  places.forEach((place) => {
    const hasDuplicate = next.some((existing) =>
      isSamePlaceForLists(existing, place),
    );
    if (hasDuplicate) return;
    next.push(place);
  });
  return next;
};

const joinLabel = (parts) => parts.filter(Boolean).join(", ");

const buildRawLabel = (feature) => {
  if (!feature || typeof feature !== "object") return "";
  const properties =
    feature?.properties && typeof feature.properties === "object"
      ? feature.properties
      : {};
  return (
    properties.full_address ||
    properties.place_formatted ||
    feature?.place_name ||
    properties.name_preferred ||
    properties.name ||
    ""
  );
};

const buildContextLabel = (feature) => {
  if (!feature || typeof feature !== "object") return "";
  const properties =
    feature?.properties && typeof feature.properties === "object"
      ? feature.properties
      : {};
  const context =
    properties.context && typeof properties.context === "object"
      ? properties.context
      : {};
  const localityName = context.locality?.name;
  const placeName = context.place?.name;
  const regionName = context.region?.name;
  const countryName = context.country?.name;

  if (localityName && placeName && countryName && countryName !== "Japan") {
    return joinLabel([localityName, placeName, countryName]);
  }
  const neighborhoodName = context.neighborhood?.name;
  if (neighborhoodName && placeName && countryName && countryName !== "Japan") {
    return joinLabel([neighborhoodName, placeName, countryName]);
  }
  if (placeName && regionName && countryName) {
    return joinLabel([placeName, regionName, countryName]);
  }
  if (placeName && countryName) {
    return joinLabel([placeName, countryName]);
  }
  if (regionName && countryName) {
    return joinLabel([regionName, countryName]);
  }
  if (countryName) {
    return countryName;
  }
  return "";
};

const DEFAULT_INTEREST = {
  id: "attractions",
  label: "Attractions",
  query: "top tourist attractions",
};
const OPTIONAL_INTERESTS = [
  { id: "food", label: "Food", query: "top rated restaurants" },
  { id: "coffee", label: "Coffee", query: "top coffee shops" },
  { id: "museums", label: "Museums", query: "top museums" },
  { id: "parks", label: "Parks", query: "top parks" },
  { id: "landmarks", label: "Landmarks", query: "top landmarks" },
  { id: "shopping", label: "Shopping", query: "top shopping malls" },
  { id: "markets", label: "Markets", query: "top markets" },
  { id: "nightlife", label: "Nightlife", query: "top bars" },
  { id: "views", label: "Views", query: "top scenic viewpoints" },
];
const PLACES_ZOOM = 16;

const formatReviewCount = (value) => {
  if (typeof value !== "number" || Number.isNaN(value)) return "";
  return new Intl.NumberFormat("en", { notation: "compact" }).format(value);
};

const formatRating = (value) => {
  if (typeof value !== "number" || Number.isNaN(value)) return "";
  return value.toFixed(1);
};

const isAbortError = (error) =>
  error instanceof Error && error.name === "AbortError";

function CollapsedSidebarControl({ showChevron, onShowBookmarks, onShowHistory }) {
  const { state, toggleSidebar } = useSidebar();
  if (state !== "collapsed") return null;

  return (
    <div className="flex h-full flex-col items-center gap-2 px-2 py-4">
      {showChevron && (
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          onClick={toggleSidebar}
          aria-label="Expand sidebar"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9"
        onClick={onShowBookmarks}
        aria-label="Bookmarks"
      >
        <Bookmark className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9"
        onClick={onShowHistory}
        aria-label="Recently visited"
      >
        <History className="h-4 w-4" />
      </Button>
    </div>
  );
}

function SavedPlacesPanel({
  title,
  items,
  emptyLabel,
  onSelect,
  onClear,
  clearLabel,
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.25em] text-muted-foreground">
          {title}
        </div>
        {onClear && items.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] uppercase tracking-[0.2em]"
            onClick={onClear}
          >
            {clearLabel || "Clear"}
          </Button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-muted-foreground">{emptyLabel}</div>
      ) : (
        <div className="space-y-4">
          {items.map((item) => {
            const summaryText = truncateText(
              stripCitationMarkers(stripMarkdown(item.summary || "")),
              SUMMARY_SNIPPET_LENGTH,
            );
            const imageSrc =
              item.image ||
              (Array.isArray(item.images) ? item.images[0] : "") ||
              "";
            return (
              <button
                key={item.id}
                type="button"
                className="flex w-full flex-col gap-3 rounded-lg border border-border bg-background/70 p-4 text-left shadow-sm transition hover:shadow-md"
                onClick={() => onSelect?.(item)}
              >
                <div className="space-y-1">
                  <div className="text-base font-semibold text-foreground">
                    {item.title}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatCoord(item.lat)}, {formatCoord(item.lng)}
                  </div>
                </div>
                {imageSrc ? (
                  <img
                    src={imageSrc}
                    alt={item.title}
                    loading="lazy"
                    className="h-40 w-full rounded-md object-cover"
                  />
                ) : (
                  <div className="flex h-40 w-full items-center justify-center rounded-md border border-border/70 bg-muted/20 text-[11px] text-muted-foreground">
                    No image
                  </div>
                )}
                {summaryText ? (
                  <p className="text-sm text-muted-foreground">
                    {summaryText}
                  </p>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MobileSheetAutoOpen({ coords, isMobile }) {
  const {
    openMobile,
    setOpenMobile,
    resetMobileSheetHeight,
    setMobileSheetCollapsed,
  } = useSidebar();
  const lastCoordsRef = useRef("");

  useEffect(() => {
    if (!isMobile || !coords) return;
    const nextKey = `${coords.lng},${coords.lat}`;
    if (lastCoordsRef.current === nextKey) return;
    lastCoordsRef.current = nextKey;
    resetMobileSheetHeight();
    setMobileSheetCollapsed(true);
    if (!openMobile) {
      setOpenMobile(true);
    }
  }, [
    coords,
    isMobile,
    openMobile,
    resetMobileSheetHeight,
    setMobileSheetCollapsed,
    setOpenMobile,
  ]);

  return null;
}

function MobileSidebarHeader({ children }) {
  const { isMobile, mobileSheetCollapsed } = useSidebar();
  if (isMobile && mobileSheetCollapsed) return null;
  return children;
}

function SidebarDetailsPanel({ render, ...rest }) {
  const {
    isMobile,
    mobileSheetCollapsed,
    setMobileSheetCollapsed,
    setMobileSheetHeight,
    mobileSheetMaxHeight,
  } = useSidebar();

  const handleExpand = useCallback(() => {
    setMobileSheetCollapsed(false);
    setMobileSheetHeight(
      mobileSheetMaxHeight || Math.round(window.innerHeight * 0.85),
    );
  }, [mobileSheetMaxHeight, setMobileSheetCollapsed, setMobileSheetHeight]);

  return render({
    ...rest,
    mobileCollapsed: isMobile && mobileSheetCollapsed,
    onMobileExpand: handleExpand,
  });
}

function MobileLightboxCollapse({ isMobile, lightboxOpen, lightboxSource }) {
  const {
    mobileSheetHeight,
    mobileSheetCollapsed,
    mobileSheetMinHeight,
    resetMobileSheetHeight,
    setMobileSheetCollapsed,
    setMobileSheetHeight,
  } = useSidebar();
  const prevSheetStateRef = useRef({
    height: null,
    collapsed: null,
    armed: false,
  });

  useEffect(() => {
    if (!isMobile) return;
    const prevState = prevSheetStateRef.current;
    if (lightboxOpen && lightboxSource === "sidebar") {
      if (!prevState.armed) {
        prevState.height = mobileSheetHeight;
        prevState.collapsed = mobileSheetCollapsed;
        prevState.armed = true;
      }
      resetMobileSheetHeight();
      setMobileSheetCollapsed(true);
      return;
    }

    if (!lightboxOpen && prevState.armed) {
      if (typeof prevState.height === "number") {
        setMobileSheetHeight(prevState.height);
        if (
          typeof prevState.collapsed === "boolean" &&
          typeof mobileSheetMinHeight === "number"
        ) {
          const shouldCollapse = prevState.height <= mobileSheetMinHeight + 12;
          setMobileSheetCollapsed(prevState.collapsed || shouldCollapse);
        } else if (typeof prevState.collapsed === "boolean") {
          setMobileSheetCollapsed(prevState.collapsed);
        }
      }
      prevState.height = null;
      prevState.collapsed = null;
      prevState.armed = false;
    }
  }, [
    isMobile,
    lightboxOpen,
    lightboxSource,
    mobileSheetHeight,
    mobileSheetCollapsed,
    mobileSheetMinHeight,
    resetMobileSheetHeight,
    setMobileSheetCollapsed,
    setMobileSheetHeight,
  ]);

  return null;
}

export default function App() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const requestIdRef = useRef(0);
  const placesRequestIdRef = useRef(0);
  const aiAbortRef = useRef(null);
  const weatherAbortRef = useRef(null);
  const geoAbortRef = useRef(null);
  const placesAbortRef = useRef(null);
  const expandedGalleryRef = useRef(null);
  const bookmarksRef = useRef<SavedPlace[]>([]);
  const historyRef = useRef<SavedPlace[]>([]);

  const [status, setStatus] = useState("idle");
  const [coords, setCoords] = useState(null);
  const [summary, setSummary] = useState("");
  const [images, setImages] = useState([]);
  const [sources, setSources] = useState([]);
  const [placesGroups, setPlacesGroups] = useState([]);
  const [placesStatus, setPlacesStatus] = useState("idle");
  const [placesError, setPlacesError] = useState("");
  const [selectedInterests, setSelectedInterests] = useState([]);
  const [exploreModalOpen, setExploreModalOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(true);
  const [placesScrollState, setPlacesScrollState] = useState({});
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [lightboxSource, setLightboxSource] = useState(null);
  const [sidebarCarouselIndex, setSidebarCarouselIndex] = useState(0);
  const [expandedCarouselIndex, setExpandedCarouselIndex] = useState(0);
  const [expandedOpen, setExpandedOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("details");
  const [isCachedView, setIsCachedView] = useState(false);
  const [bookmarks, setBookmarks] = useState<SavedPlace[]>(() =>
    dedupePlaces(loadStoredPlaces(BOOKMARKS_STORAGE_KEY)),
  );
  const [history, setHistory] = useState<SavedPlace[]>(() =>
    dedupePlaces(loadStoredPlaces(HISTORY_STORAGE_KEY)),
  );
  const [weather, setWeather] = useState(null);
  const [weatherStatus, setWeatherStatus] = useState("idle");
  const [weatherError, setWeatherError] = useState("");
  const [placeName, setPlaceName] = useState("");
  const [geoStatus, setGeoStatus] = useState("idle");
  const [error, setError] = useState("");
  const [aiError, setAiError] = useState("");

  const isMobile = useIsMobile();
  const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN;
  const apiBaseUrl = useMemo(() => {
    if (import.meta.env.VITE_API_BASE_URL) {
      return import.meta.env.VITE_API_BASE_URL;
    }
    return import.meta.env.DEV ? "http://localhost:3000" : window.location.origin;
  }, []);
  const selectLocationRef = useRef(null);
  const placesRowRefs = useRef({});

  useEffect(() => {
    saveStoredPlaces(BOOKMARKS_STORAGE_KEY, bookmarks);
  }, [bookmarks]);

  useEffect(() => {
    saveStoredPlaces(HISTORY_STORAGE_KEY, history);
  }, [history]);

  useEffect(() => {
    setBookmarks((prev) => {
      const next = dedupePlaces(prev);
      if (next.length === prev.length && next.every((item, idx) => item === prev[idx])) {
        return prev;
      }
      return next;
    });
  }, [bookmarks]);

  useEffect(() => {
    setHistory((prev) => {
      const next = dedupePlaces(prev);
      if (next.length === prev.length && next.every((item, idx) => item === prev[idx])) {
        return prev;
      }
      return next;
    });
  }, [history]);

  useEffect(() => {
    bookmarksRef.current = bookmarks;
  }, [bookmarks]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const findCachedPlace = useCallback((lat, lng) => {
    const needle = { lat, lng };
    const matchKey = (item) => isSamePlaceForCache(item, needle);
    return (
      bookmarksRef.current.find(matchKey) ||
      historyRef.current.find(matchKey) ||
      null
    );
  }, []);

  const abortRequests = useCallback(() => {
    if (aiAbortRef.current) {
      aiAbortRef.current.abort();
      aiAbortRef.current = null;
    }
    if (weatherAbortRef.current) {
      weatherAbortRef.current.abort();
      weatherAbortRef.current = null;
    }
    if (geoAbortRef.current) {
      geoAbortRef.current.abort();
      geoAbortRef.current = null;
    }
    if (placesAbortRef.current) {
      placesAbortRef.current.abort();
      placesAbortRef.current = null;
    }
  }, []);

  const resetSelection = useCallback(() => {
    requestIdRef.current += 1;
    placesRequestIdRef.current += 1;
    abortRequests();
    setStatus("idle");
    setIsCachedView(false);
    setCoords(null);
    setGeoStatus("idle");
    setPlaceName("");
    setSummary("");
    setAiError("");
    setImages([]);
    setSources([]);
    setPlacesGroups([]);
    setPlacesStatus("idle");
    setPlacesError("");
    setSelectedInterests([]);
    setExploreModalOpen(false);
    setExploreOpen(true);
    setPlacesScrollState({});
    setSummaryOpen(true);
    setSourcesOpen(false);
    setLightboxOpen(false);
    setLightboxIndex(0);
    setLightboxSource(null);
    setSidebarCarouselIndex(0);
    setExpandedCarouselIndex(0);
    setExpandedOpen(false);
    setWeather(null);
    setWeatherStatus("idle");
    setWeatherError("");
    setSidebarMode("details");
    setSidebarOpen(false);
    if (markerRef.current) {
      markerRef.current.remove();
    }
  }, [abortRequests]);

  const runPlacesSearch = useCallback(
    async ({ lat, lng, interests, append = false }) => {
      if (typeof lat !== "number" || typeof lng !== "number") return;
      if (!Array.isArray(interests) || interests.length === 0) return;
      const requestId = ++placesRequestIdRef.current;
      if (placesAbortRef.current) {
        placesAbortRef.current.abort();
      }
      const placesController = new AbortController();
      placesAbortRef.current = placesController;
      const ll = `@${lat.toFixed(4)},${lng.toFixed(4)},${PLACES_ZOOM}z`;
      setPlacesStatus("loading");
      setPlacesError("");
      if (!append) {
        setPlacesGroups([]);
      }
      try {
        const response = await fetch(`${apiBaseUrl}/places`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lat,
            lng,
            zoom: PLACES_ZOOM,
            ll,
            interests,
          }),
          signal: placesController.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (requestId !== placesRequestIdRef.current) return;
        if (!response.ok) {
          const message =
            typeof payload?.error === "string"
              ? payload.error
              : "Places request failed.";
          throw new Error(message);
        }
        const nextGroups = Array.isArray(payload.groups) ? payload.groups : [];
        if (append) {
          setPlacesGroups((prev) => {
            const existing = Array.isArray(prev) ? prev : [];
            const byId = new Map(existing.map((group) => [group.id, group]));
            nextGroups.forEach((group) => {
              byId.set(group.id, group);
            });
            return Array.from(byId.values());
          });
        } else {
          setPlacesGroups(nextGroups);
        }
        const payloadError =
          typeof payload?.error === "string" ? payload.error : "";
        const hasDefault = interests.some(
          (interest) => interest.id === DEFAULT_INTEREST.id,
        );
        const hasResults = nextGroups.some(
          (group) => Array.isArray(group.places) && group.places.length > 0,
        );
        const shouldSurfaceError =
          payloadError && !append && hasDefault && !hasResults;
        if (shouldSurfaceError) {
          setPlacesError(payloadError);
          setPlacesStatus("error");
        } else {
          setPlacesError("");
          setPlacesStatus("ready");
        }
      } catch (err) {
        if (requestId !== placesRequestIdRef.current) return;
        if (isAbortError(err)) return;
        setPlacesError(
          err instanceof Error ? err.message : "Places request failed."
        );
        setPlacesStatus("error");
      }
    },
    [apiBaseUrl],
  );

  const updateRowScrollState = useCallback((key) => {
    const node = placesRowRefs.current[key];
    if (!node) return;
    const maxScrollLeft = Math.max(node.scrollWidth - node.clientWidth, 0);
    const canScrollLeft = node.scrollLeft > 4;
    const canScrollRight = node.scrollLeft < maxScrollLeft - 4;
    setPlacesScrollState((prev) => ({
      ...prev,
      [key]: { canScrollLeft, canScrollRight },
    }));
  }, []);

  const syncPlacesScrollState = useCallback(() => {
    const next = {};
    Object.entries(placesRowRefs.current).forEach(([key, node]) => {
      if (!node) return;
      const maxScrollLeft = Math.max(node.scrollWidth - node.clientWidth, 0);
      const canScrollLeft = node.scrollLeft > 4;
      const canScrollRight = node.scrollLeft < maxScrollLeft - 4;
      next[key] = { canScrollLeft, canScrollRight };
    });
    setPlacesScrollState(next);
  }, []);

  const displayPlaceName = useMemo(() => {
    if (!coords) return "No selection";
    if (geoStatus === "loading") return "Resolving place...";
    if (placeName) return placeName;
    return "Open ocean";
  }, [coords, geoStatus, placeName]);

  const optionalInterestsForModal = useMemo(() => {
    const keys = new Set();
    placesGroups.forEach((group) => {
      if (!group || typeof group !== "object") return;
      if (group.id) keys.add(normalizeGroupKey(group.id));
      if (group.label) keys.add(normalizeGroupKey(group.label));
      if (group.query) keys.add(normalizeGroupKey(group.query));
      if (group.name) keys.add(normalizeGroupKey(group.name));
      if (group.title) keys.add(normalizeGroupKey(group.title));
      if (group.category) keys.add(normalizeGroupKey(group.category));
    });
    return OPTIONAL_INTERESTS.filter((interest) => {
      const idKey = normalizeGroupKey(interest.id);
      const labelKey = normalizeGroupKey(interest.label);
      const queryKey = normalizeGroupKey(interest.query);
      return (
        !keys.has(idKey) &&
        !keys.has(labelKey) &&
        !keys.has(queryKey)
      );
    });
  }, [placesGroups]);

  const toggleInterest = useCallback((interestId) => {
    placesRequestIdRef.current += 1;
    setSelectedInterests((prev) => {
      if (prev.includes(interestId)) {
        return prev.filter((item) => item !== interestId);
      }
      return [...prev, interestId];
    });
    setPlacesError("");
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const isDark = media.matches;
      document.documentElement.classList.toggle("dark", isDark);
      document.documentElement.style.colorScheme = isDark ? "dark" : "light";
    };
    sync();
    if (media.addEventListener) {
      media.addEventListener("change", sync);
      return () => media.removeEventListener("change", sync);
    }
    media.addListener(sync);
    return () => media.removeListener(sync);
  }, []);

  useEffect(() => {
    if (isMobile && expandedOpen) {
      setExpandedOpen(false);
    }
  }, [isMobile, expandedOpen]);

  useEffect(() => {
    if (isMobile && sidebarMode !== "details") {
      setSidebarMode("details");
    }
  }, [isMobile, sidebarMode]);

  useEffect(() => {
    if (!placesGroups.length) {
      setPlacesScrollState({});
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      syncPlacesScrollState();
    });
    const handleResize = () => syncPlacesScrollState();
    window.addEventListener("resize", handleResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleResize);
    };
  }, [placesGroups, syncPlacesScrollState]);

  useEffect(() => {
    if (typeof window === "undefined" || images.length === 0) return;
    const preloaded = images.map((src) => {
      const img = new window.Image();
      img.decoding = "async";
      img.src = src;
      return img;
    });
    return () => {
      preloaded.forEach((img) => {
        img.src = "";
      });
    };
  }, [images]);

  const reverseGeocode = useCallback(
    async (lng, lat, signal) => {
      if (!mapboxToken) return "Open ocean";
      const url = new URL("https://api.mapbox.com/search/geocode/v6/reverse");
      url.searchParams.set("longitude", String(lng));
      url.searchParams.set("latitude", String(lat));
      url.searchParams.set("access_token", mapboxToken);
      url.searchParams.set("language", "en");
      url.searchParams.set("limit", "1");

      const response = await fetch(url, signal ? { signal } : undefined);
      if (!response.ok) {
        return "Open ocean";
      }
      const data = await response.json();
      const feature = data.features?.[0] ?? null;
      if (!feature) return "Open ocean";
      return (
        buildContextLabel(feature) ||
        buildRawLabel(feature) ||
        "Open ocean"
      );
    },
    [mapboxToken]
  );

  useEffect(() => {
    if (!mapboxToken) {
      setError("Missing VITE_MAPBOX_TOKEN in apps/web/.env");
      return;
    }

    const mapboxgl = window.mapboxgl;
    if (!mapboxgl || mapRef.current) return;

    mapboxgl.accessToken = mapboxToken;
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      projection: "globe",
      center: [0, 20],
      zoom: 1.25,
      pitch: 0,
    });

    map.on("style.load", () => {
      map.setFog({});
    });

    map.on("load", () => {
      map.resize();
    });

    map.addControl(new mapboxgl.NavigationControl());

    const marker = new mapboxgl.Marker({ color: "#0f172a" });
    markerRef.current = marker;

    const fetchAiSummary = async (lng, lat, bestLabel, signal) => {
      const response = await fetch(`${apiBaseUrl}/ai/point`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lat,
          lng,
          bestLabel,
          context: {},
        }),
        signal,
      });
      if (!response.ok) {
        throw new Error(`AI request failed (${response.status})`);
      }
      return response.json();
    };

    const handleSelectLocation = (lng, lat) => {
      abortRequests();
      const cached = findCachedPlace(lat, lng);
      if (cached) {
        applyCachedPlace(cached, { lng, lat });
        return;
      }
      setIsCachedView(false);
      setSidebarOpen(true);
      setSidebarMode("details");
      const requestId = ++requestIdRef.current;
      const geoController = new AbortController();
      const weatherController = new AbortController();
      const aiController = new AbortController();
      geoAbortRef.current = geoController;
      weatherAbortRef.current = weatherController;
      aiAbortRef.current = aiController;
      setStatus("loading");
      setCoords({ lng, lat });
      setGeoStatus("loading");
      setPlaceName("");
      setSummary("");
      setAiError("");
      setImages([]);
      setSources([]);
      setPlacesGroups([]);
      setPlacesStatus("idle");
      setPlacesError("");
      setSelectedInterests([]);
      setExploreModalOpen(false);
      setExploreOpen(true);
      setPlacesScrollState({});
      setSummaryOpen(true);
      setSourcesOpen(false);
      setLightboxOpen(false);
      setLightboxIndex(0);
      setLightboxSource(null);
      setSidebarCarouselIndex(0);
      setExpandedCarouselIndex(0);
      setExpandedOpen(false);
      setWeather(null);
      setWeatherStatus("loading");
      setWeatherError("");
      placesRequestIdRef.current += 1;

      marker.setLngLat([lng, lat]).addTo(map);
      map.flyTo({
        center: [lng, lat],
        zoom: Math.max(map.getZoom(), 9),
        duration: 1200,
      });

      if (!isMobile) {
        runPlacesSearch({
          lat,
          lng,
          interests: [
            {
              id: DEFAULT_INTEREST.id,
              label: DEFAULT_INTEREST.label,
              query: DEFAULT_INTEREST.query,
            },
          ],
        });
        setExploreModalOpen(false);
      }

      const weatherPromise = fetch(`${apiBaseUrl}/weather`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng }),
        signal: weatherController.signal,
      })
        .then((res) => {
          if (!res.ok) {
            throw new Error(`Weather request failed (${res.status})`);
          }
          return res.json();
        })
        .then((data) => {
          if (requestId !== requestIdRef.current) return;
          setWeather(data);
          setWeatherStatus("ready");
        })
        .catch((err) => {
          if (requestId !== requestIdRef.current) return;
          if (isAbortError(err)) return;
          setWeatherError(
            err instanceof Error ? err.message : "Weather request failed."
          );
          setWeatherStatus("error");
        });

      reverseGeocode(lng, lat, geoController.signal)
        .then((name) => {
          if (requestId !== requestIdRef.current) return null;
          setPlaceName(name);
          setGeoStatus("ready");
          return name;
        })
        .catch((err) => {
          if (requestId !== requestIdRef.current) return null;
          if (isAbortError(err)) return null;
          setPlaceName("Open ocean");
          setGeoStatus("error");
          return "Open ocean";
        })
        .then((bestLabel) => {
          if (!bestLabel || requestId !== requestIdRef.current) return;
          return fetchAiSummary(lng, lat, bestLabel, aiController.signal);
        })
        .then((data) => {
          if (!data || requestId !== requestIdRef.current) return;
          setSummary(
            typeof data.summary === "string" ? data.summary : "No summary found."
          );
          setImages(Array.isArray(data.images) ? data.images.slice(0, 6) : []);
          setSources(Array.isArray(data.sources) ? data.sources : []);
          setStatus("ready");
        })
        .catch((err) => {
          if (requestId !== requestIdRef.current) return;
          if (isAbortError(err)) return;
          setAiError(err instanceof Error ? err.message : "AI request failed.");
          setStatus("ready");
        });

      void weatherPromise;
    };

    selectLocationRef.current = handleSelectLocation;

    map.on("click", (event) => {
      const { lng, lat } = event.lngLat;
      handleSelectLocation(lng, lat);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [
    abortRequests,
    apiBaseUrl,
    mapboxToken,
    reverseGeocode,
    runPlacesSearch,
    isMobile,
  ]);

  const formatSourceLabel = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };

  const cleanedSummary = useMemo(() => {
    if (!summary) return "";
    const marker = "</think>";
    const idx = summary.lastIndexOf(marker);
    const trimmed =
      idx !== -1 ? summary.slice(idx + marker.length) : summary;
    return trimmed.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  }, [summary]);

  const buildSavedPlace = useCallback(() => {
    if (!coords) return null;
    const summaryText = cleanedSummary || summary || "Summary unavailable.";
    return {
      id: buildPlaceId(coords.lat, coords.lng),
      title: displayPlaceName || "Unknown location",
      lat: coords.lat,
      lng: coords.lng,
      summary: summaryText,
      images: Array.isArray(images) ? images : [],
      sources: Array.isArray(sources) ? sources : [],
      placesGroups: Array.isArray(placesGroups) ? placesGroups : [],
      placesError: placesError || "",
      placesStatus: placesStatus,
      weather: weather ?? null,
      weatherStatus: weatherStatus,
      weatherError: weatherError || "",
      image: images[0],
      savedAt: Date.now(),
    };
  }, [
    coords,
    cleanedSummary,
    summary,
    displayPlaceName,
    images,
    sources,
    placesGroups,
    placesError,
    placesStatus,
    weather,
    weatherStatus,
    weatherError,
  ]);

  const isBookmarked = useMemo(() => {
    if (!coords) return false;
    return bookmarks.some((item) => isSamePlaceForLists(item, coords));
  }, [bookmarks, coords]);

  const weatherKind = useMemo(() => {
    const code = weather?.current?.weather_code;
    if (typeof code !== "number") return "unknown";
    if (code === 0) return "clear";
    if ([1, 2, 3].includes(code)) return "partly";
    if ([45, 48].includes(code)) return "fog";
    if ([51, 53, 55, 56, 57].includes(code)) return "drizzle";
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
    if ([95, 96, 99].includes(code)) return "storm";
    return "unknown";
  }, [weather]);

  const WeatherIcon = ({ kind }) => {
    switch (kind) {
      case "clear":
        return (
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="4.5" />
            <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" />
          </svg>
        );
      case "partly":
        return (
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="8" cy="8" r="3.5" />
            <path d="M5 18h11a3.5 3.5 0 0 0 0-7 5.5 5.5 0 0 0-10.2 2" />
          </svg>
        );
      case "rain":
      case "drizzle":
        return (
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 15h10a3.5 3.5 0 0 0 0-7 5.5 5.5 0 0 0-10.2 2" />
            <path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3" />
          </svg>
        );
      case "snow":
        return (
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 14h10a3.5 3.5 0 0 0 0-7 5.5 5.5 0 0 0-10.2 2" />
            <path d="M9 18h0M12 20h0M15 18h0" />
          </svg>
        );
      case "storm":
        return (
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 14h10a3.5 3.5 0 0 0 0-7 5.5 5.5 0 0 0-10.2 2" />
            <path d="M12 16l-2 4h3l-1 3" />
          </svg>
        );
      case "fog":
        return (
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 10h14M3 14h18M6 18h12" />
          </svg>
        );
      default:
        return (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 14h10a3.5 3.5 0 0 0 0-7 5.5 5.5 0 0 0-10.2 2" />
          </svg>
        );
    }
  };

  const summaryWithLinks = useMemo(() => {
    if (!cleanedSummary) return "";
    if (!sources.length) return cleanedSummary;
    return cleanedSummary.replace(/\[(\d+)\](?!\()/g, (match, rawIndex) => {
      const index = Number(rawIndex);
      if (!Number.isFinite(index) || index < 1) return match;
      const url = sources[index - 1];
      return url ? `[${index}](${url})` : match;
    });
  }, [cleanedSummary, sources]);

  const summarySections = useMemo(() => {
    if (!summaryWithLinks) return [];
    const paragraphs = summaryWithLinks
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    const sectionLabels = ["Where it is", "Background", "Present day"];
    const renderer = new marked.Renderer();
    renderer.link = (href, title, text) => {
      const safeHref = href ?? "";
      const safeText = text ?? "";
      const isCitation = /^\d+$/.test(safeText);
      if (isCitation) {
        return `<sup class="citation"><a class="citation__link" href="${safeHref}" target="_blank" rel="noreferrer">[${safeText}]</a></sup>`;
      }
      const titleAttr = title ? ` title="${title}"` : "";
      return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noreferrer">${safeText}</a>`;
    };
    return paragraphs.map((paragraph, index) => {
      const html = marked.parse(paragraph, { breaks: false, renderer });
      return {
        label: sectionLabels[index] ?? "More",
        html: DOMPurify.sanitize(html, { ADD_ATTR: ["target", "rel"] }),
      };
    });
  }, [summaryWithLinks]);

  const showSummaryLabels = summarySections.length > 1;

  const getFaviconUrl = (url) => {
    try {
      const host = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?sz=32&domain_url=${host}`;
    } catch {
      return "";
    }
  };

  const handleOpenLightbox = (index, source) => {
    setLightboxIndex(index);
    setLightboxSource(source);
    setLightboxOpen(true);
    if (source === "sidebar") {
      setSidebarCarouselIndex(index);
    }
    if (source === "expanded") {
      setExpandedCarouselIndex(index);
    }
  };

  const handleCloseLightbox = () => {
    setLightboxOpen(false);
    setLightboxSource(null);
  };

  const handleNextImage = () => {
    if (!images.length) return;
    setLightboxIndex((prev) => {
      const next = (prev + 1) % images.length;
      if (lightboxSource === "sidebar") {
        setSidebarCarouselIndex(next);
      }
      if (lightboxSource === "expanded") {
        setExpandedCarouselIndex(next);
      }
      return next;
    });
  };

  const handlePrevImage = () => {
    if (!images.length) return;
    setLightboxIndex((prev) => {
      const next = (prev - 1 + images.length) % images.length;
      if (lightboxSource === "sidebar") {
        setSidebarCarouselIndex(next);
      }
      if (lightboxSource === "expanded") {
        setExpandedCarouselIndex(next);
      }
      return next;
    });
  };

  const handleNextSidebarCarousel = () => {
    if (!images.length) return;
    setSidebarCarouselIndex((prev) => (prev + 1) % images.length);
  };

  const handlePrevSidebarCarousel = () => {
    if (!images.length) return;
    setSidebarCarouselIndex((prev) => (prev - 1 + images.length) % images.length);
  };

  const handleNextExpandedCarousel = () => {
    if (!images.length) return;
    setExpandedCarouselIndex((prev) => (prev + 1) % images.length);
  };

  const handlePrevExpandedCarousel = () => {
    if (!images.length) return;
    setExpandedCarouselIndex((prev) => (prev - 1 + images.length) % images.length);
  };

  const focusMapAt = useCallback((lng, lat) => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;
    marker.setLngLat([lng, lat]).addTo(map);
    map.flyTo({
      center: [lng, lat],
      zoom: Math.max(map.getZoom(), 9),
      duration: 900,
    });
  }, []);

  const applyCachedPlace = useCallback(
    (place, overrideCoords = null) => {
      setIsCachedView(true);
      setSidebarMode("details");
      setSidebarOpen(true);
      setStatus("ready");
      setCoords(
        overrideCoords || { lng: place.lng, lat: place.lat },
      );
      setGeoStatus("ready");
      setPlaceName(place.title || "Unknown location");
      setSummary(place.summary || "");
      setAiError("");
      setImages(Array.isArray(place.images) ? place.images : []);
      setSources(Array.isArray(place.sources) ? place.sources : []);
      setPlacesGroups(Array.isArray(place.placesGroups) ? place.placesGroups : []);
      setPlacesStatus(
        place.placesStatus ||
          (Array.isArray(place.placesGroups) && place.placesGroups.length > 0
            ? "ready"
            : "idle"),
      );
      setPlacesError(place.placesError || "");
      setSelectedInterests([]);
      setExploreModalOpen(false);
      setExploreOpen(true);
      setPlacesScrollState({});
      setSummaryOpen(true);
      setSourcesOpen(false);
      setLightboxOpen(false);
      setLightboxIndex(0);
      setLightboxSource(null);
      setSidebarCarouselIndex(0);
      setExpandedCarouselIndex(0);
      setExpandedOpen(false);
      setWeather(place.weather ?? null);
      setWeatherStatus(
        place.weatherStatus || (place.weather ? "ready" : "idle"),
      );
      setWeatherError(place.weatherError || "");
      setHistory((prev) => {
        const existing = prev.find((item) => isSamePlaceForLists(item, place));
        const nextEntry = {
          ...(existing || {}),
          ...place,
          savedAt: Date.now(),
        };
        const next = [
          nextEntry,
          ...prev.filter((item) => !isSamePlaceForLists(item, nextEntry)),
        ];
        return next.slice(0, HISTORY_LIMIT);
      });
      if (overrideCoords) {
        focusMapAt(overrideCoords.lng, overrideCoords.lat);
      } else {
        focusMapAt(place.lng, place.lat);
      }
    },
    [focusMapAt],
  );

  const handleSelectSavedPlace = useCallback(
    (place) => {
      applyCachedPlace(place);
    },
    [applyCachedPlace],
  );

  const handleBookmarkToggle = useCallback(() => {
    const entry = buildSavedPlace();
    if (!entry) return;
    const nextEntry = { ...entry };
    setBookmarks((prev) => {
      const exists = prev.some((item) => isSamePlaceForLists(item, nextEntry));
      if (exists) {
        return prev.filter((item) => !isSamePlaceForLists(item, nextEntry));
      }
      return [
        nextEntry,
        ...prev.filter((item) => !isSamePlaceForLists(item, nextEntry)),
      ];
    });
  }, [buildSavedPlace]);

  const handleOpenBookmarks = useCallback(() => {
    setSidebarOpen(true);
    setSidebarMode("bookmarks");
  }, []);

  const handleOpenHistory = useCallback(() => {
    setSidebarOpen(true);
    setSidebarMode("history");
  }, []);

  const handleClearHistory = useCallback(() => {
    setHistory([]);
    setBookmarks([]);
    saveStoredPlaces(HISTORY_STORAGE_KEY, []);
    saveStoredPlaces(BOOKMARKS_STORAGE_KEY, []);
  }, []);

  const updateHistoryEntry = useCallback((entry) => {
    if (!entry) return;
    setHistory((prev) => {
      const existing = prev.find((item) => isSamePlaceForLists(item, entry));
      const merged = {
        ...(existing || {}),
        ...entry,
      };
      const next = [
        merged,
        ...prev.filter((item) => !isSamePlaceForLists(item, entry)),
      ];
      return next.slice(0, HISTORY_LIMIT);
    });
  }, []);

  const updateBookmarkEntry = useCallback((entry) => {
    if (!entry) return;
    setBookmarks((prev) => {
      let updated = false;
      const next = prev.map((item) => {
        if (isSamePlaceForLists(item, entry)) {
          updated = true;
          return {
            ...item,
            ...entry,
            savedAt: item.savedAt,
          };
        }
        return item;
      });
      return updated ? next : prev;
    });
  }, []);

  const handleFetchPlaces = useCallback(() => {
    if (!coords || selectedInterests.length === 0) return;
    if (isCachedView) {
      setIsCachedView(false);
    }
    const selections = OPTIONAL_INTERESTS.filter((interest) =>
      selectedInterests.includes(interest.id),
    );
    const interests = selections.map(({ id, label, query }) => ({
      id,
      label,
      query,
    }));
    setExploreModalOpen(false);
    runPlacesSearch({ lat: coords.lat, lng: coords.lng, interests, append: true });
  }, [coords, isCachedView, runPlacesSearch, selectedInterests]);

  const handleResetExplore = useCallback(() => {
    setSelectedInterests([]);
    setExploreModalOpen(true);
    setPlacesError("");
    setPlacesScrollState({});
  }, []);

  const handleRefreshWeather = useCallback(async () => {
    if (!coords) return;
    setWeatherStatus("loading");
    setWeatherError("");
    try {
      const res = await fetch(`${apiBaseUrl}/weather`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: coords.lat, lng: coords.lng }),
      });
      if (!res.ok) {
        throw new Error(`Weather request failed (${res.status})`);
      }
      const data = await res.json();
      setWeather(data);
      setWeatherStatus("ready");
      const entry = buildSavedPlace();
      if (entry) {
        const nextEntry = {
          ...entry,
          weather: data,
          weatherStatus: "ready",
          weatherError: "",
        };
        updateHistoryEntry(nextEntry);
        if (isBookmarked) updateBookmarkEntry(nextEntry);
      }
    } catch (err) {
      setWeatherError(
        err instanceof Error ? err.message : "Weather request failed.",
      );
      setWeatherStatus("error");
    }
  }, [
    apiBaseUrl,
    buildSavedPlace,
    coords,
    isBookmarked,
    updateBookmarkEntry,
    updateHistoryEntry,
  ]);

  useEffect(() => {
    if (isCachedView) return;
    if (!coords || status !== "ready") return;
    const entry = buildSavedPlace();
    if (!entry) return;
    updateHistoryEntry(entry);
    if (isBookmarked) updateBookmarkEntry(entry);
  }, [
    status,
    placesStatus,
    weatherStatus,
    summary,
    images,
    sources,
    placesGroups,
    weather,
    coords,
    isCachedView,
    isBookmarked,
    buildSavedPlace,
    updateBookmarkEntry,
    updateHistoryEntry,
  ]);

  const weatherLabel = useMemo(() => {
    if (weatherStatus === "loading") return "Weather...";
    if (weatherStatus === "error") return "Weather unavailable";
    if (
      weatherStatus === "ready" &&
      weather?.current &&
      typeof weather.current.temperature_2m === "number"
    ) {
      return `${Math.round(weather.current.temperature_2m)}°C`;
    }
    return "--";
  }, [weatherStatus, weather]);

  const renderDetails = ({
    variant,
    carouselIndex,
    onPrevCarousel,
    onNextCarousel,
    onOpenLightbox,
    galleryRef = null,
    mobileCollapsed = false,
    onMobileExpand,
  }) => {
    const isExpanded = variant === "expanded";
    const showGallery = isExpanded || isMobile;
    const titleClassName = isExpanded
      ? "text-3xl font-semibold tracking-tight text-foreground"
      : isMobile
        ? "text-2xl font-semibold tracking-tight text-foreground"
        : "text-xl font-semibold tracking-tight text-foreground";
    const metaClassName = isExpanded
      ? "flex items-center justify-between gap-4 text-base font-medium text-foreground/90"
      : "flex items-center justify-between gap-4 text-sm font-medium text-foreground/90";
    const weatherIconClassName = isExpanded
      ? "flex h-6 w-6 items-center justify-center text-foreground"
      : "flex h-5 w-5 items-center justify-center text-foreground";
    const imageWrapperClassName = isExpanded
      ? "relative flex h-[32vh] min-h-[240px] max-h-[420px] w-full items-center justify-center overflow-hidden rounded-md border border-border bg-background"
      : "group relative w-full overflow-hidden rounded-md border border-border bg-muted/30";
    const imageClassName = isExpanded
      ? "h-full w-full object-contain"
      : "h-60 w-full object-cover transition-transform duration-300 group-hover:scale-105";
    const imageButtonClassName = isExpanded
      ? "flex h-full w-full items-center justify-center"
      : "block w-full";
    const galleryItemClassName = isMobile
      ? "group relative flex h-[30vh] min-h-[220px] w-[75vw] flex-none overflow-hidden rounded-xl border border-border bg-muted/20"
      : "group relative flex h-40 w-64 flex-none overflow-hidden rounded-md border border-border bg-muted/20";
    const galleryImageClassName = isMobile
      ? "h-full w-full object-cover"
      : "h-full w-full object-cover transition-transform duration-300 group-hover:scale-105";
    const scrollGallery = (direction) => {
      if (!galleryRef?.current) return;
      const scrollAmount = Math.max(galleryRef.current.clientWidth * 0.8, 240);
      galleryRef.current.scrollBy({
        left: direction * scrollAmount,
        behavior: "smooth",
      });
    };

    if (mobileCollapsed) {
      if (error) {
        return (
          <div className="text-xs text-muted-foreground">{error}</div>
        );
      }
      if (status === "idle") {
        return (
          <div className="text-sm text-muted-foreground">
            Click anywhere on the globe.
          </div>
        );
      }
      if (status === "loading") {
        if (!coords) {
          return (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span>Loading place...</span>
            </div>
          );
        }
        return (
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 text-left"
            onClick={() => onMobileExpand?.()}
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">
                {displayPlaceName}
              </div>
              <div className="text-xs text-muted-foreground">
                {formatCoord(coords.lat)}, {formatCoord(coords.lng)}
              </div>
              <div className="text-xs text-muted-foreground">{weatherLabel}</div>
            </div>
            <span className="text-[11px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">
              Loading
            </span>
          </button>
        );
      }
      if (!coords) return null;

      return (
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 text-left"
          onClick={() => onMobileExpand?.()}
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">
              {displayPlaceName}
            </div>
            <div className="text-xs text-muted-foreground">
              {formatCoord(coords.lat)}, {formatCoord(coords.lng)}
            </div>
            <div className="text-xs text-muted-foreground">{weatherLabel}</div>
          </div>
          <span className="text-[11px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">
            Open details
          </span>
        </button>
      );
    }

    if (error) {
      return (
        <div className="space-y-2 text-sm text-muted-foreground">
          <div className="text-xs uppercase tracking-[0.2em]">Token missing</div>
          <p>{error}</p>
        </div>
      );
    }

    if (status === "idle") {
      return (
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>Click anywhere on the globe.</p>
        </div>
      );
    }

    if (!coords) return null;

    const aiStatus = aiError
      ? "error"
      : status === "loading"
        ? "loading"
        : status === "ready"
          ? "ready"
          : "idle";
    const statusItems = [
      { key: "weather", label: "Fetching weather", status: weatherStatus },
      ...(!isMobile
        ? [{ key: "places", label: "Finding places", status: placesStatus }]
        : []),
      { key: "summary", label: "Drafting summary", status: aiStatus },
    ];
    const placesHasResults = placesGroups.some(
      (group) => Array.isArray(group.places) && group.places.length > 0,
    );
    const placesHasErrors =
      Boolean(placesError) || placesGroups.some((group) => Boolean(group.error));
    const placesEmpty =
      placesStatus === "ready" && !placesHasResults && !placesHasErrors;
    const placesErrorEmpty =
      placesStatus === "error" && !placesHasResults && Boolean(placesError);

    const headerBlock = (
      <div className="space-y-2">
        <div className={titleClassName}>{displayPlaceName}</div>
        <div className={metaClassName}>
          <span>
            {formatCoord(coords.lat)}, {formatCoord(coords.lng)}
          </span>
          <span className="flex items-center gap-2" title={weatherError}>
            <span className={weatherIconClassName}>
              <WeatherIcon kind={weatherKind} />
            </span>
            <span>{weatherLabel}</span>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="h-7 w-7"
              onClick={handleRefreshWeather}
              aria-label="Refresh weather"
              disabled={weatherStatus === "loading"}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  weatherStatus === "loading" ? "animate-spin" : ""
                }`}
              />
            </Button>
          </span>
        </div>
      </div>
    );

    const statusStack = (
      <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
        {statusItems.map((item) => {
          const isPlacesItem = item.key === "places";
          const isEmpty = isPlacesItem && placesEmpty;
          const isLoading = item.status === "loading";
          const isReady = item.status === "ready" && !isEmpty;
          const isError = item.status === "error";
          const label = isEmpty
            ? "No results"
            : isLoading
              ? "Loading"
              : isReady
                ? "Ready"
                : isError
                  ? "Error"
                  : "Waiting";
          const badgeClassName = isEmpty
            ? "text-amber-400"
            : isReady
              ? "text-emerald-400"
              : isError
                ? "text-destructive"
                : "text-muted-foreground";
          return (
            <div
              key={item.key}
              className="flex items-center justify-between gap-3"
            >
              <span className="font-medium">{item.label}</span>
              <span
                className={`flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] ${badgeClassName}`}
              >
                {isLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                {isReady && <Check className="h-3 w-3" />}
                {isError && <X className="h-3 w-3" />}
                {isEmpty && <X className="h-3 w-3" />}
                {label}
              </span>
            </div>
          );
        })}
      </div>
    );
    const showStatusStack =
      !isMobile &&
      (status === "loading" ||
        aiStatus === "loading" ||
        placesStatus === "loading");

    const showSummaryBlock = isMobile || aiStatus !== "loading";
    const showPlacesLoadingSkeletons =
      placesStatus === "loading" &&
      (placesHasResults || selectedInterests.length > 0);
    const showPlacesBlock =
      !isMobile &&
      (placesHasResults ||
        placesStatus === "ready" ||
        placesStatus === "error" ||
        showPlacesLoadingSkeletons);
    const showEmptyPlacesState = placesEmpty;
    const showPlacesErrorState = placesErrorEmpty;

    const imagesBlock =
      images.length > 0 ? (
        <div className="space-y-2">
          {showGallery ? (
            <div className="relative">
              <div
                ref={galleryRef}
                className="gallery-scroll flex gap-3 overflow-x-auto pb-2 pr-2"
              >
                {images.map((src, index) => (
                  <button
                    key={`${src}-${index}`}
                    type="button"
                    onClick={() => onOpenLightbox(index)}
                    aria-label={`Open image ${index + 1}`}
                    className={galleryItemClassName}
                  >
                    <img
                      src={src}
                      alt={`${displayPlaceName} ${index + 1}`}
                      loading="lazy"
                      className={galleryImageClassName}
                    />
                  </button>
                ))}
              </div>
              {images.length > 1 && !isMobile && (
                <>
                  <button
                    type="button"
                    className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full border border-border bg-background/80 p-1.5 text-foreground shadow-sm backdrop-blur"
                    onClick={() => scrollGallery(-1)}
                    aria-label="Scroll gallery left"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className="absolute right-0 top-1/2 -translate-y-1/2 rounded-full border border-border bg-background/80 p-1.5 text-foreground shadow-sm backdrop-blur"
                    onClick={() => scrollGallery(1)}
                    aria-label="Scroll gallery right"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className={imageWrapperClassName}>
              <button
                className={imageButtonClassName}
                type="button"
                onClick={() => onOpenLightbox(carouselIndex)}
                aria-label={`Open image ${carouselIndex + 1}`}
              >
                <img
                  src={images[carouselIndex]}
                  alt={`${displayPlaceName} ${carouselIndex + 1}`}
                  loading="eager"
                  className={imageClassName}
                />
              </button>
              {images.length > 1 && (
                <>
                  <button
                    className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border bg-background/80 p-1.5 text-foreground shadow-sm backdrop-blur opacity-0 transition-opacity group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto"
                    type="button"
                    onClick={onPrevCarousel}
                    aria-label="Previous image"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border bg-background/80 p-1.5 text-foreground shadow-sm backdrop-blur opacity-0 transition-opacity group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto"
                    type="button"
                    onClick={onNextCarousel}
                    aria-label="Next image"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                  <div className="absolute bottom-2 right-2 rounded-full border border-border bg-background/80 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-muted-foreground shadow-sm backdrop-blur">
                    {carouselIndex + 1} / {images.length}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ) : null;

    const summaryBlock = (
      <div className="space-y-2">
        <button
          className="flex w-full items-center justify-between text-sm font-semibold uppercase tracking-[0.2em] text-foreground"
          type="button"
          onClick={() => setSummaryOpen((open) => !open)}
          aria-expanded={summaryOpen}
        >
          Summary
          <span
            className={`h-2 w-2 border-b border-r border-muted-foreground transition-transform ${
              summaryOpen ? "rotate-45" : "-rotate-45"
            }`}
            aria-hidden="true"
          />
        </button>
        {summaryOpen && (
          <div className={isMobile ? "mt-4 space-y-4" : "mt-4 space-y-5"}>
            {aiError ? (
              <p className="text-sm text-muted-foreground">{aiError}</p>
            ) : summarySections.length ? (
              summarySections.map((section, index) => (
                <div key={`${section.label}-${index}`} className="space-y-3">
                  {showSummaryLabels && (
                    <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.28em] text-muted-foreground/80">
                      <span
                        className="h-px w-3 bg-border/60"
                        aria-hidden="true"
                      />
                      <span>{section.label}</span>
                    </div>
                  )}
                  <div
                    className="markdown"
                    dangerouslySetInnerHTML={{
                      __html: section.html,
                    }}
                  />
                </div>
              ))
            ) : aiStatus === "loading" ? (
              <p className="text-sm text-muted-foreground">
                Drafting summary...
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Summary unavailable.
              </p>
            )}
          </div>
        )}
      </div>
    );

    const placeCardClassName = isMobile
      ? "flex h-[220px] w-[72vw] flex-none flex-col overflow-hidden rounded-xl border border-border bg-background/80 shadow-sm backdrop-blur"
      : "flex h-[200px] w-64 flex-none flex-col overflow-hidden rounded-md border border-border bg-background/80 shadow-sm backdrop-blur";
    const placeImageWrapperClassName = isMobile
      ? "relative h-32 w-full overflow-hidden bg-muted/30"
      : "relative h-28 w-full overflow-hidden bg-muted/30";
    const placeImageClassName = "h-full w-full object-cover";
    const setPlacesRowRef = (key, node) => {
      if (node) {
        placesRowRefs.current[key] = node;
      } else {
        delete placesRowRefs.current[key];
      }
    };
    const scrollPlacesRow = (key, direction) => {
      const node = placesRowRefs.current[key];
      if (!node) return;
      const scrollAmount = Math.max(node.clientWidth * 0.8, 240);
      node.scrollBy({ left: scrollAmount * direction, behavior: "smooth" });
    };
    const scrollButtonClassName =
      "absolute top-1/2 -translate-y-1/2 rounded-full border border-border bg-background/80 p-1.5 text-foreground shadow-sm backdrop-blur";

    const placesBlock = showPlacesBlock ? (
      <div className="space-y-3">
        <button
          className="flex w-full items-center justify-between text-sm font-semibold uppercase tracking-[0.2em] text-foreground"
          type="button"
          onClick={() => setExploreOpen((open) => !open)}
          aria-expanded={exploreOpen}
        >
          Explore Nearby
          <span
            className={`h-2 w-2 border-b border-r border-muted-foreground transition-transform ${
              exploreOpen ? "rotate-45" : "-rotate-45"
            }`}
            aria-hidden="true"
          />
        </button>
        {exploreOpen && (
          <>
            {showPlacesErrorState && (
              <div className="space-y-2 text-xs text-muted-foreground">
                <div className="text-destructive">
                  {placesError || "Places request failed."}
                </div>
              </div>
            )}
            {showEmptyPlacesState && (
              <div className="space-y-2 text-xs text-muted-foreground">
                <div>No major tourist spots found.</div>
              </div>
            )}
            {placesHasResults && (
              <div className="space-y-5">
                {(() => {
                  const attractionGroup = placesGroups.find(
                    (group) => group.id === DEFAULT_INTEREST.id,
                  );
                  const otherGroups = placesGroups.filter(
                    (group) => group.id !== DEFAULT_INTEREST.id,
                  );
                  const orderedGroups = attractionGroup
                    ? [attractionGroup, ...otherGroups]
                    : placesGroups;
                  const summary = orderedGroups.reduce(
                    (acc, group) => {
                      const label = group.label || group.query || "Places";
                      const groupPlaces = Array.isArray(group.places)
                        ? group.places
                        : [];
                      const hasPlaces = groupPlaces.length > 0;
                      const hasError = Boolean(group.error);
                      if (hasPlaces || hasError) {
                        acc.displayGroups.push({
                          group,
                          label,
                          groupPlaces,
                          hasPlaces,
                          hasError,
                        });
                      } else {
                        acc.emptyLabels.push(label);
                      }
                      return acc;
                    },
                    { displayGroups: [], emptyLabels: [] },
                  );
                  return (
                    <>
                      {summary.displayGroups.map(
                        ({ group, label, groupPlaces }) => {
                          const rowKey = group.id || label;
                          const scrollState = placesScrollState[rowKey] ?? {
                            canScrollLeft: false,
                            canScrollRight: false,
                          };
                          return (
                            <div key={rowKey} className="space-y-3">
                              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground/80">
                                <span
                                  className="h-px w-3 bg-border/60"
                                  aria-hidden="true"
                                />
                                <span>{label}</span>
                              </div>
                              {group.error && (
                                <div className="text-xs text-destructive">
                                  {group.error}
                                </div>
                              )}
                              {groupPlaces.length > 0 && (
                                <div className="relative">
                                  <div
                                    ref={(node) => setPlacesRowRef(rowKey, node)}
                                    className="gallery-scroll flex gap-3 overflow-x-auto pb-2 pr-2"
                                    onScroll={() => updateRowScrollState(rowKey)}
                                  >
                                    {groupPlaces.map((place, index) => {
                                      const ratingLabel = formatRating(
                                        place.rating,
                                      );
                                      const reviewsLabel = formatReviewCount(
                                        place.reviewsCount,
                                      );
                                      const searchParts = [
                                        place.title,
                                        place.address,
                                      ]
                                        .filter(Boolean)
                                        .join(" ");
                                      const placeHref =
                                        place.link ||
                                        (searchParts
                                          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                                              searchParts,
                                            )}`
                                          : "");
                                      const Wrapper = placeHref ? "a" : "div";
                                      const wrapperProps = placeHref
                                        ? {
                                            href: placeHref,
                                            target: "_blank",
                                            rel: "noreferrer",
                                          }
                                        : {};
                                      const imageSrc = place.thumbnailUrl
                                        ? `${apiBaseUrl}/image?url=${encodeURIComponent(
                                            place.thumbnailUrl,
                                          )}`
                                        : "";
                                      return (
                                        <Wrapper
                                          key={`${place.title}-${index}`}
                                          className={`${placeCardClassName} no-underline text-foreground transition-shadow hover:shadow-md`}
                                          {...wrapperProps}
                                        >
                                          <div className={placeImageWrapperClassName}>
                                            {imageSrc ? (
                                              <img
                                                src={imageSrc}
                                                alt={place.title}
                                                loading="lazy"
                                                className={placeImageClassName}
                                                onLoad={() =>
                                                  updateRowScrollState(rowKey)
                                                }
                                              />
                                            ) : (
                                              <div className="flex h-full w-full items-center justify-center text-[11px] text-muted-foreground">
                                                No image
                                              </div>
                                            )}
                                          </div>
                                          <div className="flex flex-1 flex-col gap-2 p-3">
                                            <div className="text-sm font-semibold leading-snug text-foreground">
                                              {place.title}
                                            </div>
                                            {(ratingLabel || reviewsLabel) && (
                                              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                                {ratingLabel && (
                                                  <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                                                    <Star
                                                      className="h-3 w-3 text-amber-400"
                                                      fill="currentColor"
                                                    />
                                                    {ratingLabel}
                                                  </span>
                                                )}
                                                {reviewsLabel && (
                                                  <span>{reviewsLabel} reviews</span>
                                                )}
                                              </div>
                                            )}
                                            {(place.category || place.address) && (
                                              <div className="text-[11px] text-muted-foreground">
                                                {place.category && (
                                                  <span>{place.category}</span>
                                                )}
                                                {place.category && place.address && (
                                                  <span className="mx-1">•</span>
                                                )}
                                                {place.address && (
                                                  <span>{place.address}</span>
                                                )}
                                              </div>
                                            )}
                                          </div>
                                        </Wrapper>
                                      );
                                    })}
                                  </div>
                                  {scrollState.canScrollLeft && (
                                    <>
                                      <button
                                        type="button"
                                        className={`${scrollButtonClassName} left-0`}
                                        onClick={() => scrollPlacesRow(rowKey, -1)}
                                        aria-label="Scroll places left"
                                      >
                                        <ChevronLeft className="h-4 w-4" />
                                      </button>
                                    </>
                                  )}
                                  {scrollState.canScrollRight && (
                                    <button
                                      type="button"
                                      className={`${scrollButtonClassName} right-0`}
                                      onClick={() => scrollPlacesRow(rowKey, 1)}
                                      aria-label="Scroll places right"
                                    >
                                      <ChevronRight className="h-4 w-4" />
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        },
                      )}
                      {summary.emptyLabels.length > 0 && !placesEmpty && (
                        <div className="text-xs text-muted-foreground">
                          No results for: {summary.emptyLabels.join(", ")}.
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
            {showPlacesLoadingSkeletons && (
              <div className="space-y-4">
                {Array.from({
                  length: Math.max(selectedInterests.length, 1),
                }).map((_, rowIndex) => (
                  <div key={`place-skeleton-row-${rowIndex}`} className="space-y-3">
                    <Skeleton className="h-4 w-32" />
                    <div className="gallery-scroll flex gap-3 overflow-x-auto pb-2 pr-2">
                      {Array.from({ length: 3 }).map((_, index) => (
                        <div
                          key={`place-skeleton-${rowIndex}-${index}`}
                          className={placeCardClassName}
                        >
                          <Skeleton className={placeImageWrapperClassName} />
                          <div className="space-y-2 p-3">
                            <Skeleton className="h-4 w-3/4" />
                            <Skeleton className="h-3 w-1/2" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 px-3 text-xs"
                onClick={handleResetExplore}
              >
                Refine places
              </Button>
            </div>
          </>
        )}
      </div>
    ) : null;

    const sourcesBlock =
      sources.length > 0 ? (
        <div className="space-y-2">
          <button
            className="flex w-full items-center justify-between text-sm font-semibold uppercase tracking-[0.2em] text-foreground"
            type="button"
            onClick={() => setSourcesOpen((open) => !open)}
            aria-expanded={sourcesOpen}
          >
            Sources ({sources.length})
            <span
              className={`h-2 w-2 border-b border-r border-muted-foreground transition-transform ${
                sourcesOpen ? "rotate-45" : "-rotate-45"
              }`}
              aria-hidden="true"
            />
          </button>
          {sourcesOpen &&
            (isMobile ? (
              <div className="flex flex-wrap gap-2 pt-2 text-xs text-muted-foreground">
                {sources.map((url) => (
                  <a
                    key={url}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-full border border-border bg-background/60 px-3 py-1"
                  >
                    {getFaviconUrl(url) && (
                      <img
                        className="h-4 w-4 rounded"
                        src={getFaviconUrl(url)}
                        alt=""
                        loading="lazy"
                      />
                    )}
                    <span className="max-w-[140px] truncate">
                      {formatSourceLabel(url)}
                    </span>
                  </a>
                ))}
              </div>
            ) : (
              <div className="space-y-2 pt-2 text-xs text-muted-foreground">
                {sources.map((url) => (
                  <a
                    key={url}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2"
                  >
                    {getFaviconUrl(url) && (
                      <img
                        className="h-4 w-4 rounded"
                        src={getFaviconUrl(url)}
                        alt=""
                        loading="lazy"
                      />
                    )}
                    <span className="underline underline-offset-4">
                      {formatSourceLabel(url)}
                    </span>
                  </a>
                ))}
              </div>
            ))}
        </div>
      ) : null;

    return (
      <div className={isMobile ? "space-y-6" : "space-y-8"}>
        {isMobile && imagesBlock}
        {headerBlock}
        {showStatusStack ? statusStack : null}
        {!isMobile && imagesBlock}
        {showSummaryBlock ? summaryBlock : null}
        {placesBlock}
        {showSummaryBlock ? sourcesBlock : null}
      </div>
    );
  };

  const sidebarDetails = (
    <SidebarDetailsPanel
      variant="sidebar"
      carouselIndex={sidebarCarouselIndex}
      onPrevCarousel={handlePrevSidebarCarousel}
      onNextCarousel={handleNextSidebarCarousel}
      onOpenLightbox={(index) => handleOpenLightbox(index, "sidebar")}
      render={renderDetails}
    />
  );

  const sidebarBody = isMobile
    ? sidebarDetails
    : sidebarMode === "details"
      ? sidebarDetails
      : sidebarMode === "bookmarks"
        ? (
            <SavedPlacesPanel
              title="Bookmarks"
              items={bookmarks}
              emptyLabel="No bookmarks yet."
              onSelect={handleSelectSavedPlace}
            />
          )
        : (
            <SavedPlacesPanel
              title="Recently visited"
              items={history}
              emptyLabel="No places visited yet."
              onSelect={handleSelectSavedPlace}
              onClear={handleClearHistory}
              clearLabel="Clear history"
            />
          );

  const expandedDetails = renderDetails({
    variant: "expanded",
    carouselIndex: expandedCarouselIndex,
    onPrevCarousel: handlePrevExpandedCarousel,
    onNextCarousel: handleNextExpandedCarousel,
    onOpenLightbox: (index) => handleOpenLightbox(index, "expanded"),
    galleryRef: expandedGalleryRef,
  });

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={mapContainerRef} className="absolute inset-0 z-0 h-full w-full" />
        <SidebarProvider
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          className="relative z-10 h-full w-full"
          style={{ "--sidebar-width": "30rem" }}
          mobileDisableExpand={status === "idle" || status === "loading"}
          mobileAllowCollapse={false}
        >
        <MobileSheetAutoOpen coords={coords} isMobile={isMobile} />
        <MobileLightboxCollapse
          isMobile={isMobile}
          lightboxOpen={lightboxOpen}
          lightboxSource={lightboxSource}
        />
        {!expandedOpen && (
          <Sidebar
            collapsible="icon"
            className="z-30"
          >
            <div className="relative flex h-full w-full flex-col min-h-0">
              <MobileSidebarHeader>
                <>
                  <SidebarHeader className="gap-3 px-4 py-4 group-data-[state=collapsed]:hidden">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold uppercase tracking-[0.25em] text-foreground">
                        Geoplexer
                      </div>
                      <div className="flex items-center gap-2">
                        {coords && sidebarMode === "details" && !isMobile && (
                          <>
                            {status === "loading" && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                onClick={resetSelection}
                                aria-label="Stop loading"
                                title="Stop loading"
                              >
                                <CircleStop className="h-4 w-4" />
                              </Button>
                            )}
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              onClick={handleBookmarkToggle}
                              aria-label="Bookmarks"
                              title="Bookmarks"
                            >
                              <Bookmark
                                className={`h-4 w-4 ${
                                  isBookmarked ? "text-cyan-300" : "text-foreground"
                                }`}
                                fill={isBookmarked ? "currentColor" : "none"}
                              />
                            </Button>
                            {!isMobile && sidebarMode === "details" && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                onClick={() => {
                                  setExpandedCarouselIndex(sidebarCarouselIndex);
                                  setExpandedOpen(true);
                                }}
                                aria-label="Expand view"
                              >
                                <Expand className="h-4 w-4" />
                              </Button>
                            )}
                          </>
                        )}
                        <SidebarTrigger className="h-8 w-8" />
                      </div>
                    </div>
                  </SidebarHeader>
                  <SidebarSeparator className="mx-0 w-full group-data-[state=collapsed]:hidden" />
                </>
              </MobileSidebarHeader>
              <SidebarContent className="px-4 group-data-[state=collapsed]:hidden">
                {sidebarBody}
              </SidebarContent>
            {!isMobile && (
              <CollapsedSidebarControl
                showChevron={status !== "idle"}
                onShowBookmarks={handleOpenBookmarks}
                onShowHistory={handleOpenHistory}
              />
            )}
          </div>
        </Sidebar>
      )}

        {expandedOpen && !isMobile && (
          <div
            className="fixed inset-0 z-40 flex items-center justify-center bg-foreground/20 p-6 backdrop-blur-sm"
            onClick={() => setExpandedOpen(false)}
          >
            <div
              className="relative w-full max-w-6xl rounded-lg border border-border bg-sidebar/90 p-8 shadow-xl backdrop-blur-xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mb-2 -mt-4 -mr-4 flex items-center justify-end gap-2">
                {coords && (
                  <button
                    type="button"
                    className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background/80 text-foreground shadow-sm backdrop-blur"
                    onClick={handleBookmarkToggle}
                    aria-label="Bookmark"
                  >
                    <Bookmark
                      className={`h-4 w-4 ${
                        isBookmarked ? "text-cyan-300" : "text-foreground"
                      }`}
                      fill={isBookmarked ? "currentColor" : "none"}
                    />
                  </button>
                )}
                <button
                  type="button"
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background/80 text-foreground shadow-sm backdrop-blur"
                  onClick={() => setExpandedOpen(false)}
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="max-h-[86vh] overflow-y-auto overflow-x-hidden -mr-8 pr-0">
                <div className="pr-4">{expandedDetails}</div>
              </div>
            </div>
          </div>
        )}

        {exploreModalOpen && !isMobile && (
          <div
            className="fixed inset-0 z-40 flex items-center justify-center bg-foreground/30 p-6 backdrop-blur-sm"
            onClick={() => setExploreModalOpen(false)}
          >
            <div
              className="w-full max-w-xl rounded-lg border border-border bg-sidebar/95 p-6 shadow-xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold uppercase tracking-[0.25em] text-foreground">
                  Search more places
                </div>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={() => setExploreModalOpen(false)}
                  aria-label="Close search modal"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {optionalInterestsForModal.map((interest) => {
                  const isActive = selectedInterests.includes(interest.id);
                  return (
                    <button
                      key={interest.id}
                      type="button"
                      onClick={() => toggleInterest(interest.id)}
                      aria-pressed={isActive}
                      className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] transition ${
                        isActive
                          ? "border-foreground bg-foreground text-background"
                          : "border-border text-foreground/80 hover:bg-muted/40"
                      }`}
                    >
                      {interest.label}
                    </button>
                  );
                })}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={handleFetchPlaces}
                  disabled={
                    !coords ||
                    selectedInterests.length === 0 ||
                    placesStatus === "loading"
                  }
                >
                  {placesStatus === "loading" ? "Searching..." : "Find places"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {lightboxOpen && images.length > 0 && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
            onClick={handleCloseLightbox}
          >
          <div
            className="relative flex w-full max-w-5xl flex-col items-center gap-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="relative inline-flex">
              <img
                className="max-h-[80vh] max-w-[90vw] rounded-lg object-contain"
                src={images[lightboxIndex]}
                alt={`${displayPlaceName} ${lightboxIndex + 1}`}
              />
              <button
                className="absolute right-3 top-3 rounded-full border border-white/20 bg-black/60 p-2 text-white"
                type="button"
                onClick={handleCloseLightbox}
                aria-label="Close image viewer"
              >
                <X className="h-4 w-4" />
              </button>
              <button
                className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full border border-white/20 bg-black/60 p-2 text-white"
                type="button"
                onClick={handlePrevImage}
                aria-label="Previous image"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full border border-white/20 bg-black/60 p-2 text-white"
                type="button"
                onClick={handleNextImage}
                aria-label="Next image"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="text-xs text-white/70">
              {lightboxIndex + 1} / {images.length}
            </div>
          </div>
          </div>
        )}
      </SidebarProvider>
    </div>
  );
}
