# Hướng dẫn cài đặt — BOT DISnew

---

## Mục lục

1. [Yêu cầu hệ thống](#1-yêu-cầu-hệ-thống)
2. [Cài Node.js](#2-cài-nodejs)
3. [Cài Visual Studio Build Tools](#3-cài-visual-studio-build-tools-bắt-buộc-cho-windows)
4. [Cài yt-dlp](#4-cài-yt-dlp)
5. [Cài FFmpeg](#5-cài-ffmpeg)
6. [Cài font NotoSans](#6-cài-font-notosans)
7. [Danh sách npm packages](#7-danh-sách-npm-packages)
8. [Lệnh cài npm một dòng](#8-lệnh-cài-npm-một-dòng)
9. [Cấu hình file .env](#9-cấu-hình-file-env)
10. [Chạy bot](#10-chạy-bot)

---

## 1. Yêu cầu hệ thống

| Thứ | Yêu cầu |
|---|---|
| Hệ điều hành | Windows 10/11 (64-bit) |
| Node.js | v18 trở lên (khuyến nghị v20 LTS) |
| npm | đi kèm Node.js |
| RAM | tối thiểu 512MB free |
| Kết nối mạng | bắt buộc |

---

## 2. Cài Node.js

**Link tải:** https://nodejs.org/en/download

1. Vào link trên, chọn tab **"Windows Installer (.msi)"**, bản **LTS** (ví dụ: 20.x.x).
2. Tải file `.msi` về, chạy installer, bấm **Next** liên tục, giữ nguyên mọi tùy chọn mặc định.
3. Ở bước **"Tools for Native Modules"**, **tick vào ô** `Automatically install the necessary tools` — bước này sẽ tự cài Build Tools luôn (xem mục 3).
4. Sau khi cài xong, mở **Command Prompt** hoặc **PowerShell**, kiểm tra:

```bash
node -v
npm -v
```

Nếu hiện số version (ví dụ `v20.11.0` và `10.2.4`) là thành công.

---

## 3. Cài Visual Studio Build Tools (bắt buộc cho Windows)

Cần thiết để build các native addon: `@napi-rs/canvas`, `better-sqlite3`.

### Cách 1 — Tự động (nếu đã tick ở bước cài Node.js)

Sau khi cài Node.js, một cửa sổ PowerShell màu xanh sẽ tự mở và cài Build Tools. Chờ đến khi hoàn tất (có thể mất 10–20 phút).

### Cách 2 — Cài thủ công

**Link tải:** https://visualstudio.microsoft.com/visual-cpp-build-tools/

1. Vào link trên, bấm **"Download Build Tools"**.
2. Chạy file `vs_BuildTools.exe` vừa tải.
3. Trong màn hình chọn workload, tick vào **"Desktop development with C++"**.
4. Bấm **Install** ở góc dưới phải. Chờ cài xong (khoảng 3–5GB).

### Cách 3 — Qua npm (nhanh nhất, cần quyền Admin)

Mở PowerShell với quyền **Administrator** (chuột phải → Run as administrator):

```bash
npm install --global windows-build-tools
```

> Nếu lệnh trên báo lỗi trên Node.js v18+, dùng Cách 2 thay thế.

---

## 4. Cài yt-dlp

`yt-dlp` là công cụ tải video, **bắt buộc** — bot không chạy được tính năng nhạc và download nếu thiếu.

**Link tải:** https://github.com/yt-dlp/yt-dlp/releases/latest

1. Vào link trên, kéo xuống phần **Assets**.
2. Tải file **`yt-dlp.exe`** (Windows 64-bit).

### Đặt file vào thư mục bot (cách đơn giản nhất)

Chép file `yt-dlp.exe` vừa tải vào **cùng thư mục với `index.js`**:

```
BOT DISnew/
├── index.js
├── yt-dlp.exe   ← đặt vào đây
└── ...
```

Bot sẽ tự tìm thấy file này khi chạy.

### Hoặc thêm vào PATH hệ thống (dùng được ở mọi nơi)

1. Tạo thư mục `C:\tools\` (hoặc bất kỳ đường dẫn nào không có dấu cách).
2. Chép `yt-dlp.exe` vào `C:\tools\`.
3. Mở **Start Menu**, tìm kiếm **"Edit the system environment variables"**, bấm mở.
4. Trong cửa sổ **System Properties**, bấm nút **"Environment Variables..."**.
5. Ở phần **"System variables"** (phía dưới), tìm dòng **`Path`**, bấm đúp vào.
6. Bấm **"New"**, nhập `C:\tools`, bấm **OK** → **OK** → **OK**.
7. **Đóng và mở lại** Command Prompt / PowerShell.
8. Kiểm tra:

```bash
yt-dlp --version
```

Nếu hiện số version (ví dụ `2024.11.18`) là thành công.

### Cập nhật yt-dlp (quan trọng)

YouTube thường xuyên thay đổi, cần cập nhật yt-dlp định kỳ:

```bash
yt-dlp -U
```

---

## 5. Cài FFmpeg

FFmpeg dùng để convert audio sang MP3. Gói `ffmpeg-static` trong npm đã bao gồm binary, **thường không cần cài thêm**. Tuy nhiên nếu gặp lỗi liên quan đến audio conversion, cài thêm FFmpeg hệ thống:

**Link tải:** https://www.gyan.dev/ffmpeg/builds/

1. Vào link trên, tải file **`ffmpeg-release-essentials.zip`** (mục "release builds").
2. Giải nén ra, ví dụ vào `C:\ffmpeg\`.
3. Thêm `C:\ffmpeg\bin` vào PATH hệ thống (làm tương tự như hướng dẫn thêm PATH ở mục 4, nhưng nhập `C:\ffmpeg\bin`).
4. Kiểm tra:

```bash
ffmpeg -version
```

---

## 6. Cài font NotoSans

Font dùng để vẽ welcome card và contact card. Nếu thiếu, card vẫn tạo được nhưng chữ sẽ hiển thị sai hoặc dùng font fallback.

**Link tải:** https://fonts.google.com/noto/specimen/Noto+Sans

1. Vào link trên, bấm nút **"Download family"** ở góc trên phải.
2. Giải nén file ZIP vừa tải.
3. Tìm 2 file sau trong thư mục vừa giải nén:
   - `NotoSans-Bold.ttf`
   - `NotoSans-Regular.ttf`
4. Tạo thư mục `fonts` trong thư mục bot:

```
BOT DISnew/
├── fonts/
│   ├── NotoSans-Bold.ttf      ← chép vào đây
│   └── NotoSans-Regular.ttf   ← chép vào đây
├── index.js
└── ...
```

---

## 7. Danh sách npm packages

| Package | Version | Dùng cho |
|---|---|---|
| `discord.js` | ^14.26.4 | Discord API client, slash commands, embeds |
| `@discordjs/voice` | ^0.19.2 | Phát nhạc trong voice channel |
| `@distube/ytdl-core` | ^4.16.12 | Stream audio YouTube |
| `ytdl-core` | ^4.11.5 | Stream audio YouTube (backup) |
| `@napi-rs/canvas` | ^1.0.0 | Vẽ welcome card, contact card (native addon) |
| `better-sqlite3` | ^12.9.0 | SQLite (native addon, dự phòng) |
| `spotify-url-info` | ^3.3.0 | Lấy track/playlist info từ Spotify |
| `yt-search` | ^2.13.1 | Tìm kiếm YouTube theo tên bài |
| `ffmpeg-static` | ^5.3.0 | Binary FFmpeg đi kèm npm |
| `prism-media` | ^1.3.5 | Audio transcoding cho voice |
| `form-data` | ^4.0.5 | Upload file lên litterbox.catbox.moe |
| `node-fetch` | ^2.7.0 | HTTP requests (Tikwm API, catbox upload) |
| `jszip` | ^3.10.1 | Nén ảnh slideshow TikTok thành ZIP |
| `archiver` | ^8.0.0 | Nén file (dự phòng) |
| `dotenv` | ^17.4.2 | Load biến môi trường từ `.env` |

---

## 8. Lệnh cài npm một dòng

Mở Command Prompt hoặc PowerShell, `cd` vào thư mục bot, chạy:

```bash
npm install discord.js @discordjs/voice @distube/ytdl-core ytdl-core @napi-rs/canvas better-sqlite3 spotify-url-info yt-search ffmpeg-static prism-media form-data node-fetch@2 jszip archiver dotenv
```

> **Quan trọng:** `node-fetch` phải cài đúng `node-fetch@2`. Version 3+ dùng ESM và sẽ báo lỗi `require() of ES Module` khi chạy bot.

Nếu gặp lỗi build với `@napi-rs/canvas` hoặc `better-sqlite3`, chạy lệnh sau rồi cài lại:

```bash
npm install --global node-gyp
npm install discord.js @discordjs/voice @distube/ytdl-core ytdl-core @napi-rs/canvas better-sqlite3 spotify-url-info yt-search ffmpeg-static prism-media form-data node-fetch@2 jszip archiver dotenv
```

---

## 9. Cấu hình file .env

Tạo file `.env` trong thư mục bot (hoặc chỉnh sửa file có sẵn) với nội dung:

```env
# ── Bắt buộc ──────────────────────────────────────────
TOKEN=your_discord_bot_token_here
CLIENT_ID=your_discord_application_id_here

# ── Tính năng lọc từ cấm bằng AI (tùy chọn) ──────────
# Đăng ký miễn phí tại: https://console.groq.com
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=llama-3.1-8b-instant
TOXIC_THRESHOLD=0.88
BADWORD_AUTO_APPROVE_COUNT=3
GROQ_COOLDOWN_MS=600000
GROQ_MIN_INTERVAL_MS=2000

# ── Tính năng tra cứu Free Fire (tùy chọn) ────────────
# Đăng ký tại: https://hlgamingofficial.com
FF_HL_USERUID=your_hl_gaming_useruid
FF_HL_APIKEY=your_hl_gaming_apikey
```

**Lấy `TOKEN` và `CLIENT_ID`:**

1. Vào https://discord.com/developers/applications
2. Chọn application của bạn (hoặc tạo mới).
3. **TOKEN**: vào tab **Bot** → bấm **"Reset Token"** → copy.
4. **CLIENT_ID**: vào tab **General Information** → copy **Application ID**.

---

## 10. Chạy bot

Sau khi hoàn tất tất cả các bước trên:

```bash
node index.js
```

Nếu thành công, console sẽ hiện:

```
[CMD] Đã đăng ký slash commands GLOBAL
[BOT] READY: TênBot#0000 | X server(s)
[NICK] Done — X server(s) | Y synced
[BADWORD] Quét xong Z channel(s) — bắt đầu realtime.
```

### Chạy bot liên tục (không tắt khi đóng terminal)

Cài `pm2`:

```bash
npm install --global pm2
pm2 start index.js --name "discord-bot"
pm2 save
pm2 startup
```

Sau đó bot sẽ tự khởi động lại khi máy reboot.
