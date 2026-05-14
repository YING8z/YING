// ===== PATCH-STREAM-LIB.JS =====
// Chạy 1 lần sau khi npm install:  node patch-stream-lib.js
// Fix lỗi: [AVFilterGraph] No such filter: 'azmq' trên FFmpeg 6.1
// Nguyên nhân: thư viện inject filter azmq (cần libzmq) luôn luôn khi includeAudio=true
// FFmpeg 6.1 build thông thường không có libzmq → crash
// Fix: patch newApi.js để skip đoạn azmq injection

const fs = require('fs');
const path = require('path');

const targetFile = path.join(
    __dirname,
    'node_modules',
    '@dank074',
    'discord-video-stream',
    'dist',
    'media',
    'newApi.js'
);

if (!fs.existsSync(targetFile)) {
    console.error('❌ Không tìm thấy file:', targetFile);
    console.error('   Hãy chắc chắn bạn đã chạy npm install trước.');
    process.exit(1);
}

let content = fs.readFileSync(targetFile, 'utf-8');

// Kiểm tra đã patch chưa
if (content.includes('// [PATCHED] azmq disabled')) {
    console.log('✅ File đã được patch rồi, không cần làm gì thêm.');
    process.exit(0);
}

// Đoạn cần xóa: toàn bộ block inject azmq + import zeromq
// Block bắt đầu từ comment "// realtime control mechanism" đến hết zmqClientPromise
const azmqBlock = `    // realtime control mechanism
    let currentVolume = 1;
    let zmqClientPromise;
    if (includeAudio && !isBun() && !isDeno()) {
        function randomInclusive(start, end) {
            return Math.floor(Math.random() * (end - start + 1)) + start;
        }
        // Last octet is from 2 to 254 to avoid WSL2 shenanigans
        const loopbackIp = [
            127,
            randomInclusive(0, 255),
            randomInclusive(0, 255),
            randomInclusive(2, 254),
        ].join(".");
        const zmqEndpoint = \`tcp://\${loopbackIp}:42069\`;
        command.audioFilters(\`azmq=b=\${zmqEndpoint.replaceAll(":", "\\\\\\\\:")}\`);
        zmqClientPromise = import("zeromq").then((zmq) => {
            const client = new zmq.Request({
                sendTimeout: 5000,
                receiveTimeout: 5000,
            });
            client.connect(zmqEndpoint);
            promise.catch(() => { }).finally(() => client.disconnect(zmqEndpoint));
            return client;
        });
    }`;

const azmqReplacement = `    // [PATCHED] azmq disabled — FFmpeg 6.1 không có libzmq → crash
    // Patch by patch-stream-lib.js
    let currentVolume = 1;
    let zmqClientPromise = undefined;`;

// Đoạn setVolume cũng cần giữ nguyên nhưng zmqClientPromise = undefined → nó sẽ return false
// Không cần sửa gì thêm vì setVolume đã có guard: if (!zmqClientPromise) return false;

if (!content.includes('command.audioFilters(`azmq=b=')) {
    console.error('❌ Không tìm thấy đoạn azmq trong file. Có thể version thư viện đã thay đổi.');
    console.error('   Nội dung file có thể đã khác, cần kiểm tra lại.');
    process.exit(1);
}

// Backup file gốc
const backupFile = targetFile + '.bak';
if (!fs.existsSync(backupFile)) {
    fs.copyFileSync(targetFile, backupFile);
    console.log('📦 Đã backup file gốc →', backupFile);
}

// Thực hiện patch
content = content.replace(azmqBlock, azmqReplacement);

// Kiểm tra patch có thành công không
if (content.includes('// [PATCHED] azmq disabled')) {
    fs.writeFileSync(targetFile, content, 'utf-8');
    console.log('✅ Patch thành công!');
    console.log('   azmq filter đã bị tắt, FFmpeg 6.1 sẽ không còn crash.');
    console.log('   File backup gốc:', backupFile);
} else {
    console.error('❌ Patch thất bại — đoạn text không khớp.');
    console.error('   Hãy kiểm tra lại version thư viện hoặc patch thủ công.');
    process.exit(1);
}