# Hue Motion Timer

A motion sensor elapsed-time monitor using the Philips Hue motion sensor. Available as both an M5Stack embedded device and a web application.

[日本語版はこちら](README.ja.md)

## Why This Project?

🌐 **[Project Page](https://yo1t.github.io/hue-motion-timer/)** | **[日本語ページ](https://yo1t.github.io/hue-motion-timer/ja.html)**

- **Real-time elapsed timer** — Unlike typical motion-triggered automations that only detect ON/OFF, this project tracks and displays how long someone has been present since the first detection
- **No Home Assistant required** — Connects directly to the Hue Bridge API without any additional hub or platform
- **Dual interface** — Physical M5Stack device with LCD + speaker and a web dashboard, each working independently or together
- **Multi-level alerts** — Configurable alert schedule with normal and urgent alarms that escalate over time
- **Historical analytics** — Daily statistics (average, max, min, total) with charts and long-term log retention
- **Zero-config setup** — Auto-discovers Bridge, generates API key with button press, and lets you pick a sensor from the screen

## Overview

### Web Dashboard
<img src="docs/web-screenshot.png" alt="Web Dashboard" width="320">

*Shown in Japanese. Set `lang` to `"en"` in config to switch to English.*

Monitors a Hue motion sensor (ZLLPresence) and displays a real-time timer since the last detection. Designed for tracking occupancy duration with alerts and historical logging.

## Two Versions

### M5Stack Version (`hue_motion_timer/`)
Standalone embedded device with LCD display and speaker.

### Web Version (`hue_motion_web/`)
Browser-based dashboard running on Node.js with Apache reverse proxy.

Both versions share the same Hue Bridge and can run simultaneously. Each version operates independently — the M5Stack version works without the web server, and the web version works without the M5Stack. When both are running, the web version can trigger alerts on the M5Stack remotely.

## Features

| Feature | M5Stack | Web |
|---------|---------|-----|
| Real-time timer display | ✓ | ✓ |
| Motion detection status | ✓ | ✓ |
| Auto Bridge discovery (mDNS/Cloud) | ✓ | ✓ (IP range scan) |
| Auto API key generation | ✓ | ✓ |
| Sensor selection UI | ✓ | ✓ |
| Japanese UI | ✓ | ✓ |
| Audible alerts (Auld Lang Syne) | ✓ (speaker) | ✓ (Web Audio) |
| Urgent alert (Evangelion-style + melody) | ✓ | ✓ |
| Remote alert (Web → M5Stack) | ✓ | ✓ |
| Auto reset after 3 min no motion | ✓ | ✓ |
| Log history | 20 entries (NVS) | 1000 entries (JSON) |
| Daily statistics | 10 days (NVS) | 2 years (JSON) |
| Daily chart (avg/max/total) | — | ✓ (Chart.js) |
| Clock & battery display | ✓ | ✓ (clock only) |
| Timer recovery after reboot | ✓ (within 1 min) | ✓ (within 1 min) |
| WiFi auto-reconnect | ✓ | — |
| M5Stack online status | — | ✓ |
| IP whitelist security | — | ✓ |

## M5Stack Version

### Hardware Requirements

- **M5Stack Basic** (ESP32, 320x240 LCD, 1W speaker, built-in battery)
  - CPU: ESP32-D0WDQ6-V3 (Dual Core 240MHz)
  - Flash: 16MB
  - RAM: 520KB SRAM
  - Display: 320x240 IPS LCD
  - Speaker: 1W (NS4168 DAC)
  - Battery: 150mAh (seamless USB/battery switching)
  - Buttons: 3 physical buttons (A/B/C)
- **Philips Hue Bridge** (V1 or V2, HTTPS supported)
  - V1 (BSB001): HTTP/HTTPS, round shape
  - V2 (BSB002/BSB003): HTTPS only, square shape
  - Must be on the same network as M5Stack (or routed for Web version)
  - API version 1.x (CLIP v1) is used
- **Philips Hue Motion Sensor** (ZLLPresence type)
  - Indoor: SML001, SML002
  - Outdoor: SML003, SML004
  - Must be paired with the Hue Bridge via the Hue app before use
- **USB power supply** (5V/1A or higher recommended)

### Software Requirements

- [Arduino CLI](https://arduino.github.io/arduino-cli/) or Arduino IDE
- Board: `m5stack:esp32:m5stack_core`
- Partition: `huge_app` (required for Japanese fonts, 3MB app space)

### Libraries

- M5Unified
- ArduinoJson (v7)
- WiFi, HTTPClient, WiFiClientSecure, Preferences, ESPmDNS (ESP32 built-in)

### Setup

1. Copy the config template:
   ```bash
   cp hue_motion_timer/config.h.example hue_motion_timer/config.h
   # Or for Japanese comments:
   # cp hue_motion_timer/config.h.ja.example hue_motion_timer/config.h
   ```

2. Edit `config.h` with your WiFi credentials. Hue settings can be left empty for auto-setup:
   ```c
   #define WIFI_SSID "your-ssid"
   #define WIFI_PASS "your-password"
   #define HUE_BRIDGE_IP   ""
   #define HUE_API_KEY     ""
   #define HUE_SENSOR_NAME ""
   #define POLL_INTERVAL   2000
   #define RESET_TIMEOUT   180000
   #define SPEAKER_VOLUME  200
   #define UI_LANG 0
   #define WEB_SERVER_URL  ""
   #define DEFAULT_URGENT_MINUTE 20
   #define ALERT_MIN_1  15
   #define ALERT_MIN_2  20
   #define ALERT_MIN_3  30
   #define ALERT_MIN_4  45
   #define ALERT_MIN_5  60
   ```

3. Compile and upload:
   ```bash
   arduino-cli compile --fqbn "m5stack:esp32:m5stack_core:PartitionScheme=huge_app" hue_motion_timer/
   arduino-cli upload --fqbn "m5stack:esp32:m5stack_core:PartitionScheme=huge_app" --port /dev/cu.usbserial-XXXXX hue_motion_timer/
   ```

4. On first boot, follow the on-screen instructions:
   - Bridge is discovered automatically (mDNS → Cloud fallback)
   - Press the Hue Bridge button when prompted to generate an API key
   - Select your motion sensor from the list using buttons A/B/C

### Button Controls

| Button | Main Screen | Log Screen | Settings |
|--------|-------------|------------|----------|
| A (Left) | Settings | Previous page | WiFi reset / Alarm test |
| B (Center) | Log viewer | Daily stats | Back |
| C (Right) | Force refresh | Next page | Hue Bridge reset |

### Alert Schedule

Plays an alert melody at configurable intervals (default: 15, 20, 30, 45, 60 minutes). Alert times are set via `ALERT_MIN_1` through `ALERT_MIN_5` in `config.h` (set to `0` to disable individual alerts). The urgent alert minute (default: 20, set via `DEFAULT_URGENT_MINUTE`) plays an urgent alarm sound before the melody. Set `urgentMinute` to `0` or a value not matching any `ALERT_MIN` to effectively disable the urgent alert while keeping normal alerts.

## Web Version

### Server Requirements

- **Node.js** 18+ (tested on Amazon Linux 2023)
- **Apache** 2.4+ with `mod_proxy` and `mod_proxy_http` (for reverse proxy)
- Network access to the Hue Bridge (same LAN or routed)

### Dependencies

- express (v4)
- Chart.js (v4, loaded via CDN)

### Setup

1. Copy config and install:
   ```bash
   cd hue_motion_web
   cp config.json.example config.json
   npm install
   ```

2. Edit `config.json`:
   ```json
   {
     "bridgeIP": "",
     "apiKey": "",
     "sensorName": "",
     "port": 3000,
     "pollInterval": 2000,
     "resetTimeout": 180000,
     "alertMinutes": [15, 20, 30, 45, 60],
     "urgentMinute": 20,
     "authUser": "admin",
     "authPass": "",
     "allowedNetworks": ["192.168.1.0/24", "10.0.0.0/8", "127.0.0.1/32"],
     "lang": "ja"
   }
   ```

3. Configure Apache reverse proxy (`/etc/httpd/conf.d/hue-motion.conf`):
   ```apache
   ProxyPass /hue http://localhost:3000/hue
   ProxyPassReverse /hue http://localhost:3000/hue
   ```

4. Set up systemd service:
   ```ini
   [Unit]
   Description=Hue Motion Timer Web
   After=network.target

   [Service]
   Type=simple
   User=ec2-user
   WorkingDirectory=/home/ec2-user/hue_motion_web
   ExecStart=/usr/bin/node server.js
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

5. Start and enable:
   ```bash
   sudo systemctl enable hue-motion
   sudo systemctl start hue-motion
   ```

6. Access `http://your-server/hue/` and configure via the settings screen.

### Security

- **IP Whitelist**: Configurable allowed networks in CIDR format
- **Basic Authentication**: Optional, configure `authUser`/`authPass` in config.json
- **Security Headers**: CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy
- **Rate Limiting**: 120 requests/min per IP
- **Input Validation**: Private IP only for bridge, sensor name length limit
- **Localhost Binding**: Node.js listens on 127.0.0.1 only (Apache proxies)
- **No Credential Exposure**: API keys masked in config endpoint

### M5Stack Integration

Set `WEB_SERVER_URL` in M5Stack's `config.h` to enable:
- Remote alert triggering from web UI
- Urgent alert minute synced from web config
- M5Stack online status displayed on web dashboard

## File Structure

```
├── hue_motion_timer/          # M5Stack version
│   ├── hue_motion_timer.ino   # Main sketch
│   ├── lang_ja.h              # Japanese UI strings
│   ├── lang_en.h              # English UI strings
│   ├── config.h               # Settings (git-ignored)
│   ├── config.h.example       # Template (English)
│   └── config.h.ja.example    # Template (Japanese)
├── hue_motion_web/            # Web version
│   ├── server.js              # Node.js backend
│   ├── config.json            # Settings (git-ignored)
│   ├── config.json.example    # Template
│   ├── state.json             # Persistent state (git-ignored)
│   ├── package.json
│   └── public/
│       ├── index.html
│       ├── app.js
│       └── style.css
├── .gitignore
├── README.md
└── README.ja.md
```

## License

MIT
