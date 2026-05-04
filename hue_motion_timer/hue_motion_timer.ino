/*
 * Hue Motion Sensor Timer for M5Stack
 *
 * Features:
 *   1. Auto-discover Hue Bridge (mDNS + discovery.meethue.com)
 *   2. Wait for Bridge button press to auto-generate API key
 *   3. Select presence sensor from sensor list (button UI)
 *   4. Real-time display of elapsed time since motion detection
 *
 * Settings are saved to NVS; auto-connects from the second boot onward.
 * Pre-configure config.h to skip the setup wizard.
 *
 * Button controls (main screen):
 *   BtnA (left)  : Reset settings -> reboot
 *   BtnC (right) : Manual refresh
 *
 * Required libraries:
 *   - M5Unified
 *   - ArduinoJson
 *   - WiFi / HTTPClient / Preferences / ESPmDNS (ESP32 built-in)
 */

#include <M5Unified.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <ESPmDNS.h>

#include "config.h"

// ─── Language file ───
#if UI_LANG == 1
  #include "lang_en.h"
#else
  #include "lang_ja.h"
#endif

// ─── config.h validation ───
#if POLL_INTERVAL < 500
  #error "POLL_INTERVAL must be >= 500"
#endif
#if RESET_TIMEOUT < 10000
  #error "RESET_TIMEOUT must be >= 10000"
#endif
#if SPEAKER_VOLUME < 0 || SPEAKER_VOLUME > 255
  #error "SPEAKER_VOLUME must be 0-255"
#endif
#if DEFAULT_URGENT_MINUTE < 0
  #error "DEFAULT_URGENT_MINUTE must be >= 0"
#endif

// efont Japanese font data (loaded based on language setting)
#if USE_EFONT
  static const lgfx::U8g2font fontJA10(lgfx_efont_ja_10);
  static const lgfx::U8g2font fontJA12(lgfx_efont_ja_12);
  static const lgfx::U8g2font fontJA14(lgfx_efont_ja_14);
  static const lgfx::U8g2font fontJA16(lgfx_efont_ja_16);
  static const lgfx::U8g2font fontJA24(lgfx_efont_ja_24);
  void setFontSmall()  { M5.Display.setFont(&fontJA10); }
  void setFontMed()    { M5.Display.setFont(&fontJA14); }
  void setFontLarge()  { M5.Display.setFont(&fontJA16); }
  void setFontXL()     { M5.Display.setFont(&fontJA24); }
#else
  void setFontSmall()  { M5.Display.setTextSize(1); }
  void setFontMed()    { M5.Display.setTextSize(2); }
  void setFontLarge()  { M5.Display.setTextSize(2); }
  void setFontXL()     { M5.Display.setTextSize(3); }
#endif

// ─── HTTPS client (Bridge uses self-signed cert) ───
WiFiClientSecure secureClient;

// ─── Global variables ─────────────────────────────────
Preferences prefs;

String bridgeIP;
String apiKey;
String sensorName;
String sensorID;
String wifiSSID;
String wifiPass;

bool presenceDetected = false;
unsigned long lastDetectedMillis = 0;
unsigned long lastNoMotionMillis = 0;  // Time when no-motion started
unsigned long lastPresenceMillis = 0;  // Last detection time (for display hold)
bool everDetected = false;
String lastUpdated = "";

String prevElapsedStr = "";
String prevStatusStr  = "";
int prevBattPct = -1;
String prevTimeStr = "";

// Alert management: fire once per threshold
bool alertFired[5] = {false, false, false, false, false};

// Boot recovery flag
bool bootRecoveryDone = false;

// Urgent alert minute (can be overridden from web)
int urgentMinute = DEFAULT_URGENT_MINUTE;

// Daily max record
unsigned long dailyMaxMs = 0;
int dailyMaxDay = -1;  // tracked by tm_yday
String prevRecordStr = "";

// Helper to build Bridge API URL
String bridgeURL(String path) {
  return "https://" + bridgeIP + path;
}

// ─── Prototypes ───────────────────────────────────
void setupWiFi();
void setupHueBridge();
void setupHueApiKey();
void setupHueSensor();
bool discoverBridgeMDNS();
bool discoverBridgeCloud();
String generateApiKey();
bool resolveSensorID();
bool fetchSensorState();
void drawUI(bool forceRedraw);
String readSerialLine(const char* prompt);
String formatElapsed(unsigned long ms);
void haltWithError(const char* msg);
void playHotaruNoHikari();
void playEvaAlert();
void checkAlerts();
void saveTimerState();
void restoreTimerState();
void checkRemoteAlert();
void saveLogEntry(unsigned long elapsedMs);
void saveDailyStats(unsigned long elapsedMs);
void showLogScreen();
void showDailyStatsScreen();
void showSettingsMenu();
unsigned long getTodayMaxFromStats();
String getTodayMaxTimeFromLog();

#define LOG_MAX 20
#define DAILY_MAX 10

// ═══════════════════════════════════════════════════
// setup / loop
// ═══════════════════════════════════════════════════
void setup() {
  auto cfg = M5.config();
  M5.begin(cfg);
  Serial.begin(115200);

  M5.Display.fillScreen(TFT_BLACK);
  setFontLarge();
  M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  M5.Display.setCursor(0, 0);
  M5.Display.println("Hue Motion Timer");

  prefs.begin("hue", false);

  setupWiFi();
  setupHueBridge();
  setupHueApiKey();
  setupHueSensor();

  // Restore timer state (if within 1 minute of reboot)
  restoreTimerState();

  M5.Display.fillScreen(TFT_BLACK);
  drawUI(true);
}

void loop() {
  static unsigned long lastPoll = 0;
  M5.update();

  if (M5.BtnA.wasPressed()) {
    showSettingsMenu();
    M5.Display.fillScreen(TFT_BLACK);
    drawUI(true);
  }

  if (M5.BtnC.wasPressed()) {
    lastPoll = 0;
  }

  if (M5.BtnB.wasPressed()) {
    showLogScreen();
    M5.Display.fillScreen(TFT_BLACK);
    drawUI(true);
  }

  // Auto-reconnect on WiFi disconnect
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(1000);
  }

  unsigned long now = millis();
  if (now - lastPoll >= POLL_INTERVAL) {
    lastPoll = now;
    fetchSensorState();
  }

  drawUI(false);
  checkAlerts();

  // Poll remote alert from web server (every 5s)
  static unsigned long lastAlertCheck = 0;
  if (millis() - lastAlertCheck >= 5000) {
    lastAlertCheck = millis();
    checkRemoteAlert();
  }

  // Save timer state to NVS every 10s
  static unsigned long lastSave = 0;
  if (millis() - lastSave >= 10000) {
    lastSave = millis();
    saveTimerState();
  }

  delay(100);
}

// ═══════════════════════════════════════════════════
// WiFi connection
// ═══════════════════════════════════════════════════
void setupWiFi() {
  wifiSSID = prefs.getString("ssid", WIFI_SSID);
  wifiPass = prefs.getString("pass", WIFI_PASS);

  if (wifiSSID.length() == 0) {
    wifiSSID = readSerialLine("WiFi SSID: ");
    wifiPass = readSerialLine("WiFi Password: ");
    prefs.putString("ssid", wifiSSID);
    prefs.putString("pass", wifiPass);
  }

  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);

  setFontMed();
  M5.Display.printf("WiFi: %s\n", wifiSSID.c_str());

  // WiFi module initialization
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true);
  delay(1000);

  // Retry up to 3 times
  for (int attempt = 1; attempt <= 3; attempt++) {
    WiFi.begin(wifiSSID.c_str(), wifiPass.c_str());

    int retry = 0;
    while (WiFi.status() != WL_CONNECTED && retry < 40) {
      delay(500);
      M5.Display.print(".");
      retry++;
    }

    if (WiFi.status() == WL_CONNECTED) break;

    if (attempt < 3) {
      WiFi.disconnect(true);
      delay(1000);
    }
  }

  if (WiFi.status() != WL_CONNECTED) {
    haltWithError("WiFi接続に失敗しました");
  }

  M5.Display.printf("\nIP: %s\n", WiFi.localIP().toString().c_str());
  secureClient.setInsecure();

  // NTP time sync (JST = UTC+9)
  configTime(9 * 3600, 0, "ntp.nict.jp", "pool.ntp.org");

  delay(500);
}

// ═══════════════════════════════════════════════════
// Bridge discovery
// ═══════════════════════════════════════════════════
void setupHueBridge() {
  bridgeIP = prefs.getString("bridge", HUE_BRIDGE_IP);

  if (bridgeIP.length() > 0) {
    M5.Display.printf("Bridge: %s\n", bridgeIP.c_str());
    return;
  }

  M5.Display.println("\nBridgeを探索中...");

  if (discoverBridgeMDNS() || discoverBridgeCloud()) {
    M5.Display.printf("発見: %s\n", bridgeIP.c_str());
    prefs.putString("bridge", bridgeIP);
    delay(500);
    return;
  }

  M5.Display.println("自動探索に失敗しました");
  bridgeIP = readSerialLine("Bridge IP: ");
  prefs.putString("bridge", bridgeIP);
}

bool discoverBridgeMDNS() {
  if (!MDNS.begin("m5stack")) return false;
  M5.Display.print(" mDNS...");
  int n = MDNS.queryService("hue", "tcp");
  if (n > 0) {
    bridgeIP = MDNS.address(0).toString();
    MDNS.end();
    return true;
  }
  MDNS.end();
  return false;
}

bool discoverBridgeCloud() {
  M5.Display.print(" Cloud...");
  HTTPClient http;
  http.begin("https://discovery.meethue.com");
  http.setTimeout(5000);
  int code = http.GET();
  if (code != 200) { http.end(); return false; }
  String payload = http.getString();
  http.end();

  JsonDocument doc;
  if (deserializeJson(doc, payload)) return false;
  JsonArray arr = doc.as<JsonArray>();
  if (arr.size() == 0) return false;
  const char* ip = arr[0]["internalipaddress"] | "";
  if (strlen(ip) == 0) return false;
  bridgeIP = String(ip);
  return true;
}

// ═══════════════════════════════════════════════════
// API key generation
// ═══════════════════════════════════════════════════
void setupHueApiKey() {
  apiKey = prefs.getString("apikey", HUE_API_KEY);

  if (apiKey.length() > 0) {
    M5.Display.println("API Key: OK");
    return;
  }

  M5.Display.fillScreen(TFT_BLACK);
  setFontLarge();
  M5.Display.setTextColor(TFT_YELLOW, TFT_BLACK);
  M5.Display.setCursor(10, 40);
  M5.Display.println("Hue Bridgeのボタンを");
  M5.Display.println("押してください");
  M5.Display.println("");
  setFontSmall();
  M5.Display.setTextColor(TFT_DARKGREY, TFT_BLACK);
  M5.Display.println("3秒ごとに自動リトライします");

  unsigned long start = millis();
  while (millis() - start < 60000) {
    M5.update();

    String key = generateApiKey();
    if (key.length() > 0) {
      apiKey = key;
      prefs.putString("apikey", apiKey);
      M5.Display.fillScreen(TFT_BLACK);
      setFontLarge();
      M5.Display.setTextColor(TFT_GREEN, TFT_BLACK);
      M5.Display.setCursor(10, 60);
      M5.Display.println("APIキーを取得しました!");
      delay(1000);
      return;
    }

    int remaining = (60000 - (millis() - start)) / 1000;
    M5.Display.fillRect(0, 180, 320, 20, TFT_BLACK);
    setFontMed();
    M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
    M5.Display.setCursor(10, 180);
    M5.Display.printf("リトライ中... %d秒", remaining);
    delay(3000);
  }

  haltWithError("APIキー取得がタイムアウトしました");
}

String generateApiKey() {
  HTTPClient http;
  http.begin(secureClient, bridgeURL("/api"));
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);

  int code = http.POST("{\"devicetype\":\"m5stack#hue_timer\"}");
  Serial.printf("[Hue] POST /api -> code: %d\n", code);

  if (code <= 0) {
    Serial.printf("[Hue] Connection error: %s\n", http.errorToString(code).c_str());
    // Show error on LCD
    setFontSmall();
    M5.Display.fillRect(0, 160, 320, 14, TFT_BLACK);
    M5.Display.setTextColor(TFT_RED, TFT_BLACK);
    M5.Display.setCursor(10, 160);
    M5.Display.printf("Error: %s", http.errorToString(code).c_str());
    http.end();
    return "";
  }

  String payload = http.getString();
  http.end();
  Serial.printf("[Hue] Response: %s\n", payload.c_str());

  JsonDocument doc;
  if (deserializeJson(doc, payload)) return "";

  const char* username = doc[0]["success"]["username"] | "";
  if (strlen(username) > 0) return String(username);

  // Show error details on LCD
  int errType = doc[0]["error"]["type"] | 0;
  const char* errDesc = doc[0]["error"]["description"] | "unknown";
  Serial.printf("[Hue] API key error type: %d, desc: %s\n", errType, errDesc);
  setFontSmall();
  M5.Display.fillRect(0, 160, 320, 14, TFT_BLACK);
  M5.Display.setTextColor(TFT_ORANGE, TFT_BLACK);
  M5.Display.setCursor(10, 160);
  M5.Display.printf("Hue: %s", errDesc);
  return "";
}

// ═══════════════════════════════════════════════════
// Sensor selection
// ═══════════════════════════════════════════════════
void setupHueSensor() {
  sensorName = prefs.getString("sname", HUE_SENSOR_NAME);

  if (sensorName.length() > 0) {
    setFontMed();
    M5.Display.printf("センサー: %s\n", sensorName.c_str());
    if (resolveSensorID()) {
      M5.Display.printf("  -> ID: %s\n", sensorID.c_str());
      delay(500);
      return;
    }
    M5.Display.println("  見つかりません。再選択...");
  }

  M5.Display.fillScreen(TFT_BLACK);
  setFontLarge();
  M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  M5.Display.setCursor(10, 5);
  M5.Display.println("センサー読込中...");

  HTTPClient http;
  http.begin(secureClient, bridgeURL("/api/" + apiKey + "/sensors"));
  http.setTimeout(5000);

  int code = http.GET();
  if (code != 200) { http.end(); haltWithError("センサー取得に失敗"); }

  String payload = http.getString();
  http.end();

  JsonDocument doc;
  if (deserializeJson(doc, payload)) { haltWithError("JSON解析エラー"); }

  String names[20];
  String ids[20];
  int count = 0;

  JsonObject root = doc.as<JsonObject>();
  for (JsonPair kv : root) {
    const char* type = kv.value()["type"] | "";
    if (String(type) == "ZLLPresence" && count < 20) {
      ids[count]   = String(kv.key().c_str());
      names[count] = String((const char*)(kv.value()["name"] | "unknown"));
      count++;
    }
  }

  if (count == 0) { haltWithError("人感センサーが見つかりません"); }

  // Selection UI
  int selected = 0;
  bool needRedraw = true;

  while (true) {
    M5.update();

    if (needRedraw) {
      M5.Display.fillScreen(TFT_BLACK);
      setFontLarge();
      M5.Display.setTextColor(TFT_CYAN, TFT_BLACK);
      M5.Display.setCursor(10, 5);
      M5.Display.println("センサーを選択:");

      int startIdx = max(0, selected - 2);
      int endIdx   = min(count, startIdx + 5);

      setFontMed();
      for (int i = startIdx; i < endIdx; i++) {
        int y = 30 + (i - startIdx) * 28;
        if (i == selected) {
          M5.Display.fillRect(0, y - 2, 320, 26, 0x1082);
          M5.Display.setTextColor(TFT_YELLOW, 0x1082);
          M5.Display.setCursor(10, y);
          M5.Display.printf("> %s", names[i].c_str());
        } else {
          M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
          M5.Display.setCursor(20, y);
          M5.Display.print(names[i]);
        }
      }

      setFontSmall();
      M5.Display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
      M5.Display.setCursor(10, 210);
      M5.Display.printf("  %d / %d", selected + 1, count);
      M5.Display.setCursor(5, 225);
      M5.Display.print("[A] 前");
      M5.Display.setCursor(120, 225);
      M5.Display.print("[B] 決定");
      M5.Display.setCursor(245, 225);
      M5.Display.print("[C] 次");

      needRedraw = false;
    }

    if (M5.BtnA.wasPressed() && selected > 0) { selected--; needRedraw = true; }
    if (M5.BtnC.wasPressed() && selected < count - 1) { selected++; needRedraw = true; }
    if (M5.BtnB.wasPressed()) break;
    delay(50);
  }

  sensorName = names[selected];
  sensorID   = ids[selected];
  prefs.putString("sname", sensorName);

  M5.Display.fillScreen(TFT_BLACK);
  setFontLarge();
  M5.Display.setTextColor(TFT_GREEN, TFT_BLACK);
  M5.Display.setCursor(10, 60);
  M5.Display.printf("選択: %s\n (ID: %s)", sensorName.c_str(), sensorID.c_str());
  delay(1500);
}

// ═══════════════════════════════════════════════════
// Resolve sensor name to ID
// ═══════════════════════════════════════════════════
bool resolveSensorID() {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  http.begin(secureClient, bridgeURL("/api/" + apiKey + "/sensors"));
  http.setTimeout(5000);
  int code = http.GET();
  if (code != 200) { http.end(); return false; }
  String payload = http.getString();
  http.end();

  JsonDocument doc;
  if (deserializeJson(doc, payload)) return false;
  JsonObject root = doc.as<JsonObject>();
  for (JsonPair kv : root) {
    const char* name = kv.value()["name"] | "";
    const char* type = kv.value()["type"] | "";
    if (String(type) == "ZLLPresence" && String(name) == sensorName) {
      sensorID = String(kv.key().c_str());
      return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════
// Fetch sensor state
// ═══════════════════════════════════════════════════
bool fetchSensorState() {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  http.begin(secureClient, bridgeURL("/api/" + apiKey + "/sensors/" + sensorID));
  http.setTimeout(3000);
  int code = http.GET();
  if (code != 200) { http.end(); return false; }
  String payload = http.getString();
  http.end();

  JsonDocument doc;
  if (deserializeJson(doc, payload)) return false;
  if (doc.is<JsonArray>()) return false;

  bool newPresence = doc["state"]["presence"] | false;
  const char* updatedStr = doc["state"]["lastupdated"] | "unknown";
  lastUpdated = String(updatedStr);

  if (newPresence && !everDetected) {
    // Start timer on first detection only
    lastDetectedMillis = millis();
    everDetected = true;
  }

  // Record detection time (for display hold)
  if (newPresence) {
    lastPresenceMillis = millis();
  }

  // Track no-motion start time
  if (everDetected) {
    if (newPresence) {
      // Motion detected: reset no-motion timer
      lastNoMotionMillis = 0;
    } else if (!newPresence && lastNoMotionMillis == 0) {
      // No motion and no-motion start not yet recorded
      lastNoMotionMillis = millis();
    }
  }

  presenceDetected = newPresence;

  // Reset timer after continuous no-motion
  if (everDetected && !presenceDetected && lastNoMotionMillis > 0) {
    unsigned long noMotionDuration = millis() - lastNoMotionMillis;
    if (noMotionDuration >= RESET_TIMEOUT) {
      // Save log: subtract no-motion time from total elapsed
      unsigned long totalElapsed = millis() - lastDetectedMillis;
      unsigned long actualMs = (totalElapsed > RESET_TIMEOUT) ? totalElapsed - RESET_TIMEOUT : 0;
      saveLogEntry(actualMs);
      everDetected = false;
      lastDetectedMillis = 0;
      lastNoMotionMillis = 0;
      memset(alertFired, false, sizeof(alertFired));
      prefs.putULong("elapsed", 0);
      prefs.putULong("savetime", 0);
    }
  }

  return true;
}

// ═══════════════════════════════════════════════════
// LCD rendering
// ═══════════════════════════════════════════════════
void drawUI(bool forceRedraw) {
  unsigned long elapsed = everDetected ? millis() - lastDetectedMillis : 0;
  String elapsedStr = everDetected ? formatElapsed(elapsed) : "--:--:--";
  String statusStr;
  uint16_t statusColor;

  // Update daily max record (for comparison with current timer)
  struct tm ti;
  if (everDetected && getLocalTime(&ti, 0)) {
    int today = ti.tm_yday;
    if (today != dailyMaxDay) {
      dailyMaxDay = today;
      dailyMaxMs = 0;
    }
    if (elapsed > dailyMaxMs) {
      dailyMaxMs = elapsed;
    }
  }

  // MAX display: larger of daily stats max and current timer
  unsigned long statsMax = getTodayMaxFromStats() * 1000;
  // Also consider in-progress timer (show even if under 3 min)
  unsigned long currentActual = elapsed;
  unsigned long dailyMaxDisplay = (statsMax > currentActual) ? statsMax : currentActual;

  if (!everDetected) {
    statusStr = L_WAITING;
    statusColor = TFT_DARKGREY;
  } else if (presenceDetected || (millis() - lastPresenceMillis < 5000)) {
    statusStr = L_DETECTED;
    statusColor = TFT_RED;
  } else {
    statusStr = L_NO_MOTION;
    statusColor = TFT_GREEN;
  }

  if (forceRedraw) {
    setFontLarge();
    M5.Display.setTextColor(TFT_CYAN, TFT_BLACK);
    M5.Display.setCursor(10, 8);
    M5.Display.print("Hue Motion Timer");

    setFontSmall();
    M5.Display.setTextColor(TFT_DARKGREY, TFT_BLACK);
    M5.Display.setCursor(10, 28);
    M5.Display.printf("Bridge: %s", bridgeIP.c_str());
    setFontMed();
    M5.Display.setCursor(10, 42);
    M5.Display.printf("センサー: %s", sensorName.c_str());

    setFontMed();
    M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
    M5.Display.setCursor(20, 65);
    M5.Display.print(L_STATUS);

    setFontSmall();
    M5.Display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
    M5.Display.setCursor(10, 225);
    M5.Display.print("[A] "); M5.Display.print(L_SETTINGS);
    M5.Display.setCursor(120, 225);
    M5.Display.print("[B] "); M5.Display.print(L_LOGS);
    M5.Display.setCursor(240, 225);
    M5.Display.print("[C] "); M5.Display.print(L_REFRESH);

    prevElapsedStr = "";
    prevStatusStr  = "";
    prevBattPct    = -1;
    prevTimeStr    = "";
    prevRecordStr  = "";
  }

  if (forceRedraw || statusStr != prevStatusStr) {
    M5.Display.fillRect(20, 84, 280, 30, TFT_BLACK);
    setFontXL();
    M5.Display.setTextColor(statusColor, TFT_BLACK);
    M5.Display.setCursor(20, 86);
    M5.Display.print(statusStr);
    prevStatusStr = statusStr;
  }

  if (forceRedraw || elapsedStr != prevElapsedStr) {
    M5.Display.fillRect(0, 120, 320, 90, TFT_BLACK);
    setFontXL();
    M5.Display.setTextSize(3);
    M5.Display.setTextColor(TFT_YELLOW, TFT_BLACK);
    M5.Display.setCursor(10, 125);
    M5.Display.print(elapsedStr);
    M5.Display.setTextSize(1);  // reset
    prevElapsedStr = elapsedStr;
  }

  // ── Daily max record (bottom) ──
  String recordStr = "";
  if (dailyMaxDisplay > 0 && getLocalTime(&ti, 0)) {
    String maxTime = getTodayMaxTimeFromLog();
    char rb[48];
    if (maxTime.length() > 0) {
      sprintf(rb, "%02d/%02d MAX %s (%s)", ti.tm_mon + 1, ti.tm_mday,
        formatElapsed(dailyMaxDisplay).c_str(), maxTime.c_str());
    } else {
      sprintf(rb, "%02d/%02d MAX %s", ti.tm_mon + 1, ti.tm_mday,
        formatElapsed(dailyMaxDisplay).c_str());
    }
    recordStr = String(rb);
  }
  if (forceRedraw || recordStr != prevRecordStr) {
    M5.Display.fillRect(0, 208, 320, 16, TFT_BLACK);
    if (recordStr.length() > 0) {
      setFontMed();
      M5.Display.setTextColor(TFT_ORANGE, TFT_BLACK);
      M5.Display.setCursor(10, 210);
      M5.Display.print(recordStr);
    }
    prevRecordStr = recordStr;
  }

  // ── Clock + Battery (top right) ──
  String timeStr = "";
  if (getLocalTime(&ti, 0)) {
    char tb[6];
    sprintf(tb, "%02d:%02d", ti.tm_hour, ti.tm_min);
    timeStr = String(tb);
  }

  int battPct = M5.Power.getBatteryLevel();

  if (forceRedraw || timeStr != prevTimeStr || battPct != prevBattPct) {
    M5.Display.fillRect(180, 0, 140, 18, TFT_BLACK);
    setFontMed();

    // Clock
    if (timeStr.length() > 0) {
      M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
      M5.Display.setCursor(210, 2);
      M5.Display.print(timeStr);
    }

    // Battery
    uint16_t battColor = (battPct > 50) ? TFT_GREEN : (battPct > 20) ? TFT_YELLOW : TFT_RED;
    M5.Display.setTextColor(battColor, TFT_BLACK);
    M5.Display.setCursor(275, 2);
    M5.Display.printf("%d%%", battPct);

    prevTimeStr = timeStr;
    prevBattPct = battPct;
  }
}

// ═══════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════
String formatElapsed(unsigned long ms) {
  unsigned long t = ms / 1000;
  char buf[16];
  sprintf(buf, "%02lu:%02lu:%02lu", t / 3600, (t % 3600) / 60, t % 60);
  return String(buf);
}

String readSerialLine(const char* prompt) {
  setFontSmall();
  M5.Display.setTextColor(TFT_YELLOW, TFT_BLACK);
  M5.Display.print(prompt);
  Serial.print(prompt);

  String input = "";
  while (true) {
    if (Serial.available()) {
      char c = Serial.read();
      if (c == '\n' || c == '\r') {
        if (input.length() > 0) break;
      } else {
        input += c;
      }
    }
    delay(10);
  }

  M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  M5.Display.println(input);
  Serial.println(input);
  return input;
}

void haltWithError(const char* msg) {
  M5.Display.fillScreen(TFT_BLACK);
  setFontLarge();
  M5.Display.setTextColor(TFT_RED, TFT_BLACK);
  M5.Display.setCursor(10, 80);
  M5.Display.println(msg);
  setFontSmall();
  M5.Display.setTextColor(TFT_DARKGREY, TFT_BLACK);
  M5.Display.setCursor(10, 130);
  M5.Display.println("[A] 設定リセット & 再起動");
  while (true) {
    M5.update();
    if (M5.BtnA.wasPressed()) {
      prefs.clear();
      ESP.restart();
    }
    delay(100);
  }
}

// ═══════════════════════════════════════════════════
// Alert melody
// ═══════════════════════════════════════════════════
// Note definitions: frequency (Hz), 0=rest
#define NOTE_C4  262
#define NOTE_D4  294
#define NOTE_E4  330
#define NOTE_F4  349
#define NOTE_G4  392
#define NOTE_A4  440
#define NOTE_B4  494
#define NOTE_C5  523
#define NOTE_D5  587
#define NOTE_E5  659
#define NOTE_REST 0

// ─── Urgent alert sound ───
void playEvaAlert() {
  M5.Speaker.setVolume(SPEAKER_VOLUME);

  // Alternating high-low tones x3
  for (int i = 0; i < 3; i++) {
    M5.Speaker.tone(988, 300);   // B5 high
    delay(300);
    M5.Speaker.stop();
    delay(50);
    M5.Speaker.tone(740, 300);   // F#5 low
    delay(300);
    M5.Speaker.stop();
    delay(50);
  }
  delay(300);
}

void playHotaruNoHikari() {
  const int Q = 400;   // quarter note
  const int H = 800;   // half note
  const int E = 200;   // eighth note
  const int DQ = 600;  // dotted quarter note

  // Alert melody (Auld Lang Syne) Key of G
  // D | G  G-G-B | A  G-A-B | G-G-B  D5 | E5
  // E5 | D5  B-B-G | A  G-A | B-A  G-E  E-D | G
  struct { int freq; int dur; } melody[] = {
    {NOTE_D4, Q},                      // (pickup) Should
    {NOTE_G4, DQ}, {NOTE_G4, E},       // old ac-
    {NOTE_G4, Q},  {NOTE_B4, Q},       // quain-tance
    {NOTE_A4, Q},  {NOTE_G4, DQ},      // be for-
    {NOTE_A4, E},  {NOTE_B4, Q},       // got and
    {NOTE_G4, DQ}, {NOTE_G4, E},       // ne-ver
    {NOTE_B4, Q},  {NOTE_D5, Q},       // brought to
    {NOTE_E5, H},                      // mind?
    {NOTE_E5, Q},  {NOTE_D5, DQ},      // Should old
    {NOTE_B4, E},  {NOTE_B4, DQ},      // ac-quain-
    {NOTE_G4, E},  {NOTE_A4, Q},       // tance be
    {NOTE_G4, DQ}, {NOTE_A4, E},       // for-got and
    {NOTE_B4, Q},  {NOTE_A4, Q},       // old lang
    {NOTE_G4, Q},  {NOTE_E4, Q},       // 
    {NOTE_E4, Q},  {NOTE_D4, Q},       // syne
    {NOTE_G4, H},                      // ?
  };

  int count = sizeof(melody) / sizeof(melody[0]);

  M5.Speaker.setVolume(SPEAKER_VOLUME);
  for (int i = 0; i < count; i++) {
    if (melody[i].freq == NOTE_REST) {
      delay(melody[i].dur);
    } else {
      M5.Speaker.tone(melody[i].freq, melody[i].dur);
      delay(melody[i].dur);
    }
    delay(30); // gap between notes
  }
  M5.Speaker.stop();
}

// ═══════════════════════════════════════════════════
// Elapsed time alert check
// ═══════════════════════════════════════════════════
void checkAlerts() {
  if (!everDetected) return;

  unsigned long elapsed = millis() - lastDetectedMillis;
  long realMins = (long)elapsed / 60000;
  if (realMins < 0) return;

  // Check ALERT_MIN_1~5 from config.h in descending order
  const int alertMins[5] = {ALERT_MIN_5, ALERT_MIN_4, ALERT_MIN_3, ALERT_MIN_2, ALERT_MIN_1};

  for (int i = 0; i < 5; i++) {
    if (alertMins[i] <= 0) continue;  // 0 = disabled
    if (realMins >= alertMins[i] && !alertFired[i]) {
      alertFired[i] = true;
      if (alertMins[i] == urgentMinute) {
        playEvaAlert();
      }
      playHotaruNoHikari();
      break;  // only play one alert per loop
    }
  }
}

// ═══════════════════════════════════════════════════
// Timer state save/restore (NVS + NTP epoch)
// ═══════════════════════════════════════════════════
void saveTimerState() {
  if (!everDetected) return;

  time_t now;
  time(&now);
  if (now < 1000000) return;  // NTP not synced

  unsigned long elapsedMs = millis() - lastDetectedMillis;
  prefs.putULong("elapsed", elapsedMs / 1000);  // save in seconds
  prefs.putULong("savetime", (unsigned long)now);
}

void restoreTimerState() {
  unsigned long savedElapsed = prefs.getULong("elapsed", 0);
  unsigned long savedTime    = prefs.getULong("savetime", 0);

  if (savedElapsed == 0 || savedTime == 0) {
    Serial.println("[Recovery] No saved state");
    return;
  }

  // Wait up to 10 seconds for NTP sync
  Serial.println("[Recovery] Waiting for NTP sync...");
  time_t now;
  for (int i = 0; i < 20; i++) {
    time(&now);
    if (now > 1000000) break;
    delay(500);
  }
  if (now < 1000000) {
    Serial.println("[Recovery] NTP not synced, skip");
    return;
  }

  long sinceReboot = (long)(now - (time_t)savedTime);
  Serial.printf("[Recovery] savedElapsed=%lu sec, sinceReboot=%ld sec\n", savedElapsed, sinceReboot);

  // Restore if saved within 1 minute
  if (sinceReboot >= 0 && sinceReboot <= 60) {
    unsigned long totalElapsed = (savedElapsed + (unsigned long)sinceReboot) * 1000;
    lastDetectedMillis = millis() - totalElapsed;
    everDetected = true;
    lastNoMotionMillis = millis();  // start 3-min no-motion countdown on restore
    bootRecoveryDone = true;
    Serial.printf("[Recovery] Restored timer: %lu sec total\n", totalElapsed / 1000);
  } else {
    Serial.printf("[Recovery] Too old (%ld sec), skip\n", sinceReboot);
  }
}

// ═══════════════════════════════════════════════════
// Log recording (NVS ring buffer, max 20 entries)
// Each entry: "MM/DD HH:MM HH:MM:SS" (date time elapsed)
// ═══════════════════════════════════════════════════
void saveLogEntry(unsigned long elapsedMs) {
  struct tm ti;
  if (!getLocalTime(&ti, 0)) return;

  char entry[24];
  String elapsed = formatElapsed(elapsedMs);
  sprintf(entry, "%02d/%02d %02d:%02d %s",
    ti.tm_mon + 1, ti.tm_mday,
    ti.tm_hour, ti.tm_min,
    elapsed.c_str());

  // Ring buffer index
  int idx = prefs.getInt("logIdx", 0);
  char key[8];
  sprintf(key, "log%02d", idx % LOG_MAX);
  prefs.putString(key, String(entry));
  prefs.putInt("logIdx", idx + 1);

  Serial.printf("[Log] Saved #%d: %s\n", idx, entry);

  // Update daily stats
  saveDailyStats(elapsedMs);
}

// ═══════════════════════════════════════════════════
// Log display screen (called by BtnB)
// A: prev page, B: back, C: next page
// ═══════════════════════════════════════════════════
void showLogScreen() {
  int totalIdx = prefs.getInt("logIdx", 0);
  int count = (totalIdx < LOG_MAX) ? totalIdx : LOG_MAX;

  if (count == 0) {
    M5.Display.fillScreen(TFT_BLACK);
    setFontLarge();
    M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
    M5.Display.setCursor(40, 100);
    M5.Display.print("ログがありません");
    setFontSmall();
    M5.Display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
    M5.Display.setCursor(10, 225);
    M5.Display.print("[B] 日別");
    while (true) {
      M5.update();
      if (M5.BtnB.wasPressed()) {
        showDailyStatsScreen();
        return;
      }
      if (M5.BtnA.wasPressed() || M5.BtnC.wasPressed()) return;
      delay(50);
    }
  }

  // Read entries in newest-first order (static to save stack)
  static String entries[LOG_MAX];
  static unsigned long durations[LOG_MAX];
  for (int i = 0; i < count; i++) {
    // Newest first: totalIdx-1, totalIdx-2, ...
    int realIdx = (totalIdx - 1 - i) % LOG_MAX;
    if (realIdx < 0) realIdx += LOG_MAX;
    char key[8];
    sprintf(key, "log%02d", realIdx);
    entries[i] = prefs.getString(key, "");

    // Parse elapsed time to seconds (trailing HH:MM:SS)
    durations[i] = 0;
    if (entries[i].length() >= 20) {
      int h, m, s;
      const char* p = entries[i].c_str() + 12;  // after "MM/DD HH:MM "
      if (sscanf(p, "%d:%d:%d", &h, &m, &s) == 3) {
        durations[i] = h * 3600 + m * 60 + s;
      }
    }
  }

  int page = 0;
  int perPage = 7;
  int maxPage = (count - 1) / perPage;
  bool needRedraw = true;

  while (true) {
    M5.update();

    if (needRedraw) {
      M5.Display.fillScreen(TFT_BLACK);
      setFontLarge();
      M5.Display.setTextColor(TFT_CYAN, TFT_BLACK);
      M5.Display.setCursor(10, 2);
      M5.Display.printf("ログ (%d件)", count);

      setFontMed();
      int startIdx = page * perPage;
      int endIdx = min(count, startIdx + perPage);

      for (int i = startIdx; i < endIdx; i++) {
        int y = 24 + (i - startIdx) * 27;
        bool over10 = (durations[i] >= 600);

        if (over10) {
          M5.Display.fillCircle(8, y + 7, 4, TFT_RED);
        }

        M5.Display.setTextColor(over10 ? TFT_RED : TFT_WHITE, TFT_BLACK);
        M5.Display.setCursor(18, y);
        M5.Display.print(entries[i]);
      }

      // Guide
      setFontSmall();
      M5.Display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
      M5.Display.setCursor(10, 225);
      M5.Display.printf("[A]前 [B]日別 [C]次  %d/%d", page + 1, maxPage + 1);

      needRedraw = false;
    }

    if (M5.BtnA.wasPressed() && page > 0) { page--; needRedraw = true; }
    if (M5.BtnC.wasPressed() && page < maxPage) { page++; needRedraw = true; }
    if (M5.BtnB.wasPressed()) {
      showDailyStatsScreen();
      return;  // return to main after daily summary
    }
    delay(50);
  }
}

// ═══════════════════════════════════════════════════
// Daily statistics (NVS, ring buffer for up to 10 days)
// Key: ds00~ds09 = "MM/DD,totalSec,count,maxSec,minSec"
// ═══════════════════════════════════════════════════
void saveDailyStats(unsigned long elapsedMs) {
  struct tm ti;
  if (!getLocalTime(&ti, 0)) return;

  char today[6];
  sprintf(today, "%02d/%02d", ti.tm_mon + 1, ti.tm_mday);

  unsigned long elapsedSec = elapsedMs / 1000;

  int dsIdx = prefs.getInt("dsIdx", 0);
  int dsCount = prefs.getInt("dsCnt", 0);

  for (int i = 0; i < dsCount && i < DAILY_MAX; i++) {
    int ri = (dsIdx - 1 - i);
    if (ri < 0) ri += DAILY_MAX;
    ri = ri % DAILY_MAX;
    char key[8];
    sprintf(key, "ds%02d", ri);
    String val = prefs.getString(key, "");

    if (val.startsWith(today)) {
      unsigned long totalSec = 0, maxSec = 0, minSec = 999999;
      int cnt = 0;
      sscanf(val.c_str() + 6, "%lu,%d,%lu,%lu", &totalSec, &cnt, &maxSec, &minSec);
      totalSec += elapsedSec;
      cnt++;
      if (elapsedSec > maxSec) maxSec = elapsedSec;
      if (elapsedSec < minSec) minSec = elapsedSec;
      char buf[48];
      sprintf(buf, "%s,%lu,%d,%lu,%lu", today, totalSec, cnt, maxSec, minSec);
      prefs.putString(key, String(buf));
      return;
    }
  }

  // New day
  char key[8];
  sprintf(key, "ds%02d", dsIdx % DAILY_MAX);
  char buf[48];
  sprintf(buf, "%s,%lu,%d,%lu,%lu", today, elapsedSec, 1, elapsedSec, elapsedSec);
  prefs.putString(key, String(buf));
  prefs.putInt("dsIdx", (dsIdx + 1) % DAILY_MAX);
  if (dsCount < DAILY_MAX) prefs.putInt("dsCnt", dsCount + 1);
}

// ═══════════════════════════════════════════════════
// Daily statistics display screen
// B: back
// ═══════════════════════════════════════════════════
void showDailyStatsScreen() {
  int dsIdx = prefs.getInt("dsIdx", 0);
  int dsCount = prefs.getInt("dsCnt", 0);

  M5.Display.fillScreen(TFT_BLACK);
  setFontMed();
  M5.Display.setTextColor(TFT_CYAN, TFT_BLACK);
  M5.Display.setCursor(10, 2);
  M5.Display.print("日別サマリー");

  if (dsCount == 0) {
    M5.Display.setCursor(40, 100);
    M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
    M5.Display.print("データなし");
    setFontSmall();
    M5.Display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
    M5.Display.setCursor(10, 225);
    M5.Display.print("[B] 戻る");
    while (true) {
      M5.update();
      if (M5.BtnB.wasPressed()) return;
      delay(50);
    }
  }

  // Read in newest-first order
  for (int i = 0; i < dsCount; i++) {
    int ri = (dsIdx - 1 - i);
    if (ri < 0) ri += DAILY_MAX;
    ri = ri % DAILY_MAX;
    char key[8];
    sprintf(key, "ds%02d", ri);
    String val = prefs.getString(key, "");
    if (val.length() == 0) continue;

    char date[6] = {0};
    unsigned long totalSec = 0, maxSec = 0, minSec = 0;
    int cnt = 0;
    sscanf(val.c_str(), "%5[^,],%lu,%d,%lu,%lu", date, &totalSec, &cnt, &maxSec, &minSec);

    unsigned long avgSec = (cnt > 0) ? totalSec / cnt : 0;

    int y = 24 + i * 40;
    if (y > 190) break;

    // Line 1: date, count, average
    setFontMed();
    M5.Display.setTextColor(TFT_CYAN, TFT_BLACK);
    M5.Display.setCursor(10, y);
    M5.Display.printf("%s  %d回  平均%s", date, cnt, formatElapsed(avgSec * 1000).c_str());

    // Line 2: max, min
    M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
    M5.Display.setCursor(30, y + 18);
    M5.Display.printf("最大%s  最小%s",
      formatElapsed(maxSec * 1000).c_str(),
      formatElapsed(minSec * 1000).c_str());
  }

  // Guide
  setFontSmall();
  M5.Display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
  M5.Display.setCursor(10, 225);
  M5.Display.print("[B] 戻る");

  while (true) {
    M5.update();
    if (M5.BtnB.wasPressed()) return;
    delay(50);
  }
}

// ═══════════════════════════════════════════════════
// Get today's max from daily stats (seconds)
// ═══════════════════════════════════════════════════
unsigned long getTodayMaxFromStats() {
  struct tm ti;
  if (!getLocalTime(&ti, 0)) return 0;

  char today[6];
  sprintf(today, "%02d/%02d", ti.tm_mon + 1, ti.tm_mday);

  int dsIdx = prefs.getInt("dsIdx", 0);
  int dsCount = prefs.getInt("dsCnt", 0);

  for (int i = 0; i < dsCount && i < DAILY_MAX; i++) {
    int ri = (dsIdx - 1 - i);
    if (ri < 0) ri += DAILY_MAX;
    ri = ri % DAILY_MAX;
    char key[8];
    sprintf(key, "ds%02d", ri);
    String val = prefs.getString(key, "");
    if (val.startsWith(today)) {
      unsigned long totalSec = 0, maxSec = 0, minSec = 0;
      int cnt = 0;
      sscanf(val.c_str() + 6, "%lu,%d,%lu,%lu", &totalSec, &cnt, &maxSec, &minSec);
      return maxSec;
    }
  }
  return 0;
}

// ═══════════════════════════════════════════════════
// Settings menu
// A: change WiFi settings, B: back, C: change Hue Bridge settings
// ═══════════════════════════════════════════════════
void showSettingsMenu() {
  int page = 0;
  bool needRedraw = true;

  while (true) {
    M5.update();

    if (needRedraw) {
      M5.Display.fillScreen(TFT_BLACK);
      setFontLarge();
      M5.Display.setTextColor(TFT_CYAN, TFT_BLACK);
      M5.Display.setCursor(10, 10);

      if (page == 0) {
        M5.Display.println("設定 (1/2)");
        setFontMed();
        M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
        M5.Display.setCursor(20, 50);
        M5.Display.println("[A] WiFi 再設定");
        M5.Display.setTextColor(TFT_DARKGREY, TFT_BLACK);
        M5.Display.setCursor(40, 70);
        M5.Display.println("(シリアルで再入力)");

        M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
        M5.Display.setCursor(20, 105);
        M5.Display.println("[C] Hue Bridge 再設定");
        M5.Display.setTextColor(TFT_DARKGREY, TFT_BLACK);
        M5.Display.setCursor(40, 125);
        M5.Display.println("(探索→ペアリング→選択)");

        setFontSmall();
        M5.Display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
        M5.Display.setCursor(10, 225);
        M5.Display.print("[B] 戻る        [C長押し] 次へ");
      } else {
        M5.Display.println("設定 (2/2)");
        setFontMed();
        M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
        M5.Display.setCursor(20, 60);
        M5.Display.println("[A] アラーム試聴");
        M5.Display.setTextColor(TFT_DARKGREY, TFT_BLACK);
        M5.Display.setCursor(40, 82);
        M5.Display.println("アラート音を再生します");

        setFontSmall();
        M5.Display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
        M5.Display.setCursor(10, 225);
        M5.Display.print("[B] 戻る        [A長押し] 前へ");
      }
      needRedraw = false;
    }

    if (page == 0) {
      if (M5.BtnA.wasPressed()) {
        // WiFi reconfigure: confirmation screen
        M5.Display.fillScreen(TFT_BLACK);
        setFontMed();
        M5.Display.setTextColor(TFT_YELLOW, TFT_BLACK);
        M5.Display.setCursor(10, 80);
        M5.Display.println("WiFi設定をクリアして");
        M5.Display.println("再起動しますか？");
        M5.Display.println("");
        M5.Display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
        M5.Display.println("[A] 実行  [B] キャンセル");
        while (true) {
          M5.update();
          if (M5.BtnA.wasPressed()) {
            prefs.remove("ssid");
            prefs.remove("pass");
            ESP.restart();
          }
          if (M5.BtnB.wasPressed()) break;
          delay(50);
        }
        return;
      }
      if (M5.BtnC.wasPressed()) {
        // Short press: Hue reconfigure, wait briefly for long-press detection
        unsigned long pressStart = millis();
        while (M5.BtnC.isPressed()) { M5.update(); delay(10); }
        if (millis() - pressStart > 500) {
          // Long press -> next page
          page = 1; needRedraw = true; continue;
        }
        // Short press -> Hue Bridge reconfigure confirmation
        M5.Display.fillScreen(TFT_BLACK);
        setFontMed();
        M5.Display.setTextColor(TFT_YELLOW, TFT_BLACK);
        M5.Display.setCursor(10, 80);
        M5.Display.println("Hue Bridge設定を");
        M5.Display.println("再設定しますか？");
        M5.Display.println("");
        M5.Display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
        M5.Display.println("[C] 実行  [B] キャンセル");
        while (true) {
          M5.update();
          if (M5.BtnC.wasPressed()) {
            prefs.remove("bridge");
            prefs.remove("apikey");
            prefs.remove("sname");
            M5.Display.fillScreen(TFT_BLACK);
            M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
            M5.Display.setCursor(10, 10);
            M5.Display.println("Hue Bridge 再設定...");
            setupHueBridge();
            setupHueApiKey();
            setupHueSensor();
            return;
          }
          if (M5.BtnB.wasPressed()) break;
          delay(50);
        }
        return;
      }
    } else {
      // page == 1
      if (M5.BtnA.wasPressed()) {
        unsigned long pressStart = millis();
        while (M5.BtnA.isPressed()) { M5.update(); delay(10); }
        if (millis() - pressStart > 500) {
          // Long press -> previous page
          page = 0; needRedraw = true; continue;
        }
        // Short press -> alarm preview
        M5.Display.fillRect(0, 110, 320, 20, TFT_BLACK);
        setFontMed();
        M5.Display.setTextColor(TFT_YELLOW, TFT_BLACK);
        M5.Display.setCursor(20, 110);
        M5.Display.print("再生中...");
        playHotaruNoHikari();
        M5.Display.fillRect(0, 110, 320, 20, TFT_BLACK);
        M5.Display.setTextColor(TFT_GREEN, TFT_BLACK);
        M5.Display.setCursor(20, 110);
        M5.Display.print("完了");
        delay(500);
        needRedraw = true;
      }
    }

    if (M5.BtnB.wasPressed()) return;
    delay(50);
  }
}

// ═══════════════════════════════════════════════════
// Get time of max entry from today's logs
// Log format: "MM/DD HH:MM HH:MM:SS"
// ═══════════════════════════════════════════════════
String getTodayMaxTimeFromLog() {
  struct tm ti;
  if (!getLocalTime(&ti, 0)) return "";

  char today[6];
  sprintf(today, "%02d/%02d", ti.tm_mon + 1, ti.tm_mday);

  int totalIdx = prefs.getInt("logIdx", 0);
  int count = (totalIdx < LOG_MAX) ? totalIdx : LOG_MAX;

  unsigned long maxDur = 0;
  String maxTime = "";

  for (int i = 0; i < count; i++) {
    int realIdx = (totalIdx - 1 - i) % LOG_MAX;
    if (realIdx < 0) realIdx += LOG_MAX;
    char key[8];
    sprintf(key, "log%02d", realIdx);
    String entry = prefs.getString(key, "");

    // Check if entry is from today
    if (entry.length() >= 20 && entry.startsWith(today)) {
      // Time part: entry[6..10] = "HH:MM"
      // Elapsed part: entry[12..] = "HH:MM:SS"
      int h, m, s;
      if (sscanf(entry.c_str() + 12, "%d:%d:%d", &h, &m, &s) == 3) {
        unsigned long dur = h * 3600 + m * 60 + s;
        if (dur > maxDur) {
          maxDur = dur;
          maxTime = entry.substring(6, 11);  // "HH:MM"
        }
      }
    }
  }

  return maxTime;
}

// ═══════════════════════════════════════════════════
// Poll remote alert from web server
// GET WEB_SERVER_URL -> {"alert":true} triggers playback
// ═══════════════════════════════════════════════════
void checkRemoteAlert() {
  if (strlen(WEB_SERVER_URL) == 0) return;
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(WEB_SERVER_URL);
  http.setTimeout(2000);
  int code = http.GET();
  if (code == 200) {
    String payload = http.getString();
    // Update urgentMinute
    int umIdx = payload.indexOf("\"urgentMinute\":");
    if (umIdx >= 0) {
      urgentMinute = payload.substring(umIdx + 15).toInt();
    }
    if (payload.indexOf("\"urgent\":true") >= 0) {
      playEvaAlert();
      playHotaruNoHikari();
    } else if (payload.indexOf("\"alert\":true") >= 0) {
      playHotaruNoHikari();
    }
  }
  http.end();
}
