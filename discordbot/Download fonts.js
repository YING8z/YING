/**
 * Chạy một lần để tải font NotoSans về thư mục ./fonts/
 * Usage: node download_fonts.js
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const FONTS_DIR = path.join(__dirname, 'fonts');
if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR);

const FONTS = [
    {
        url: 'https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf',
        file: 'NotoSans-Regular.ttf'
    },
    {
        url: 'https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Bold.ttf',
        file: 'NotoSans-Bold.ttf'
    }
];

function download(url, dest) {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(dest)) {
            console.log(`  [skip] ${path.basename(dest)} đã có rồi`);
            return resolve();
        }

        console.log(`  Đang tải: ${path.basename(dest)}...`);
        const file = fs.createWriteStream(dest);

        function get(u) {
            https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    return get(res.headers.location); // follow redirect
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode} cho ${u}`));
                }
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
                file.on('error', reject);
            }).on('error', reject);
        }

        get(url);
    });
}

(async () => {
    console.log('[FONTS] Bắt đầu tải fonts...');
    for (const f of FONTS) {
        const dest = path.join(FONTS_DIR, f.file);
        await download(f.url, dest);
    }
    console.log('[FONTS] Xong! Giờ chạy: node index.js');
})();