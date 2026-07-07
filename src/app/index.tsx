import AsyncStorage from "@react-native-async-storage/async-storage";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import { extractTextFromImage } from "expo-text-extractor";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Platform,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import MapView, { Marker } from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";

type StopStatus = "pending" | "completed" | "skipped" | "failed";

type Stop = {
  id: string;
  address: string;
  status: StopStatus;
};

type Coordinate = {
  id: string;
  address: string;
  status: StopStatus;
  latitude: number;
  longitude: number;
};

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Common street-name suffixes, used to help identify which line of scanned
// text is actually a street address versus other text in the photo.
const STREET_SUFFIXES =
  /\b(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|way|ct|court|pl|place|cir|circle|pkwy|parkway|hwy|highway|trail|ter|terrace|sq|square)\b/i;

// Matches a "City, ST 12345" style line.
const CITY_STATE_ZIP = /,\s*[A-Za-z .]+,?\s*[A-Z]{2}\s*\d{5}(-\d{4})?\b/;

// Matches a line starting with a street number, e.g. "123 Main St".
const STREET_LINE = /^\d{1,6}\s+\S+/;

function extractAddressFromLines(rawLines: string[]): string {
  const lines = rawLines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return "";

  // Score each line by how "address-like" it looks.
  const scored = lines.map((line, index) => {
    let score = 0;
    if (STREET_LINE.test(line)) score += 3;
    if (STREET_SUFFIXES.test(line)) score += 2;
    if (CITY_STATE_ZIP.test(line)) score += 3;
    if (/\d{5}/.test(line)) score += 1;
    return { line, index, score };
  });

  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));

  // If the best line looks like a street address, check whether the very
  // next line looks like a city/state/zip line — if so, combine them.
  if (best.score > 0) {
    const next = scored[best.index + 1];
    if (
      next &&
      (CITY_STATE_ZIP.test(next.line) || /\d{5}/.test(next.line)) &&
      !CITY_STATE_ZIP.test(best.line)
    ) {
      return `${best.line}, ${next.line}`;
    }
    return best.line;
  }

  // Nothing scored as address-like — fall back to the longest line as a
  // reasonable guess, since the user can always edit it before adding.
  return lines.reduce((a, b) => (b.length > a.length ? b : a));
}

const STATUS_COLORS: Record<StopStatus, string> = {
  pending: "#208AEF",
  completed: "#2ecc71",
  skipped: "#999999",
  failed: "#e74c3c",
};

const STATUS_ORDER: StopStatus[] = ["pending", "completed", "skipped", "failed"];

// On iOS we use Apple's free built-in maps for the in-app pin view. Android
// has no equivalent free map, and Google's Maps SDK requires an API key —
// so on Android we skip the in-app map entirely and just show the ordered
// stop list, relying on the Google Maps app handoff for the visual/driving
// part instead.
const SHOW_IN_APP_MAP = Platform.OS === "ios";

export default function HomeScreen() {
  const [address, setAddress] = useState("");
  const [stops, setStops] = useState<Stop[]>([]);
  const [markers, setMarkers] = useState<Coordinate[]>([]);
  const [startLocation, setStartLocation] = useState<Coordinate | null>(null);
  const [roundTrip, setRoundTrip] = useState(false);
  const [navApp, setNavApp] = useState<"apple" | "google">(
    Platform.OS === "android" ? "google" : "apple"
  );
  const [showResults, setShowResults] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [suggestions, setSuggestions] = useState<{ display_name: string }[]>(
    []
  );
  const [routeStarted, setRouteStarted] = useState(false);
  const [currentStopIndex, setCurrentStopIndex] = useState(0);
  const [showCamera, setShowCamera] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const STORAGE_KEY = "route-planner-stops-v2";
  const NAV_APP_KEY = "route-planner-nav-app";

  useEffect(() => {
    async function loadStops() {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (saved) {
          setStops(JSON.parse(saved));
        }
      } catch (e) {
        console.log("Failed to load saved stops:", e);
      }
    }
    loadStops();
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(stops)).catch((e) =>
      console.log("Failed to save stops:", e)
    );
  }, [stops]);

  useEffect(() => {
    async function loadNavApp() {
      try {
        const saved = await AsyncStorage.getItem(NAV_APP_KEY);
        if (saved === "apple" || saved === "google") {
          setNavApp(saved);
        }
      } catch (e) {
        console.log("Failed to load nav app preference:", e);
      }
    }
    loadNavApp();
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(NAV_APP_KEY, navApp).catch((e) =>
      console.log("Failed to save nav app preference:", e)
    );
  }, [navApp]);

  useEffect(() => {
    if (address.trim().length < 3) {
      setSuggestions([]);
      return;
    }

    const timeout = setTimeout(async () => {
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
            address
          )}&limit=5`
        );
        const data = await response.json();
        setSuggestions(data);
      } catch (e) {
        console.log("Autocomplete error:", e);
      }
    }, 400);

    return () => clearTimeout(timeout);
  }, [address]);

  function selectSuggestion(item: { display_name: string }) {
    setAddress(item.display_name);
    setSuggestions([]);
  }

  function addStop() {
    if (address.trim() === "") return;
    setStops([...stops, { id: generateId(), address, status: "pending" }]);
    setAddress("");
  }

  async function openScanner() {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        setErrorMsg("Camera permission is needed to scan addresses.");
        return;
      }
    }
    setShowCamera(true);
  }

  async function capturePhoto() {
    if (!cameraRef.current) return;
    setScanning(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: false });
      if (photo?.uri) {
        const detectedLines = await extractTextFromImage(photo.uri);
        const bestGuess = extractAddressFromLines(detectedLines ?? []);
        setAddress(bestGuess);
      }
    } catch (e) {
      console.log("Text scan error:", e);
      setErrorMsg("Couldn't read text from that photo — try again.");
    }
    setScanning(false);
    setShowCamera(false);
  }

  function deleteStop(id: string) {
    setStops(stops.filter((s) => s.id !== id));
  }

  function moveStop(id: string, direction: "up" | "down") {
    const index = stops.findIndex((s) => s.id === id);
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= stops.length) return;
    const updated = [...stops];
    [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
    setStops(updated);
  }

  function cycleStatus(id: string) {
    setStops(
      stops.map((s) => {
        if (s.id !== id) return s;
        const currentIndex = STATUS_ORDER.indexOf(s.status);
        const nextStatus = STATUS_ORDER[(currentIndex + 1) % STATUS_ORDER.length];
        return { ...s, status: nextStatus };
      })
    );
  }

  function setStopStatus(id: string, status: StopStatus) {
    setStops(stops.map((s) => (s.id === id ? { ...s, status } : s)));
  }

  function clearRoute() {
    if (stops.length === 0) return;
    Alert.alert(
      "Clear this route?",
      "This will remove all stops so you can start a new route.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => {
            setStops([]);
            setMarkers([]);
            setStartLocation(null);
            setErrorMsg("");
            setShowResults(false);
            setRouteStarted(false);
          },
        },
      ]
    );
  }

  async function optimizeAndShow() {
    const pendingStops = stops.filter((s) => s.status === "pending");
    if (pendingStops.length === 0) {
      setErrorMsg("No pending stops to route — mark some back to pending first.");
      return;
    }
    setLoading(true);
    setErrorMsg("");

    try {
      // Android requires location permission granted before geocoding will
      // work at all, even for simple address-to-coordinate lookups. iOS
      // doesn't need this for geocoding itself, but requesting it is
      // harmless there too.
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setErrorMsg("Location permission is needed to look up addresses.");
        setLoading(false);
        return;
      }

      const geocoded: Coordinate[] = [];
      for (const stop of pendingStops) {
        const result = await Location.geocodeAsync(stop.address);
        if (result.length > 0) {
          geocoded.push({
            id: stop.id,
            address: stop.address,
            status: stop.status,
            latitude: result[0].latitude,
            longitude: result[0].longitude,
          });
        }
      }

      let anchor: Coordinate | null = null;
      if (roundTrip) {
        const position = await Location.getCurrentPositionAsync({});
        anchor = {
          id: "start-anchor",
          address: "Starting Location",
          status: "pending",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
      }

      const allPoints = anchor ? [anchor, ...geocoded] : geocoded;

      if (allPoints.length < 2) {
        setMarkers(geocoded);
        setStartLocation(anchor);
        setShowResults(true);
        setLoading(false);
        return;
      }

      const coordsParam = allPoints
        .map((m) => `${m.longitude},${m.latitude}`)
        .join(";");
      let url = `https://router.project-osrm.org/trip/v1/driving/${coordsParam}?source=first&roundtrip=${
        anchor ? "true" : "false"
      }`;
      if (!anchor) {
        url += "&destination=last";
      }

      const response = await fetch(url);
      const data = await response.json();

      if (data.code === "Ok") {
        const ordered = data.waypoints
          .map((wp: any, originalIndex: number) => ({
            originalIndex,
            order: wp.waypoint_index,
          }))
          .sort((a: any, b: any) => a.order - b.order)
          .map((item: any) => item.originalIndex);

        const filteredOrder = anchor
          ? ordered.filter((i: number) => i !== 0)
          : ordered;

        const optimizedMarkers = filteredOrder.map((i: number) =>
          anchor ? geocoded[i - 1] : geocoded[i]
        );

        const nonPending = stops.filter((s) => s.status !== "pending");
        const reorderedPending = optimizedMarkers.map(
          (m) => stops.find((s) => s.id === m.id)!
        );
        setStops([...reorderedPending, ...nonPending]);
        setMarkers(optimizedMarkers);
        setStartLocation(anchor);
      } else {
        setMarkers(geocoded);
        setStartLocation(anchor);
        setErrorMsg("Couldn't optimize order, showing original order.");
      }

      setShowResults(true);
    } catch (e) {
      console.log("Optimization error:", e);
      setErrorMsg("Something went wrong. Check your internet connection.");
    }

    setLoading(false);
  }

  function navigateToStop(marker: Coordinate) {
    if (navApp === "google") {
      const url = `comgooglemaps://?daddr=${marker.latitude},${marker.longitude}&directionsmode=driving`;
      Linking.openURL(url).catch(() => {
        Linking.openURL(
          `https://maps.google.com/?daddr=${marker.latitude},${marker.longitude}`
        );
      });
    } else {
      const url = `maps://app?daddr=${marker.latitude},${marker.longitude}&dirflg=d`;
      Linking.openURL(url).catch(() => {
        Linking.openURL(
          `https://maps.google.com/?daddr=${marker.latitude},${marker.longitude}`
        );
      });
    }
  }

  const routeSequence: Coordinate[] = startLocation
    ? [...markers, { ...startLocation, id: "return-anchor", address: "Back to Starting Location" }]
    : markers;

  function startRoute() {
    if (routeSequence.length === 0) return;
    setRouteStarted(true);
    setCurrentStopIndex(0);
    navigateToStop(routeSequence[0]);
  }

  function advanceRoute(status: StopStatus) {
    const current = routeSequence[currentStopIndex];
    if (current && current.id !== "start-anchor" && current.id !== "return-anchor") {
      setStopStatus(current.id, status);
    }

    const nextIndex = currentStopIndex + 1;
    if (nextIndex < routeSequence.length) {
      setCurrentStopIndex(nextIndex);
      navigateToStop(routeSequence[nextIndex]);
    } else {
      setRouteStarted(false);
      Alert.alert(
        "Route complete!",
        "Would you like to clear this route and start a new one?",
        [
          { text: "Keep it", style: "cancel" },
          {
            text: "Clear & Start New",
            style: "destructive",
            onPress: () => {
              setStops([]);
              setMarkers([]);
              setStartLocation(null);
              setErrorMsg("");
              setShowResults(false);
            },
          },
        ]
      );
    }
  }

  function endRoute() {
    setRouteStarted(false);
  }

  const pendingCount = stops.filter((s) => s.status === "pending").length;

  if (showCamera) {
    return (
      <SafeAreaView style={styles.container}>
        <CameraView ref={cameraRef} style={styles.camera} facing="back">
          <View style={styles.cameraOverlay}>
            <Text style={styles.cameraHint}>
              Frame the address, then tap to scan
            </Text>
            <View style={styles.cameraControls}>
              <TouchableOpacity
                style={styles.cameraCancelButton}
                onPress={() => setShowCamera(false)}
              >
                <Text style={styles.cameraCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.captureButton}
                onPress={capturePhoto}
                disabled={scanning}
              >
                {scanning ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <View style={styles.captureButtonInner} />
                )}
              </TouchableOpacity>
              <View style={styles.cameraCancelButton} />
            </View>
          </View>
        </CameraView>
      </SafeAreaView>
    );
  }

  // Shared active-route control panel — used as a floating card over the
  // map on iOS, and as a standalone panel on Android.
  function ActiveRouteCard() {
    return (
      <View style={styles.activeRouteCard}>
        <Text style={styles.activeRouteProgress}>
          Stop {currentStopIndex + 1} of {routeSequence.length}
        </Text>
        <Text style={styles.activeRouteAddress} numberOfLines={2}>
          {routeSequence[currentStopIndex]?.address}
        </Text>
        <View style={styles.activeRouteButtons}>
          <TouchableOpacity
            style={styles.skipButton}
            onPress={() => advanceRoute("skipped")}
          >
            <Text style={styles.skipButtonText}>Skip</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.failedButton}
            onPress={() => advanceRoute("failed")}
          >
            <Text style={styles.failedButtonText}>Failed</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.completeButton}
            onPress={() => advanceRoute("completed")}
          >
            <Text style={styles.completeButtonText}>
              {currentStopIndex + 1 === routeSequence.length
                ? "Finish"
                : "Complete"}
            </Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={styles.navigateAgainButton}
          onPress={() => navigateToStop(routeSequence[currentStopIndex])}
        >
          <Text style={styles.navigateAgainText}>Navigate Again</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={endRoute}
          style={styles.endRouteButton}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.endRouteText}>End Route</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (showResults) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.mapHeader}>
          <TouchableOpacity onPress={() => setShowResults(false)}>
            <Text style={styles.backButton}>← Back to list</Text>
          </TouchableOpacity>
          {!routeStarted && (
            <>
              <Text style={styles.hint}>
                {SHOW_IN_APP_MAP
                  ? "Tap a pin for a single stop, or start the full route below"
                  : "Your optimized stop order — start the route below"}
              </Text>
              {startLocation && (
                <Text style={styles.hint}>
                  Route starts and ends near your current location
                </Text>
              )}
              {routeSequence.length > 0 && (
                <TouchableOpacity
                  style={styles.fullRouteButton}
                  onPress={startRoute}
                >
                  <Text style={styles.fullRouteButtonText}>Start Route</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>

        {SHOW_IN_APP_MAP ? (
          <MapView
            style={styles.map}
            initialRegion={{
              latitude: startLocation?.latitude ?? markers[0]?.latitude ?? 37.78825,
              longitude:
                startLocation?.longitude ?? markers[0]?.longitude ?? -122.4324,
              latitudeDelta: 0.1,
              longitudeDelta: 0.1,
            }}
          >
            {startLocation && (
              <Marker
                coordinate={{
                  latitude: startLocation.latitude,
                  longitude: startLocation.longitude,
                }}
                title="Start / End"
                description="Your starting location"
              >
                <View style={styles.startPin}>
                  <Text style={styles.startPinText}>S</Text>
                </View>
              </Marker>
            )}

            {markers.map((marker, index) => (
              <Marker
                key={marker.id}
                coordinate={{
                  latitude: marker.latitude,
                  longitude: marker.longitude,
                }}
                title={`Stop ${index + 1}`}
                description={marker.address}
                onCalloutPress={() => navigateToStop(marker)}
              >
                <View
                  style={[
                    styles.numberedPin,
                    routeStarted &&
                      index === currentStopIndex &&
                      styles.numberedPinActive,
                  ]}
                >
                  <Text style={styles.numberedPinText}>{index + 1}</Text>
                </View>
              </Marker>
            ))}
          </MapView>
        ) : (
          <FlatList
            data={markers}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.resultsListContent}
            renderItem={({ item, index }) => (
              <View style={styles.resultRow}>
                <View
                  style={[
                    styles.resultNumber,
                    routeStarted &&
                      index === currentStopIndex &&
                      styles.resultNumberActive,
                  ]}
                >
                  <Text style={styles.resultNumberText}>{index + 1}</Text>
                </View>
                <Text style={styles.resultAddress} numberOfLines={2}>
                  {item.address}
                </Text>
                <TouchableOpacity onPress={() => navigateToStop(item)}>
                  <Text style={styles.resultNavLink}>Navigate</Text>
                </TouchableOpacity>
              </View>
            )}
          />
        )}

        {routeStarted && <ActiveRouteCard />}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.header}>My Route</Text>
        {stops.length > 0 && (
          <TouchableOpacity
            onPress={clearRoute}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.clearRouteText}>Clear Route</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder="Enter a stop address"
          value={address}
          onChangeText={setAddress}
        />
        <TouchableOpacity style={styles.scanButton} onPress={openScanner}>
          <Text style={styles.scanButtonText}>📷</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.button} onPress={addStop}>
          <Text style={styles.buttonText}>Add</Text>
        </TouchableOpacity>
      </View>

      {suggestions.length > 0 && (
        <View style={styles.suggestionsBox}>
          {suggestions.map((item, index) => (
            <TouchableOpacity
              key={index}
              style={styles.suggestionRow}
              onPress={() => selectSuggestion(item)}
            >
              <Text style={styles.suggestionText} numberOfLines={2}>
                {item.display_name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {stops.length > 0 && (
        <Text style={styles.pendingSummary}>
          {pendingCount} pending · {stops.length - pendingCount} handled
        </Text>
      )}

      <FlatList
        data={stops}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => (
          <View style={styles.stopRow}>
            <TouchableOpacity
              onPress={() => cycleStatus(item.id)}
              style={[
                styles.statusDot,
                { backgroundColor: STATUS_COLORS[item.status] },
              ]}
            >
              <Text style={styles.statusDotText}>{index + 1}</Text>
            </TouchableOpacity>
            <Text
              style={[
                styles.stopText,
                item.status !== "pending" && styles.stopTextHandled,
              ]}
              numberOfLines={1}
            >
              {item.address}
            </Text>
            <View style={styles.actions}>
              <TouchableOpacity
                onPress={() => moveStop(item.id, "up")}
                disabled={index === 0}
                style={styles.iconButton}
              >
                <Text style={[styles.iconText, index === 0 && styles.disabled]}>
                  ↑
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => moveStop(item.id, "down")}
                disabled={index === stops.length - 1}
                style={styles.iconButton}
              >
                <Text
                  style={[
                    styles.iconText,
                    index === stops.length - 1 && styles.disabled,
                  ]}
                >
                  ↓
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => deleteStop(item.id)}
                style={styles.iconButton}
              >
                <Text style={styles.deleteText}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>No stops yet — add one above.</Text>
        }
      />

      {errorMsg !== "" && <Text style={styles.error}>{errorMsg}</Text>}

      {SHOW_IN_APP_MAP && (
        <View style={styles.navAppRow}>
          <Text style={styles.roundTripLabel}>Navigate using</Text>
          <View style={styles.segmentedControl}>
            <TouchableOpacity
              style={[
                styles.segmentButton,
                navApp === "apple" && styles.segmentButtonActive,
              ]}
              onPress={() => setNavApp("apple")}
            >
              <Text
                style={[
                  styles.segmentButtonText,
                  navApp === "apple" && styles.segmentButtonTextActive,
                ]}
              >
                Apple Maps
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.segmentButton,
                navApp === "google" && styles.segmentButtonActive,
              ]}
              onPress={() => setNavApp("google")}
            >
              <Text
                style={[
                  styles.segmentButtonText,
                  navApp === "google" && styles.segmentButtonTextActive,
                ]}
              >
                Google Maps
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <View style={styles.roundTripRow}>
        <Text style={styles.roundTripLabel}>
          Round trip (start & end at my location)
        </Text>
        <Switch value={roundTrip} onValueChange={setRoundTrip} />
      </View>

      {stops.length > 0 && (
        <TouchableOpacity style={styles.mapButton} onPress={optimizeAndShow}>
          {loading ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text style={styles.mapButtonText}>Optimize & Show Route</Text>
          )}
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  header: { fontSize: 24, fontWeight: "bold" },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  clearRouteText: { color: "#e74c3c", fontSize: 14, fontWeight: "600" },
  inputRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 10,
  },
  button: {
    backgroundColor: "#208AEF",
    borderRadius: 8,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  buttonText: { color: "white", fontWeight: "600" },
  scanButton: {
    backgroundColor: "#f0f0f0",
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 12,
  },
  scanButtonText: { fontSize: 18 },
  camera: { flex: 1 },
  cameraOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "transparent",
  },
  cameraHint: {
    color: "white",
    textAlign: "center",
    fontSize: 14,
    marginBottom: 24,
    backgroundColor: "rgba(0,0,0,0.5)",
    padding: 8,
    marginHorizontal: 40,
    borderRadius: 8,
  },
  cameraControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  cameraCancelButton: {
    width: 70,
  },
  cameraCancelText: { color: "white", fontSize: 16, fontWeight: "600" },
  captureButton: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: "rgba(255,255,255,0.3)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 3,
    borderColor: "white",
  },
  captureButtonInner: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: "white",
  },
  pendingSummary: {
    color: "#666",
    fontSize: 13,
    marginBottom: 8,
  },
  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
    gap: 8,
  },
  statusDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  statusDotText: { color: "white", fontWeight: "bold", fontSize: 12 },
  stopText: { fontSize: 16, flex: 1 },
  stopTextHandled: {
    textDecorationLine: "line-through",
    color: "#999",
  },
  actions: { flexDirection: "row", gap: 4 },
  iconButton: { padding: 8 },
  iconText: { fontSize: 18, color: "#208AEF" },
  disabled: { color: "#ccc" },
  deleteText: { fontSize: 18, color: "#e74c3c" },
  empty: { textAlign: "center", color: "#999", marginTop: 40 },
  error: { color: "#e74c3c", textAlign: "center", marginTop: 8 },
  roundTripRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
  roundTripLabel: { fontSize: 14, color: "#333", flex: 1, marginRight: 8 },
  navAppRow: {
    marginTop: 12,
  },
  segmentedControl: {
    flexDirection: "row",
    backgroundColor: "#f0f0f0",
    borderRadius: 8,
    padding: 3,
    marginTop: 6,
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: "center",
  },
  segmentButtonActive: {
    backgroundColor: "#208AEF",
  },
  segmentButtonText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#666",
  },
  segmentButtonTextActive: {
    color: "white",
  },
  mapButton: {
    backgroundColor: "#208AEF",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    marginTop: 12,
  },
  mapButtonText: { color: "white", fontWeight: "600", fontSize: 16 },
  mapHeader: { padding: 12 },
  backButton: { color: "#208AEF", fontSize: 16, fontWeight: "600" },
  hint: { color: "#999", fontSize: 12, marginTop: 4 },
  map: { flex: 1 },
  numberedPin: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#208AEF",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "white",
  },
  numberedPinText: {
    color: "white",
    fontWeight: "bold",
    fontSize: 14,
  },
  numberedPinActive: {
    backgroundColor: "#e74c3c",
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  startPin: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#2ecc71",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "white",
  },
  startPinText: {
    color: "white",
    fontWeight: "bold",
    fontSize: 16,
  },
  suggestionsBox: {
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    marginTop: -8,
    marginBottom: 16,
  },
  suggestionRow: {
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  suggestionText: { fontSize: 14, color: "#333" },
  fullRouteButton: {
    backgroundColor: "#208AEF",
    borderRadius: 8,
    padding: 10,
    alignItems: "center",
    marginTop: 8,
  },
  fullRouteButtonText: { color: "white", fontWeight: "600" },
  resultsListContent: {
    padding: 16,
  },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
    gap: 10,
  },
  resultNumber: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#208AEF",
    justifyContent: "center",
    alignItems: "center",
  },
  resultNumberActive: {
    backgroundColor: "#e74c3c",
  },
  resultNumberText: { color: "white", fontWeight: "bold", fontSize: 13 },
  resultAddress: { fontSize: 15, flex: 1 },
  resultNavLink: { color: "#208AEF", fontWeight: "600", fontSize: 13 },
  activeRouteCard: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "white",
    padding: 16,
    paddingBottom: 32,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 8,
  },
  activeRouteProgress: {
    color: "#208AEF",
    fontWeight: "bold",
    fontSize: 14,
    marginBottom: 4,
  },
  activeRouteAddress: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 16,
  },
  activeRouteButtons: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 12,
  },
  skipButton: {
    flex: 1,
    backgroundColor: "#f0f0f0",
    borderRadius: 8,
    padding: 12,
    alignItems: "center",
  },
  skipButtonText: { color: "#666", fontWeight: "600", fontSize: 14 },
  failedButton: {
    flex: 1,
    backgroundColor: "#fdecea",
    borderRadius: 8,
    padding: 12,
    alignItems: "center",
  },
  failedButtonText: { color: "#e74c3c", fontWeight: "600", fontSize: 14 },
  completeButton: {
    flex: 1.3,
    backgroundColor: "#208AEF",
    borderRadius: 8,
    padding: 12,
    alignItems: "center",
  },
  completeButtonText: { color: "white", fontWeight: "600", fontSize: 14 },
  navigateAgainButton: {
    alignItems: "center",
    marginBottom: 8,
  },
  navigateAgainText: { color: "#208AEF", fontSize: 14, fontWeight: "600" },
  endRouteButton: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  endRouteText: {
    color: "#e74c3c",
    textAlign: "center",
    fontSize: 15,
    fontWeight: "600",
  },
});
