/**
 * download.js — Hệ thống tải nhạc/video từ YouTube & TikTok
 *
 * Luồng:
 *   yt-dlp tải về tmp/ → upload lên litterbox.catbox.moe → gửi link → xóa tmp
 *
 * Phụ thuộc:
 *   - yt-dlp  (pip install yt-dlp  hoặc binary trong PATH)
 *   - ffmpeg  (để convert mp3)
 *   - npm install form-data node-fetch@2 archiver
 *
 * Lệnh:
 *   /youtube   — YouTube (MP3 hoặc MP4, chọn quality)
 *   /tiktok    — TikTok  (MP4 no-watermark hoặc MP3, tự động best quality)
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ChannelType,
    MessageFlags,
} = require('discord.js');

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const FormData = require('form-data');
const fetch = require('node-fetch');
const archiverLib = require('jszip');

const execFileAsync = promisify(execFile);

// ===== CONFIG FILE =====
const CONFIG_FILE = './download_config.json';

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch { return {}; }
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ===== TMP FOLDER =====
const TMP_DIR = './tmp_downloads';
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Delete files/folders older than 1 hour in tmp_downloads
const MAX_AGE_MS = 60 * 60 * 1000;

function cleanupTmpDir() {
    try {
        const now = Date.now();
        const entries = fs.readdirSync(TMP_DIR);
        let removed = 0;
        for (const entry of entries) {
            const fullPath = path.join(TMP_DIR, entry);
            try {
                const stat = fs.statSync(fullPath);
                if (now - stat.mtimeMs > MAX_AGE_MS) {
                    fs.rmSync(fullPath, { recursive: true, force: true });
                    removed++;
                }
            } catch { }
        }
        if (removed > 0) console.log(`[DL] Auto-cleanup: removed ${removed} old files file/folder c\u0169 trong tmp_downloads`);
    } catch (err) {
        console.warn(`[DL] Auto-cleanup error: ${err.message}`);
    }
}

cleanupTmpDir(); // run on startup
setInterval(cleanupTmpDir, 30 * 60 * 1000); // run every 30 minutes

// ===== QUALITY OPTIONS =====
const MP3_QUALITIES = {
    '320k': '320',
    '256k': '256',
    '192k': '192',
    '128k': '128',
    '96k': '96',
};

const MP4_QUALITIES = {
    '1080p': 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    '720p': 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]',
    '480p': 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]',
    '360p': 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best[height<=360]',
    'best': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
};

// Link tồn tại bao lâu (litterbox)
const LITTERBOX_EXPIRY = '72h'; // '1h' | '12h' | '24h' | '72h'

// Nếu file <= ngưỡng này (MB) → gửi thẳng lên Discord, không upload catbox
const DIRECT_SEND_MAX_MB = 10;

// File cookies TikTok (Netscape format) — đặt trong thư mục bot
// Lấy bằng extension "Get cookies.txt LOCALLY" trên Chrome khi đang ở tiktok.com
const TIKTOK_COOKIES_FILE = './tiktok_cookies.txt';

// ===== HELPERS =====
function formatLabel(format, quality) {
    return format === 'mp3' ? `MP3 ${quality}` : `MP4 ${quality}`;
}

function fileSizeMB(filePath) {
    try { return fs.statSync(filePath).size / 1024 / 1024; }
    catch { return 0; }
}

function fmtDuration(secs) {
    if (!secs) return '?';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
}

// ===== EXTRACT TIKTOK VIDEO ID =====
// Hỗ trợ URL dạng: /video/ID, /photo/ID, /v/ID, vm.tiktok.com/ID
function extractTikTokId(url) {
    const match = url.match(/\/(photo|video)\/(\d+)/);
    if (match) return match[2];
    return null;
}

// ===== EXTRACT URL TỪ SHARE TEXT =====
// Xử lý chuỗi share lộn xộn của Douyin/TikTok, ví dụ:
//   "6.41 S@Y.zG :7pm 03/31 fod:/ 这首歌... https://v.douyin.com/TV3o77dCKXI/ 复制此链接..."
// Trả về URL đầu tiên khớp với domain được chỉ định, hoặc null.
function extractUrlFromText(text, domains) {
    // Tìm tất cả URL http/https trong chuỗi
    const matches = text.match(/https?:\/\/[^\s一-鿿　-〿，。！？、]+/g);
    if (!matches) return null;
    for (const m of matches) {
        const clean = m.replace(/[.,!?，。！？、]+$/, ''); // bỏ dấu câu cuối
        if (domains.some(d => clean.includes(d))) return clean;
    }
    return null;
}

// ===== RESOLVE SHORT URL (v.douyin.com, vm.tiktok.com) =====
// Follow redirect để lấy URL thật trước khi gửi lên Tikwm
async function resolveShortUrl(url) {
    const isShort = /v\.douyin\.com|vm\.tiktok\.com|vt\.tiktok\.com/.test(url);
    if (!isShort) return cleanUrl(url);

    try {
        const res = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 10_000,
        });
        const resolved = res.url;
        console.log(`[DL] Resolved short URL: ${url} → ${resolved}`);
        return cleanUrl(resolved || url);
    } catch (err) {
        console.warn(`[DL] resolveShortUrl failed (${err.message}), dùng URL gốc`);
        return cleanUrl(url);
    }
}

// Strip query string — Tikwm từ chối URL có ?param=value
function cleanUrl(url) {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return url.split('?')[0];
    }
}

// ===== GET VIDEO INFO =====
// YouTube → yt-dlp | TikTok → Tikwm | Douyin → LikAPI
async function getVideoInfo(url) {
    if (url.includes('douyin.com')) {
        const resolved = await resolveShortUrl(url);
        return getDouyinInfoViaLikapi(resolved);
    }
    if (url.includes('tiktok.com')) {
        const resolved = await resolveShortUrl(url);
        return getTikTokInfoViaTikwm(resolved);
    }
    const args = ['--dump-json', '--no-playlist', '--no-warnings', url];
    const { stdout } = await execFileAsync('yt-dlp', args, { timeout: 30_000 });
    return JSON.parse(stdout);
}

// ===== LIKAPI KEY ROTATION =====
// Đọc keys từ likapi_keys.txt, tự động đổi key sau mỗi LIKAPI_CREDITS_PER_KEY lần dùng
// Trạng thái lưu vào likapi_key_state.json để restart bot không mất vị trí

const LIKAPI_KEYS_FILE = './likapi_keys.txt';
const LIKAPI_STATE_FILE = './likapi_key_state.json';
const LIKAPI_CREDITS_PER_KEY = 10; // đổi key sau 10 lần (= 100 credits / 10 per call)

function loadLikapiState() {
    try {
        if (fs.existsSync(LIKAPI_STATE_FILE))
            return JSON.parse(fs.readFileSync(LIKAPI_STATE_FILE, 'utf8'));
    } catch { }
    return { index: 0, usedCount: 0 };
}

function saveLikapiState(state) {
    try { fs.writeFileSync(LIKAPI_STATE_FILE, JSON.stringify(state, null, 2)); } catch { }
}

function loadLikapiKeys() {
    if (!fs.existsSync(LIKAPI_KEYS_FILE)) return [];
    return fs.readFileSync(LIKAPI_KEYS_FILE, 'utf8')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && !l.startsWith('[USED]'));
}

function getCurrentLikapiKey() {
    const keys = loadLikapiKeys();
    if (!keys.length) {
        // Fallback về .env nếu không có file
        if (process.env.LIKAPI_KEY) return process.env.LIKAPI_KEY;
        throw new Error('Không tìm thấy LikAPI key nào trong likapi_keys.txt');
    }

    const state = loadLikapiState();

    // Đảm bảo index không vượt quá số key hiện có
    if (state.index >= keys.length) {
        throw new Error(`Tất cả ${keys.length} LikAPI key đã hết credits! Thêm key mới vào ${LIKAPI_KEYS_FILE}`);
    }

    // Đổi key nếu đã dùng đủ LIKAPI_CREDITS_PER_KEY lần
    if (state.usedCount >= LIKAPI_CREDITS_PER_KEY) {
        const oldKey = keys[state.index]?.slice(0, 20) + '...';
        state.index++;
        state.usedCount = 0;
        saveLikapiState(state);

        if (state.index >= keys.length) {
            throw new Error(`Tất cả ${keys.length} LikAPI key đã hết credits! Thêm key mới vào ${LIKAPI_KEYS_FILE}`);
        }
        console.log(`[LIKAPI] Key #${state.index - 1} (${oldKey}) hết credits → chuyển sang key #${state.index}`);
    }

    return keys[state.index];
}

function recordLikapiUsage() {
    const state = loadLikapiState();
    state.usedCount = (state.usedCount || 0) + 1;
    saveLikapiState(state);
    const keys = loadLikapiKeys();
    console.log(`[LIKAPI] Key #${state.index} — đã dùng ${state.usedCount}/${LIKAPI_CREDITS_PER_KEY} lần (còn ${keys.length - state.index - 1} key dự phòng)`);
}

// ===== LIKAPI — Douyin no-watermark =====
async function callLikapiDouyin(url, audioOnly = false) {
    const key = getCurrentLikapiKey();

    const headers = {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
    };

    // Bước 1: tạo job
    const res = await fetch('https://api.likapi.com/v1/run/douyin-no-watermark', {
        method: 'POST',
        headers,
        body: JSON.stringify({ url, audioOnly }),
        timeout: 30_000,
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`LikAPI HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }

    const job = await res.json();
    if (job.error) throw new Error(`LikAPI: ${job.error}`);

    // Nếu trả về kết quả ngay (không có job_id) thì dùng luôn
    if (!job.job_id) {
        return job.output || job;
    }

    const jobId = job.job_id;
    // Bước 2: poll cho đến khi COMPLETED hoặc FAILED
    const POLL_INTERVAL_MS = 3_000;    // 3 giây/lần
    const MAX_WAIT_MS = 3 * 60_000; // tối đa 3 phút
    const deadline = Date.now() + MAX_WAIT_MS;

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        let pollRes;
        try {
            pollRes = await fetch(`https://api.likapi.com/v1/jobs/${jobId}`, {
                method: 'GET',
                headers,
                timeout: 15_000,
            });
        } catch (err) {
            console.warn(`[DL] LikAPI poll error (retry): ${err.message}`);
            continue;
        }

        if (!pollRes.ok) {
            console.warn(`[DL] LikAPI poll HTTP ${pollRes.status} — retry`);
            continue;
        }

        const data = await pollRes.json();
        if (data.status === 'COMPLETED') {
            // LikAPI trả về output_url là link S3 trực tiếp đến file đã xử lý
            if (!data.output_url) {
                throw new Error(`LikAPI COMPLETED nhưng không có output_url. Keys: ${Object.keys(data).join(', ')}`);
            }
            // Trả về object chuẩn hoá để các hàm downstream dùng
            recordLikapiUsage();
            return { _output_url: data.output_url };
        }

        if (data.status === 'FAILED') {
            throw new Error(`LikAPI job thất bại: ${data.error || JSON.stringify(data).slice(0, 200)}`);
        }

        // PENDING / RUNNING → tiếp tục poll
    }

    throw new Error(`LikAPI job ${jobId} timeout sau 3 phút`);
}

// Helper: lấy link video từ output LikAPI (thử nhiều field)
// Lấy info Douyin qua LikAPI — dùng yt-dlp để lấy metadata, LikAPI chỉ để download
async function getDouyinInfoViaLikapi(url) {
    try {
        const args = ['--dump-json', '--no-playlist', '--no-warnings', url];
        const { stdout } = await execFileAsync('yt-dlp', args, { timeout: 30_000 });
        const info = JSON.parse(stdout);
        return {
            title: info.title || info.description || 'Video Douyin',
            uploader: info.uploader || info.creator || info.uploader_id || '?',
            duration: info.duration || 0,
        };
    } catch {
        return { title: 'Video Douyin', uploader: '?', duration: 0 };
    }
}

// Tải Douyin video/audio qua LikAPI — output_url là S3 link trực tiếp (luôn là mp4)
async function downloadDouyinViaLikapi(url, format) {
    const audioOnly = format === 'mp3';
    // LikAPI luôn trả về mp4 dù audioOnly=true → tải về mp4 trước, convert sau
    const out = await callLikapiDouyin(url, audioOnly);

    const mediaUrl = out._output_url;
    if (!mediaUrl) throw new Error('LikAPI không trả về output_url');

    const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // Luôn tải về dưới dạng mp4
    const tmpMp4 = path.join(TMP_DIR, `${tmpId}_raw.mp4`);

    const fileRes = await fetch(mediaUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 5 * 60_000,
    });
    if (!fileRes.ok) throw new Error(`Tải file S3 thất bại: HTTP ${fileRes.status}`);
    fs.writeFileSync(tmpMp4, await fileRes.buffer());

    // Nếu cần mp3 → dùng ffmpeg convert
    if (audioOnly) {
        const outMp3 = path.join(TMP_DIR, `${tmpId}.mp3`);
        try {
            await execFileAsync('ffmpeg', [
                '-i', tmpMp4,
                '-vn',                  // bỏ video track
                '-ar', '44100',         // sample rate
                '-ac', '2',             // stereo
                '-b:a', '192k',         // bitrate
                '-y',                   // overwrite
                outMp3,
            ], { timeout: 3 * 60_000 });
        } finally {
            cleanup(tmpMp4); // xóa file mp4 tạm dù convert thành công hay lỗi
        }
        if (!fs.existsSync(outMp3)) throw new Error('ffmpeg convert mp4→mp3 thất bại');
        return outMp3;
    }

    // mp4 → đổi tên bỏ _raw
    const outMp4 = path.join(TMP_DIR, `${tmpId}.mp4`);
    fs.renameSync(tmpMp4, outMp4);
    return outMp4;
}



// Lấy thông tin video TikTok qua Tikwm API
async function getTikTokInfoViaTikwm(url) {
    const res = await fetch('https://www.tikwm.com/api/', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: new URLSearchParams({ url, count: '1', cursor: '0', web: '1', hd: '1' }),
        timeout: 20_000,
    });
    if (!res.ok) throw new Error(`Tikwm HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== 0 || !json.data) throw new Error(`Tikwm: ${json.msg || 'Không lấy được info'}`);
    const d = json.data;
    // Trả về object tương thích với cách dùng bên dưới
    return {
        title: d.title || d.desc || 'Video TikTok',
        uploader: d.author?.unique_id || d.author?.nickname || '?',
        duration: d.duration || 0,
        // Lưu thêm direct URL để downloadTikTok dùng
        _tikwm_play: d.hdplay || d.play,
        _tikwm_music: d.music,
    };
}

// ===== DOWNLOAD FILE =====
async function downloadFile(url, format, quality) {
    const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const outBase = path.join(TMP_DIR, tmpId);
    let args;

    if (format === 'mp3') {
        args = [
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', MP3_QUALITIES[quality] || '192',
            '--no-playlist', '--no-warnings',
            '-o', `${outBase}.%(ext)s`,
            url,
        ];
    } else {
        args = [
            '-f', MP4_QUALITIES[quality] || MP4_QUALITIES['720p'],
            '--merge-output-format', 'mp4',
            '--no-playlist', '--no-warnings',
            '-o', `${outBase}.%(ext)s`,
            url,
        ];
    }

    await execFileAsync('yt-dlp', args, { timeout: 10 * 60_000 });

    const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(tmpId));
    if (!files.length) throw new Error('yt-dlp không xuất ra file nào');
    return path.join(TMP_DIR, files[0]);
}

// ===== DOWNLOAD TIKTOK (no-watermark) — dùng Tikwm API =====
async function downloadTikTok(url, format) {
    url = await resolveShortUrl(url);
    const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Bước 1: lấy direct URL từ Tikwm
    const res = await fetch('https://www.tikwm.com/api/', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: new URLSearchParams({ url, count: '1', cursor: '0', web: '1', hd: '1' }),
        timeout: 20_000,
    });
    if (!res.ok) throw new Error(`Tikwm HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== 0 || !json.data) throw new Error(`Tikwm: ${json.msg || 'Không lấy được link'}`);

    const d = json.data;


    // Helper: đảm bảo URL tuyệt đối
    // Tikwm trả về path tương đối dạng /video/... → prefix tikwm.com
    function toAbsUrl(u) {
        if (!u || typeof u !== 'string') return null;
        if (u.startsWith('http')) return u;
        if (u.startsWith('//')) return 'https:' + u;
        if (u.startsWith('/')) return 'https://www.tikwm.com' + u;
        return null;
    }

    // Bước 2: chọn URL phù hợp và tải về
    if (format === 'mp3') {
        // Thử các field music theo thứ tự ưu tiên
        const musicUrl = toAbsUrl(d.music_info?.play)   // URL tuyệt đối từ CDN
            || toAbsUrl(d.music)                           // path tương đối tikwm
            || toAbsUrl(d.hdplay)
            || toAbsUrl(d.play);
        if (!musicUrl) throw new Error(`Tikwm không trả về link nhạc. Fields: ${JSON.stringify({ music: d.music, music_info: d.music_info })}`);

        const outPath = path.join(TMP_DIR, `${tmpId}.mp3`);
        const fileRes = await fetch(musicUrl, {
            headers: { 'Referer': 'https://www.tiktok.com/', 'User-Agent': 'Mozilla/5.0' },
            timeout: 5 * 60_000,
        });
        if (!fileRes.ok) throw new Error(`Tải nhạc thất bại: HTTP ${fileRes.status}`);
        fs.writeFileSync(outPath, await fileRes.buffer());
        return outPath;
    } else {
        // Dùng hdplay (no-watermark HD) hoặc play
        // play = no-watermark nhưng thường đủ video+audio
        // hdplay = HD no-watermark nhưng đôi khi chỉ có audio
        // wmplay = có watermark nhưng chắc chắn đủ video+audio
        const videoUrl = toAbsUrl(d.play) || toAbsUrl(d.wmplay) || toAbsUrl(d.hdplay);
        if (!videoUrl) throw new Error(`Tikwm không trả về link video. Fields: ${JSON.stringify({ hdplay: d.hdplay, play: d.play })}`);

        const outPath = path.join(TMP_DIR, `${tmpId}.mp4`);
        const fileRes = await fetch(videoUrl, {
            headers: { 'Referer': 'https://www.tiktok.com/', 'User-Agent': 'Mozilla/5.0' },
            timeout: 5 * 60_000,
        });
        if (!fileRes.ok) throw new Error(`Tải video thất bại: HTTP ${fileRes.status}`);
        fs.writeFileSync(outPath, await fileRes.buffer());
        return outPath;
    }
}


// ===== DOWNLOAD TIKTOK IMAGES (slideshow) =====
// Dùng tikwm.com API (miễn phí, không cần key) để lấy ảnh slideshow.
// yt-dlp không hỗ trợ URL dạng /photo/.
async function downloadTikTokImages(url) {
    url = await resolveShortUrl(url);
    const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const imgDir = path.join(TMP_DIR, `imgs_${tmpId}`);
    fs.mkdirSync(imgDir, { recursive: true });

    let title = 'TikTok Slideshow';
    let uploader = '?';
    let imageUrls = [];

    // ── Bước 1: gọi Tikwm API để lấy danh sách ảnh ──
    console.log(`[DL] TikTok Images - gọi Tikwm API: ${url}`);
    try {
        const apiRes = await fetch('https://www.tikwm.com/api/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            body: new URLSearchParams({ url, count: '12', cursor: '0', web: '1', hd: '1' }),
            timeout: 30_000,
        });

        if (!apiRes.ok) throw new Error(`Tikwm HTTP ${apiRes.status}`);

        const json = await apiRes.json();
        console.log(`[DL] Tikwm response code: ${json.code}`);

        if (json.code !== 0 || !json.data) {
            throw new Error(`Tikwm lỗi: ${json.msg || JSON.stringify(json)}`);
        }

        const data = json.data;
        title = (data.title || data.desc || 'TikTok Slideshow').slice(0, 200);
        uploader = data.author?.unique_id || data.author?.nickname || '?';

        // Slideshow ảnh nằm trong data.images[]
        if (Array.isArray(data.images) && data.images.length > 0) {
            imageUrls = data.images; // mảng URL string trực tiếp
            console.log(`[DL] Tikwm trả về ${imageUrls.length} ảnh`);
        } else {
            throw new Error('Tikwm không trả về ảnh slideshow. Link này có thể là video, không phải slideshow ảnh.');
        }
    } catch (err) {
        try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch { }
        throw new Error(`Không lấy được ảnh từ Tikwm API:\n${err.message}`);
    }

    // ── Bước 2: tải từng ảnh ──
    console.log(`[DL] Bắt đầu tải ${imageUrls.length} ảnh...`);
    for (let i = 0; i < imageUrls.length; i++) {
        try {
            const imgUrl = imageUrls[i];
            const imgPath = path.join(imgDir, `image_${String(i + 1).padStart(3, '0')}.jpg`);

            const res = await fetch(imgUrl, {
                headers: {
                    'Referer': 'https://www.tiktok.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
                timeout: 25_000,
            });

            if (res.ok) {
                fs.writeFileSync(imgPath, await res.buffer());
                console.log(`[DL] ✅ Tải xong ảnh ${i + 1}/${imageUrls.length}`);
            } else {
                console.warn(`[DL] HTTP ${res.status} khi tải ảnh ${i + 1}`);
            }
        } catch (e) {
            console.warn(`[DL] Lỗi tải ảnh ${i + 1}: ${e.message}`);
        }
    }

    const imgFiles = fs.readdirSync(imgDir).filter(f => /\.(jpe?g|png|webp)$/i.test(f));

    if (imgFiles.length === 0) {
        try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch { }
        throw new Error('Lấy được link ảnh nhưng không tải được file. Thử lại sau.');
    }

    // Trả về imgDir và danh sách đường dẫn ảnh để caller quyết định gửi thẳng hay nén ZIP
    const imgFilePaths = imgFiles.map(f => path.join(imgDir, f));
    const totalSizeMB = imgFilePaths.reduce((sum, fp) => sum + fileSizeMB(fp), 0);

    return { imgDir, imgFiles: imgFilePaths, count: imgFiles.length, title, uploader, totalSizeMB };
}

// ===== NÉN ZIP ẢNH (dùng khi tổng size >= DIRECT_SEND_MAX_MB) =====
async function zipImages(imgFilePaths, tmpId) {
    const zipPath = path.join(TMP_DIR, `tiktok_slideshow_${tmpId}.zip`);
    const zip = new archiverLib();
    for (const fp of imgFilePaths) {
        zip.file(path.basename(fp), fs.readFileSync(fp));
    }
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    fs.writeFileSync(zipPath, zipBuffer);
    return zipPath;
}

// Docs: https://litterbox.catbox.moe/tools.php
async function uploadToLitterbox(filePath) {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('time', LITTERBOX_EXPIRY);
    form.append('fileToUpload', fs.createReadStream(filePath), {
        filename: path.basename(filePath),
    });

    const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
        method: 'POST',
        body: form,
        headers: {
            ...form.getHeaders(),
            'User-Agent': 'discord-bot/1.0',
        },
        timeout: 10 * 60_000,
    });

    const text = (await res.text()).trim();

    if (!res.ok) {
        throw new Error(`Litterbox HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    if (!text.startsWith('https://')) {
        throw new Error(`Litterbox trả về không hợp lệ: ${text.slice(0, 200)}`);
    }

    return text;
}

// ===== CLEANUP =====
function cleanup(filePath) {
    try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); }
    catch { }
}

// ===== SLASH COMMAND DEFINITIONS =====
const downloadCommands = [
    new SlashCommandBuilder()
        .setName('download-setup')
        .setDescription('⚙️ Chọn kênh để bot gửi link tải về (quản lý viên)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addChannelOption(o =>
            o.setName('channel')
                .setDescription('Kênh text để bot gửi kết quả')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName('youtube')
        .setDescription('⬇️ Tải nhạc/video từ YouTube')
        .addStringOption(o =>
            o.setName('link')
                .setDescription('Link YouTube')
                .setRequired(true)
        )
        .addStringOption(o =>
            o.setName('format')
                .setDescription('Định dạng tải về')
                .setRequired(true)
                .addChoices(
                    { name: '🎵 MP3 (audio)', value: 'mp3' },
                    { name: '🎬 MP4 (video)', value: 'mp4' },
                )
        )
        .addStringOption(o =>
            o.setName('quality')
                .setDescription('Chất lượng (mặc định: 192k / 720p)')
                .setRequired(false)
                .addChoices(
                    // MP3
                    { name: '🎵 MP3 320kbps', value: '320k' },
                    { name: '🎵 MP3 256kbps', value: '256k' },
                    { name: '🎵 MP3 192kbps (mặc định)', value: '192k' },
                    { name: '🎵 MP3 128kbps', value: '128k' },
                    { name: '🎵 MP3 96kbps', value: '96k' },
                    // MP4
                    { name: '🎬 MP4 1080p', value: '1080p' },
                    { name: '🎬 MP4 720p (mặc định)', value: '720p' },
                    { name: '🎬 MP4 480p', value: '480p' },
                    { name: '🎬 MP4 360p', value: '360p' },
                    { name: '🎬 MP4 Best', value: 'best' },
                )
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName('tiktok')
        .setDescription('⬇️ Tải video/ảnh từ TikTok (không watermark)')
        .addStringOption(o =>
            o.setName('link')
                .setDescription('Link TikTok')
                .setRequired(true)
        )
        .addStringOption(o =>
            o.setName('format')
                .setDescription('Định dạng tải về')
                .setRequired(true)
                .addChoices(
                    { name: '🎬 MP4 (video, không watermark)', value: 'mp4' },
                    { name: '🎵 MP3 (audio)', value: 'mp3' },
                    { name: '🖼️ Ảnh (slideshow ZIP)', value: 'images' },
                )
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName('douyin')
        .setDescription('⬇️ Tải video từ Douyin (không watermark)')
        .addStringOption(o =>
            o.setName('link')
                .setDescription('Link Douyin (douyin.com hoặc v.douyin.com)')
                .setRequired(true)
        )
        .addStringOption(o =>
            o.setName('format')
                .setDescription('Định dạng tải về')
                .setRequired(true)
                .addChoices(
                    { name: '🎬 MP4 (video, không watermark)', value: 'mp4' },
                    { name: '🎵 MP3 (audio)', value: 'mp3' },
                )
        )
        .toJSON(),
].map(c => typeof c.toJSON === 'function' ? c.toJSON() : c);

// ===== MODULE EXPORT =====
module.exports = (client) => {
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        // ── /download-setup ───────────────────────────────────────────────────────
        if (interaction.commandName === 'download-setup') {
            const channel = interaction.options.getChannel('channel');
            const cfg = loadConfig();
            cfg[interaction.guildId] = { channelId: channel.id };
            saveConfig(cfg);

            return interaction.reply({
                content: `✅ Đã set kênh tải về: ${channel}\nBot sẽ gửi link tải nhạc/video vào kênh này.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        // ── /youtube ─────────────────────────────────────────────────────────────
        if (interaction.commandName === 'youtube') {
            const cfg = loadConfig();
            const guildCfg = cfg[interaction.guildId];

            if (!guildCfg) {
                return interaction.reply({
                    content: '⚠️ Chưa setup kênh tải về! Quản lý viên dùng `/download-setup` trước nhé.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const targetChannel = interaction.guild.channels.cache.get(guildCfg.channelId);
            if (!targetChannel) {
                return interaction.reply({
                    content: `❌ Kênh <#${guildCfg.channelId}> không còn tồn tại. Quản lý viên cần \`/download-setup\` lại.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const url = interaction.options.getString('link');
            const format = interaction.options.getString('format');
            const quality = interaction.options.getString('quality')
                || (format === 'mp3' ? '192k' : '720p');

            if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
                return interaction.reply({
                    content: '❌ Link không hợp lệ! Chỉ hỗ trợ link YouTube.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            // Bước 1: lấy info
            let info;
            try {
                info = await getVideoInfo(url);
            } catch (err) {
                return interaction.editReply({
                    content: `❌ Không lấy được thông tin video:\n\`\`\`${err.message}\`\`\``,
                });
            }

            const title = (info.title || 'YouTube Video').slice(0, 200);
            const uploader = info.uploader || info.channel || '?';
            const duration = fmtDuration(info.duration);
            const label = formatLabel(format, quality);

            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('⏳ Đang tải về server...')
                        .addFields(
                            { name: '🎬 Video', value: title, inline: false },
                            { name: '👤 Kênh', value: uploader, inline: true },
                            { name: '⏱ Thời lượng', value: duration, inline: true },
                            { name: '📦 Định dạng', value: label, inline: true },
                        )
                        .setFooter({ text: 'Bước 1/2 — Đang tải...' })
                        .setTimestamp(),
                ],
            });

            let filePath;
            try {
                filePath = await downloadFile(url, format, quality);
            } catch (err) {
                return interaction.editReply({
                    content: `❌ Lỗi khi tải:\n\`\`\`${err.message}\`\`\``,
                    embeds: [],
                });
            }

            const sizeMB = fileSizeMB(filePath);

            // ── Bước 3: gửi thẳng Discord (< 10MB) hoặc upload catbox ──
            if (sizeMB < DIRECT_SEND_MAX_MB) {
                // Gửi file trực tiếp lên Discord
                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0xFF0000)
                            .setTitle('⏳ Đang gửi file lên Discord...')
                            .addFields(
                                { name: '🎬 Video', value: title, inline: false },
                                { name: '📦 Định dạng', value: label, inline: true },
                                { name: '📁 Kích thước', value: `${sizeMB.toFixed(2)} MB`, inline: true },
                            )
                            .setFooter({ text: 'File nhỏ — gửi thẳng lên Discord!' })
                            .setTimestamp(),
                    ],
                });

                const { AttachmentBuilder } = require('discord.js');
                const attachment = new AttachmentBuilder(filePath, { name: path.basename(filePath) });

                const resultEmbed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle(`✅ Tải xong — ${label}`)
                    .addFields(
                        { name: '🎬 Video', value: title, inline: false },
                        { name: '👤 Kênh', value: uploader, inline: true },
                        { name: '⏱ Thời lượng', value: duration, inline: true },
                        { name: '📦 Định dạng', value: label, inline: true },
                        { name: '📁 Kích thước', value: `${sizeMB.toFixed(2)} MB`, inline: true },
                        { name: '👤 Yêu cầu bởi', value: `${interaction.user}`, inline: true },
                    )
                    .setFooter({ text: '⚡ Gửi trực tiếp — không qua catbox' })
                    .setTimestamp();

                try {
                    await targetChannel.send({ embeds: [resultEmbed], files: [attachment] });
                } catch (err) {
                    cleanup(filePath);
                    return interaction.editReply({
                        content: `❌ Không gửi được vào ${targetChannel}:\n\`\`\`${err.message}\`\`\``,
                        embeds: [],
                    });
                }

                cleanup(filePath);

                await interaction.editReply({
                    content: `✅ Xong! File đã được gửi trực tiếp vào ${targetChannel}\n\n*⏳ Tin nhắn này sẽ tự xóa sau 30 giây...*`,
                    embeds: [],
                });

                setTimeout(async () => {
                    try { await interaction.deleteReply(); } catch { }
                }, 30_000);

                return;
            }

            // File >= 10MB → upload catbox
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('⏳ Đang upload lên litterbox.catbox.moe...')
                        .addFields(
                            { name: '🎬 Video', value: title, inline: false },
                            { name: '📦 Định dạng', value: label, inline: true },
                            { name: '📁 Kích thước', value: `${sizeMB.toFixed(2)} MB`, inline: true },
                        )
                        .setFooter({ text: 'Bước 2/2 — File lớn, đang upload catbox...' })
                        .setTimestamp(),
                ],
            });

            let fileUrl;
            try {
                fileUrl = await uploadToLitterbox(filePath);
            } catch (err) {
                cleanup(filePath);
                return interaction.editReply({
                    content: `❌ Upload thất bại:\n\`\`\`${err.message}\`\`\``,
                    embeds: [],
                });
            }

            cleanup(filePath);

            const resultEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle(`✅ Tải xong — ${label}`)
                .setURL(fileUrl)
                .addFields(
                    { name: '🎬 Video', value: title, inline: false },
                    { name: '👤 Kênh', value: uploader, inline: true },
                    { name: '⏱ Thời lượng', value: duration, inline: true },
                    { name: '📦 Định dạng', value: label, inline: true },
                    { name: '📁 Kích thước', value: `${sizeMB.toFixed(2)} MB`, inline: true },
                    { name: '👤 Yêu cầu bởi', value: `${interaction.user}`, inline: true },
                    { name: '🔗 Link tải', value: `[👆 Nhấn để tải](${fileUrl})`, inline: false },
                )
                .setFooter({ text: `litterbox.catbox.moe — tối đa 1GB, link tồn tại ${LITTERBOX_EXPIRY}` })
                .setTimestamp();

            try {
                await targetChannel.send({ embeds: [resultEmbed] });
            } catch (err) {
                return interaction.editReply({
                    content: `❌ Không gửi được vào ${targetChannel}:\n\`\`\`${err.message}\`\`\``,
                    embeds: [],
                });
            }

            await interaction.editReply({
                content: `✅ Xong! Link đã được gửi vào ${targetChannel}\n🔗 ${fileUrl}\n\n*⏳ Tin nhắn này sẽ tự xóa sau 30 giây...*`,
                embeds: [],
            });

            setTimeout(async () => {
                try { await interaction.deleteReply(); } catch { }
            }, 30_000);

            return;
        }

        // ── /tiktok ───────────────────────────────────────────────────────────────
        if (interaction.commandName === 'tiktok') {
            const cfg = loadConfig();
            const guildCfg = cfg[interaction.guildId];

            if (!guildCfg) {
                return interaction.reply({
                    content: '⚠️ Chưa setup kênh tải về! Quản lý viên dùng `/download-setup` trước nhé.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const targetChannel = interaction.guild.channels.cache.get(guildCfg.channelId);
            if (!targetChannel) {
                return interaction.reply({
                    content: `❌ Kênh <#${guildCfg.channelId}> không còn tồn tại. Quản lý viên cần \`/download-setup\` lại.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const rawInput = interaction.options.getString('link');
            const format = interaction.options.getString('format');

            const url = extractUrlFromText(rawInput, ['tiktok.com', 'vm.tiktok.com'])
                || (rawInput.includes('tiktok.com') ? rawInput.trim() : null);

            if (!url) {
                return interaction.reply({
                    content: '❌ Không tìm thấy link TikTok hợp lệ!\nDán link hoặc cả đoạn share text vào đều được.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            // ── XỬ LÝ RIÊNG: Tải ảnh slideshow ──────────────────────────────────
            if (format === 'images') {
                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x010101)
                            .setTitle('⏳ Đang tải ảnh slideshow về server...')
                            .addFields(
                                { name: '📱 Post', value: 'Đang lấy thông tin...', inline: false },
                                { name: '📦 Định dạng', value: '🖼️ Ảnh (ZIP)', inline: true },
                            )
                            .setFooter({ text: 'Bước 1/2 — Đang tải toàn bộ ảnh...' })
                            .setTimestamp(),
                    ],
                });

                let imgFiles, imgDir, imgCount, title, uploader, totalSizeMB;
                try {
                    const result = await downloadTikTokImages(url);
                    imgFiles = result.imgFiles;
                    imgDir = result.imgDir;
                    imgCount = result.count;
                    title = result.title || 'Slideshow TikTok';
                    uploader = result.uploader || '?';
                    totalSizeMB = result.totalSizeMB;
                } catch (err) {
                    return interaction.editReply({
                        content: `❌ Lỗi khi tải ảnh:\n\`\`\`${err.message}\`\`\``,
                        embeds: [],
                    });
                }

                // ── Gửi thẳng Discord nếu tổng < 10MB ──
                if (totalSizeMB < DIRECT_SEND_MAX_MB) {
                    await interaction.editReply({
                        embeds: [
                            new EmbedBuilder()
                                .setColor(0x010101)
                                .setTitle('⏳ Đang gửi ảnh lên Discord...')
                                .addFields(
                                    { name: '📱 Post', value: title, inline: false },
                                    { name: '🖼️ Số ảnh', value: `${imgCount} ảnh`, inline: true },
                                    { name: '📁 Tổng kích thước', value: `${totalSizeMB.toFixed(2)} MB`, inline: true },
                                )
                                .setFooter({ text: 'Ảnh nhỏ — gửi thẳng lên Discord!' })
                                .setTimestamp(),
                        ],
                    });

                    const { AttachmentBuilder } = require('discord.js');
                    const attachments = imgFiles.map(fp => new AttachmentBuilder(fp, { name: path.basename(fp) }));

                    const resultEmbed = new EmbedBuilder()
                        .setColor(0x69C9D0)
                        .setTitle(`✅ Tải xong — ${imgCount} ảnh TikTok`)
                        .addFields(
                            { name: '📱 Post', value: title, inline: false },
                            { name: '👤 Tác giả', value: uploader, inline: true },
                            { name: '🖼️ Số ảnh', value: `${imgCount} ảnh`, inline: true },
                            { name: '📁 Tổng kích thước', value: `${totalSizeMB.toFixed(2)} MB`, inline: true },
                            { name: '👤 Yêu cầu bởi', value: `${interaction.user}`, inline: true },
                        )
                        .setFooter({ text: '⚡ Gửi trực tiếp — không qua catbox' })
                        .setTimestamp();

                    try {
                        // Discord cho phép tối đa 10 file 1 tin nhắn
                        // Nếu nhiều hơn 10 ảnh, gửi theo batch
                        const BATCH = 10;
                        for (let i = 0; i < attachments.length; i += BATCH) {
                            const batch = attachments.slice(i, i + BATCH);
                            if (i === 0) {
                                await targetChannel.send({ embeds: [resultEmbed], files: batch });
                            } else {
                                await targetChannel.send({ files: batch });
                            }
                        }
                    } catch (err) {
                        try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch { }
                        return interaction.editReply({
                            content: `❌ Không gửi được vào ${targetChannel}:\n\`\`\`${err.message}\`\`\``,
                            embeds: [],
                        });
                    }

                    try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch { }

                    await interaction.editReply({
                        content: `✅ Xong! ${imgCount} ảnh đã được gửi trực tiếp vào ${targetChannel}\n\n*⏳ Tin nhắn này sẽ tự xóa sau 30 giây...*`,
                        embeds: [],
                    });

                    setTimeout(async () => {
                        try { await interaction.deleteReply(); } catch { }
                    }, 30_000);

                    return;
                }

                // Tổng >= 10MB → nén ZIP rồi upload catbox
                const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const zipPath = await zipImages(imgFiles, tmpId);
                try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch { }
                const sizeMB = fileSizeMB(zipPath);

                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x010101)
                            .setTitle('⏳ Đang upload ZIP lên litterbox.catbox.moe...')
                            .addFields(
                                { name: '📱 Post', value: title, inline: false },
                                { name: '🖼️ Số ảnh', value: `${imgCount} ảnh`, inline: true },
                                { name: '📁 Kích thước ZIP', value: `${sizeMB.toFixed(2)} MB`, inline: true },
                            )
                            .setFooter({ text: 'Bước 2/2 — File lớn, đang upload ZIP...' })
                            .setTimestamp(),
                    ],
                });

                let fileUrl;
                try {
                    fileUrl = await uploadToLitterbox(zipPath);
                } catch (err) {
                    cleanup(zipPath);
                    return interaction.editReply({
                        content: `❌ Upload thất bại:\n\`\`\`${err.message}\`\`\``,
                        embeds: [],
                    });
                }

                cleanup(zipPath);

                const resultEmbed = new EmbedBuilder()
                    .setColor(0x69C9D0)
                    .setTitle(`✅ Tải xong — ${imgCount} ảnh TikTok`)
                    .setURL(fileUrl)
                    .addFields(
                        { name: '📱 Post', value: title, inline: false },
                        { name: '👤 Tác giả', value: uploader, inline: true },
                        { name: '🖼️ Số ảnh', value: `${imgCount} ảnh`, inline: true },
                        { name: '📁 Kích thước ZIP', value: `${sizeMB.toFixed(2)} MB`, inline: true },
                        { name: '👤 Yêu cầu bởi', value: `${interaction.user}`, inline: true },
                        { name: '🔗 Link tải ZIP', value: `[👆 Nhấn để tải (${imgCount} ảnh)](${fileUrl})`, inline: false },
                    )
                    .setFooter({ text: `litterbox.catbox.moe — tối đa 1GB, link tồn tại ${LITTERBOX_EXPIRY}` })
                    .setTimestamp();

                try {
                    await targetChannel.send({ embeds: [resultEmbed] });
                } catch (err) {
                    return interaction.editReply({
                        content: `❌ Không gửi được vào ${targetChannel}:\n\`\`\`${err.message}\`\`\``,
                        embeds: [],
                    });
                }

                await interaction.editReply({
                    content: `✅ Xong! ${imgCount} ảnh (ZIP) đã được gửi vào ${targetChannel}\n🔗 ${fileUrl}\n\n*⏳ Tin nhắn này sẽ tự xóa sau 30 giây...*`,
                    embeds: [],
                });

                setTimeout(async () => {
                    try { await interaction.deleteReply(); } catch { }
                }, 30_000);

                return;
            }
            // ── KẾT THÚC XỬ LÝ ẢNH ─────────────────────────────────────────────

            // ── Bước 1: lấy info ──
            let info;
            try {
                info = await getVideoInfo(url);
            } catch (err) {
                return interaction.editReply({
                    content: `❌ Không lấy được thông tin video:\n\`\`\`${err.message}\`\`\`\nHãy thử lại hoặc kiểm tra link TikTok.`,
                });
            }

            const title = (info.title || info.description || 'Video TikTok').slice(0, 200);
            const uploader = info.uploader || info.creator || info.uploader_id || '?';
            const duration = fmtDuration(info.duration);
            const label = format === 'mp3' ? 'MP3 192kbps' : 'MP4 (no watermark)';

            // ── Bước 2: download ──
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x010101)
                        .setTitle('⏳ Đang tải TikTok về server...')
                        .addFields(
                            { name: '📱 Video', value: title, inline: false },
                            { name: '👤 Tác giả', value: uploader, inline: true },
                            { name: '⏱ Thời lượng', value: duration, inline: true },
                            { name: '📦 Định dạng', value: label, inline: true },
                        )
                        .setFooter({ text: 'Bước 1/2 — Đang tải (không watermark)...' })
                        .setTimestamp(),
                ],
            });

            let filePath;
            try {
                filePath = await downloadTikTok(url, format);
            } catch (err) {
                return interaction.editReply({
                    content: `❌ Lỗi khi tải TikTok:\n\`\`\`${err.message}\`\`\``,
                    embeds: [],
                });
            }

            const sizeMB = fileSizeMB(filePath);

            // ── Bước 3: gửi thẳng Discord (< 10MB) hoặc upload catbox ──
            if (sizeMB < DIRECT_SEND_MAX_MB) {
                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x010101)
                            .setTitle('⏳ Đang gửi file lên Discord...')
                            .addFields(
                                { name: '📱 Video', value: title, inline: false },
                                { name: '📦 Định dạng', value: label, inline: true },
                                { name: '📁 Kích thước', value: `${sizeMB.toFixed(2)} MB`, inline: true },
                            )
                            .setFooter({ text: 'File nhỏ — gửi thẳng lên Discord!' })
                            .setTimestamp(),
                    ],
                });

                const { AttachmentBuilder } = require('discord.js');
                const attachment = new AttachmentBuilder(filePath, { name: path.basename(filePath) });

                const resultEmbed = new EmbedBuilder()
                    .setColor(0x69C9D0)
                    .setTitle(`✅ Tải xong TikTok — ${label}`)
                    .addFields(
                        { name: '📱 Video', value: title, inline: false },
                        { name: '👤 Tác giả', value: uploader, inline: true },
                        { name: '⏱ Thời lượng', value: duration, inline: true },
                        { name: '📦 Định dạng', value: label, inline: true },
                        { name: '📁 Kích thước', value: `${sizeMB.toFixed(2)} MB`, inline: true },
                        { name: '👤 Yêu cầu bởi', value: `${interaction.user}`, inline: true },
                    )
                    .setFooter({ text: '⚡ Gửi trực tiếp — không qua catbox' })
                    .setTimestamp();

                try {
                    await targetChannel.send({ embeds: [resultEmbed], files: [attachment] });
                } catch (err) {
                    cleanup(filePath);
                    return interaction.editReply({
                        content: `❌ Không gửi được vào ${targetChannel}:\n\`\`\`${err.message}\`\`\``,
                        embeds: [],
                    });
                }

                cleanup(filePath);

                await interaction.editReply({
                    content: `✅ Xong! File TikTok đã được gửi trực tiếp vào ${targetChannel}\n\n*⏳ Tin nhắn này sẽ tự xóa sau 30 giây...*`,
                    embeds: [],
                });

                setTimeout(async () => {
                    try { await interaction.deleteReply(); } catch { }
                }, 30_000);

                return;
            }

            // File >= 10MB → upload catbox
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x010101)
                        .setTitle('⏳ Đang upload lên litterbox.catbox.moe...')
                        .addFields(
                            { name: '📱 Video', value: title, inline: false },
                            { name: '📦 Định dạng', value: label, inline: true },
                            { name: '📁 Kích thước', value: `${sizeMB.toFixed(2)} MB`, inline: true },
                        )
                        .setFooter({ text: 'Bước 2/2 — File lớn, đang upload catbox...' })
                        .setTimestamp(),
                ],
            });

            let fileUrl;
            try {
                fileUrl = await uploadToLitterbox(filePath);
            } catch (err) {
                cleanup(filePath);
                return interaction.editReply({
                    content: `❌ Upload thất bại:\n\`\`\`${err.message}\`\`\``,
                    embeds: [],
                });
            }

            cleanup(filePath);

            // ── Bước 4: gửi kết quả vào channel ──
            const resultEmbed = new EmbedBuilder()
                .setColor(0x69C9D0)
                .setTitle(`✅ Tải xong TikTok — ${label}`)
                .setURL(fileUrl)
                .addFields(
                    { name: '📱 Video', value: title, inline: false },
                    { name: '👤 Tác giả', value: uploader, inline: true },
                    { name: '⏱ Thời lượng', value: duration, inline: true },
                    { name: '📦 Định dạng', value: label, inline: true },
                    { name: '📁 Kích thước', value: `${sizeMB.toFixed(2)} MB`, inline: true },
                    { name: '👤 Yêu cầu bởi', value: `${interaction.user}`, inline: true },
                    { name: '🔗 Link tải', value: `[👆 Nhấn để tải](${fileUrl})`, inline: false },
                )
                .setFooter({ text: `litterbox.catbox.moe — tối đa 1GB, link tồn tại ${LITTERBOX_EXPIRY}` })
                .setTimestamp();

            try {
                await targetChannel.send({ embeds: [resultEmbed] });
            } catch (err) {
                return interaction.editReply({
                    content: `❌ Không gửi được vào ${targetChannel}:\n\`\`\`${err.message}\`\`\``,
                    embeds: [],
                });
            }

            await interaction.editReply({
                content: `✅ Xong! Link TikTok đã được gửi vào ${targetChannel}\n🔗 ${fileUrl}\n\n*⏳ Tin nhắn này sẽ tự xóa sau 30 giây...*`,
                embeds: [],
            });

            setTimeout(async () => {
                try { await interaction.deleteReply(); } catch { }
            }, 30_000);

            return;
        }

        // ── /douyin ───────────────────────────────────────────────────────────────
        if (interaction.commandName === 'douyin') {
            const cfg = loadConfig();
            const guildCfg = cfg[interaction.guildId];

            if (!guildCfg) {
                return interaction.reply({
                    content: '⚠️ Chưa setup kênh tải về! Quản lý viên dùng `/download-setup` trước nhé.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const targetChannel = interaction.guild.channels.cache.get(guildCfg.channelId);
            if (!targetChannel) {
                return interaction.reply({
                    content: `❌ Kênh <#${guildCfg.channelId}> không còn tồn tại. Quản lý viên cần \`/download-setup\` lại.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const rawInput = interaction.options.getString('link');
            const format = interaction.options.getString('format');

            const url = extractUrlFromText(rawInput, ['douyin.com', 'v.douyin.com'])
                || (rawInput.includes('douyin.com') ? rawInput.trim() : null);

            if (!url) {
                return interaction.reply({
                    content: '❌ Không tìm thấy link Douyin hợp lệ!\nDán link hoặc cả đoạn share text vào đều được.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            // ── VIDEO / MP3 ───────────────────────────────────────────────────────
            let info;
            try {
                info = await getVideoInfo(url);
            } catch (err) {
                return interaction.editReply({
                    content: `❌ Không lấy được thông tin video:\n\`\`\`${err.message}\`\`\`\nHãy thử lại hoặc kiểm tra link Douyin.`,
                });
            }

            const title = (info.title || info.description || 'Video Douyin').slice(0, 200);
            const uploader = info.uploader || info.creator || info.uploader_id || '?';
            const duration = fmtDuration(info.duration);
            const label = format === 'mp3' ? 'MP3 192kbps' : 'MP4 (no watermark)';

            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xFF0050)
                        .setTitle('⏳ Đang tải Douyin về server...')
                        .addFields(
                            { name: '📱 Video', value: title, inline: false },
                            { name: '👤 Tác giả', value: uploader, inline: true },
                            { name: '⏱ Thời lượng', value: duration, inline: true },
                            { name: '📦 Định dạng', value: label, inline: true },
                        )
                        .setFooter({ text: 'Bước 1/2 — Đang tải (không watermark)...' })
                        .setTimestamp(),
                ],
            });

            let filePath;
            try {
                filePath = await downloadDouyinViaLikapi(url, format);
            } catch (err) {
                return interaction.editReply({
                    content: `❌ Lỗi khi tải Douyin:\n\`\`\`${err.message}\`\`\``,
                    embeds: [],
                });
            }

            const sizeMB = fileSizeMB(filePath);

            if (sizeMB < DIRECT_SEND_MAX_MB) {
                const { AttachmentBuilder } = require('discord.js');
                const attachment = new AttachmentBuilder(filePath, { name: path.basename(filePath) });

                const resultEmbed = new EmbedBuilder()
                    .setColor(0xFF0050)
                    .setTitle(`✅ Tải xong Douyin — ${label}`)
                    .addFields(
                        { name: '📱 Video', value: title, inline: false },
                        { name: '👤 Tác giả', value: uploader, inline: true },
                        { name: '⏱ Thời lượng', value: duration, inline: true },
                        { name: '📦 Định dạng', value: label, inline: true },
                        { name: '📁 Kích thước', value: `${sizeMB.toFixed(2)} MB`, inline: true },
                        { name: '👤 Yêu cầu bởi', value: `${interaction.user}`, inline: true },
                    )
                    .setFooter({ text: '⚡ Gửi trực tiếp — không qua catbox' })
                    .setTimestamp();

                try {
                    await targetChannel.send({ embeds: [resultEmbed], files: [attachment] });
                } catch (err) {
                    cleanup(filePath);
                    return interaction.editReply({ content: `❌ Không gửi được vào ${targetChannel}:\n\`\`\`${err.message}\`\`\``, embeds: [] });
                }

                cleanup(filePath);
                await interaction.editReply({
                    content: `✅ Xong! File Douyin đã được gửi trực tiếp vào ${targetChannel}\n\n*⏳ Tin nhắn này sẽ tự xóa sau 30 giây...*`,
                    embeds: [],
                });
                setTimeout(async () => { try { await interaction.deleteReply(); } catch { } }, 30_000);
                return;
            }

            // File >= 10MB → upload catbox
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xFF0050)
                        .setTitle('⏳ Đang upload lên litterbox.catbox.moe...')
                        .addFields(
                            { name: '📱 Video', value: title, inline: false },
                            { name: '📦 Định dạng', value: label, inline: true },
                            { name: '📁 Kích thước', value: `${sizeMB.toFixed(2)} MB`, inline: true },
                        )
                        .setFooter({ text: 'Bước 2/2 — File lớn, đang upload catbox...' })
                        .setTimestamp(),
                ],
            });

            let fileUrl;
            try {
                fileUrl = await uploadToLitterbox(filePath);
            } catch (err) {
                cleanup(filePath);
                return interaction.editReply({ content: `❌ Upload thất bại:\n\`\`\`${err.message}\`\`\``, embeds: [] });
            }

            cleanup(filePath);

            const resultEmbed = new EmbedBuilder()
                .setColor(0xFF0050)
                .setTitle(`✅ Tải xong Douyin — ${label}`)
                .setURL(fileUrl)
                .addFields(
                    { name: '📱 Video', value: title, inline: false },
                    { name: '👤 Tác giả', value: uploader, inline: true },
                    { name: '⏱ Thời lượng', value: duration, inline: true },
                    { name: '📦 Định dạng', value: label, inline: true },
                    { name: '📁 Kích thước', value: `${sizeMB.toFixed(2)} MB`, inline: true },
                    { name: '👤 Yêu cầu bởi', value: `${interaction.user}`, inline: true },
                    { name: '🔗 Link tải', value: `[👆 Nhấn để tải](${fileUrl})`, inline: false },
                )
                .setFooter({ text: `litterbox.catbox.moe — tối đa 1GB, link tồn tại ${LITTERBOX_EXPIRY}` })
                .setTimestamp();

            try {
                await targetChannel.send({ embeds: [resultEmbed] });
            } catch (err) {
                return interaction.editReply({ content: `❌ Không gửi được vào ${targetChannel}:\n\`\`\`${err.message}\`\`\``, embeds: [] });
            }

            await interaction.editReply({
                content: `✅ Xong! Link Douyin đã được gửi vào ${targetChannel}\n🔗 ${fileUrl}\n\n*⏳ Tin nhắn này sẽ tự xóa sau 30 giây...*`,
                embeds: [],
            });
            setTimeout(async () => { try { await interaction.deleteReply(); } catch { } }, 30_000);
            return;
        }
    });
};

module.exports.downloadCommands = downloadCommands;