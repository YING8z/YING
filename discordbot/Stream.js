// ===== STREAM.JS =====
// Dùng @dank074/discord-video-stream + discord.js-selfbot-v13
// npm install discord.js-selfbot-v13 @dank074/discord-video-stream

const { SlashCommandBuilder } = require('discord.js');
const { Client } = require('discord.js-selfbot-v13');
const { Streamer, prepareStream, playStream, Utils, Encoders } = require('@dank074/discord-video-stream');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ===== STATE =====
const streamSessions = new Map(); // guildId → session đang chạy
const streamQueues = new Map(); // guildId → [{ input, addedBy }]
let selfbot = null;
let streamer = null;

// ===== CẤU HÌNH CHẤT LƯỢNG =====
// Chỉnh tại đây nếu muốn đổi quality
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const VIDEO_FPS = 30;         // 1080p30 ổn định nhất với Discord selfbot
const BITRATE_VIDEO = 6500;   // kbps — tối ưu cho 1080p30
const BITRATE_VMAX = 8000;    // kbps — burst tối đa
const BITRATE_AUDIO = 192;    // kbps — đủ chất lượng cao
const AUDIO_DELAY_MS = 0;      // ms  — tăng nếu video chậm hơn audio

// ===== CẤU HÌNH QUEUE =====
const MAX_QUEUE = 50; // tối đa bao nhiêu bài trong hàng đợi

// ===== SELFBOT LOGIN =====
async function getSelfbot() {
    if (selfbot && selfbot.readyAt) return selfbot;

    const token = process.env.STREAM_TOKEN;
    if (!token) throw new Error('Thiếu STREAM_TOKEN trong .env!');

    selfbot = new Client({ checkUpdate: false });
    streamer = new Streamer(selfbot);

    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Selfbot login timeout 30s')), 30000);
        selfbot.once('ready', () => {
            clearTimeout(t);
            console.log('[STREAM] Account phụ ready:', selfbot.user.tag);
            resolve();
        });
        selfbot.once('error', e => { clearTimeout(t); reject(e); });
        selfbot.login(token).catch(e => { clearTimeout(t); reject(e); });
    });

    return selfbot;
}

// ===== DETECT SOURCE =====
function detectSource(input) {
    if (/youtube\.com|youtu\.be/i.test(input)) return 'youtube';
    if (/\.m3u8/i.test(input)) return 'hls';
    if (/\.(mp4|mkv|webm|avi|mov)/i.test(input)) return 'file';
    if (/^https?:\/\//i.test(input)) return 'direct';
    return 'file';
}

// ===== QUEUE HELPERS =====
function getQueue(guildId) {
    if (!streamQueues.has(guildId)) streamQueues.set(guildId, []);
    return streamQueues.get(guildId);
}

// ===== YT-DLP: DOWNLOAD FILE TẠM =====
// Download 100% trước → ffmpeg đọc local → không giật do buffer vơi
// Dùng bestvideo+bestaudio rồi remux → chất lượng cao nhất có thể
async function downloadYoutubeTempFile(url, onProgress) {
    const tmpFile = path.join(os.tmpdir(), `discord_stream_${Date.now()}.mp4`);

    await new Promise((resolve, reject) => {
        const proc = spawn('yt-dlp', [
            // Ưu tiên: 1080p60 → 1080p → 720p60 → 720p → best có V+A
            '-f', [
                'bestvideo[height<=1080][fps<=60][ext=mp4]+bestaudio[ext=m4a]',
                'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]',
                'bestvideo[height<=1080]+bestaudio',
                'best[height<=1080][vcodec!=none][acodec!=none]',
                'best[vcodec!=none][acodec!=none]',
                'best',
            ].join('/'),
            '--no-playlist',
            '--merge-output-format', 'mp4', // merge V+A → 1 file mp4
            '--newline',
            '-o', tmpFile,
            url,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        let lastPct = '';
        proc.stdout.on('data', d => {
            const line = d.toString().trim();
            const m = line.match(/\[download\]\s+([\d.]+)%/);
            if (m && m[1] !== lastPct) {
                lastPct = m[1];
                if (onProgress) onProgress(parseFloat(m[1]));
            }
        });

        let stderrBuf = '';
        proc.stderr.on('data', d => { stderrBuf += d.toString(); });
        proc.on('error', err => reject(new Error('yt-dlp không tìm thấy: ' + err.message)));
        proc.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`yt-dlp lỗi (code ${code}): ${stderrBuf.slice(-500)}`));
        });
    });

    return {
        filePath: tmpFile,
        cleanup: () => { try { fs.unlinkSync(tmpFile); } catch { } },
    };
}

// ===== DỌN FILE RÁC KHI KHỞI ĐỘNG =====
// Xóa các file tạm discord_stream_*.mp4 còn sót lại từ lần chạy trước
function cleanupOldTempFiles() {
    try {
        const tmpDir = os.tmpdir();
        const files = fs.readdirSync(tmpDir).filter(f => /^discord_stream_\d+\.mp4$/.test(f));
        if (files.length === 0) return;
        console.log(`[STREAM] Dọn ${files.length} file tạm cũ còn sót...`);
        for (const f of files) {
            try {
                fs.unlinkSync(path.join(tmpDir, f));
                console.log(`[STREAM] Đã xóa: ${f}`);
            } catch (e) {
                console.warn(`[STREAM] Không xóa được ${f}:`, e.message);
            }
        }
    } catch (e) {
        console.warn('[STREAM] cleanupOldTempFiles lỗi:', e.message);
    }
}

// ===== PLAY MỘT ITEM =====
async function playOne(guildId, voiceChannelId, item, textChannel) {
    const { input, addedBy } = item;
    const sourceType = detectSource(input);
    let streamInput = input;
    let cleanupInput = () => { };

    try {
        // --- Download nếu YouTube ---
        if (sourceType === 'youtube') {
            if (textChannel) {
                await textChannel.send(
                    `⬇️ Đang tải: \`${input.length > 70 ? input.slice(0, 70) + '...' : input}\`\n` +
                    `> Thêm bởi: <@${addedBy}>`
                ).catch(() => { });
            }

            let lastPct = -1;
            const tmp = await downloadYoutubeTempFile(input, pct => {
                if (pct - lastPct >= 25) {
                    lastPct = pct;
                    console.log(`[STREAM] Tải ${pct.toFixed(0)}%`);
                }
            });

            streamInput = tmp.filePath;
            cleanupInput = tmp.cleanup;
            console.log('[STREAM] Download xong:', streamInput);
        }

        // --- Join voice ---
        await streamer.joinVoice(guildId, voiceChannelId);
        console.log('[STREAM] joinVoice OK');
        console.log(`[STREAM][CONFIG] ${VIDEO_WIDTH}x${VIDEO_HEIGHT}@${VIDEO_FPS}fps | video=${BITRATE_VIDEO}kbps max=${BITRATE_VMAX}kbps bufsize=${BITRATE_VIDEO * 2}kbps | audio=${BITRATE_AUDIO}kbps | source=${sourceType}`);

        const abortController = new AbortController();

        const streamOptions = {
            width: VIDEO_WIDTH,
            height: VIDEO_HEIGHT,
            frameRate: VIDEO_FPS,
            bitrateVideo: BITRATE_VIDEO,
            bitrateVideoMax: BITRATE_VMAX,
            bitrateAudio: BITRATE_AUDIO,
            includeAudio: true,
            videoCodec: Utils.normalizeVideoCodec('H264'),
            minimizeLatency: false,
            // veryfast: encoder nhẹ hơn → ít delay hơn → ít giật đầu hơn
            // fast dùng nhiều CPU hơn → encode có thể bị delay ở máy cá nhân
            encoder: Encoders.software({ x264: { preset: 'veryfast' } }),
            // -re PHẢI đứng trước -i: ép ffmpeg đọc input đúng tốc độ realtime
            // Không có -re → ffmpeg encode 70-78fps → dồn frame vào pipe → Discord giật đầu video
            inputOptions: ['-re'],
            customFfmpegFlags: [
                // fps filter: hard-cap output đúng VIDEO_FPS, tránh burst frame
                '-vf', `fps=${VIDEO_FPS}`,
                // CBR thật sự + vbv-init=0.9: fill buffer nhanh ngay từ frame đầu
                // vbv-init mặc định=0 → encoder "dè dặt" bitrate lúc đầu → giật nhẹ vài giây
                '-x264-params', `nal-hrd=cbr:force-cfr=1:vbv-init=0.9`,
                '-minrate', `${BITRATE_VIDEO}k`,
                // bufsize = 2x bitrate → đủ buffer cho scene phức tạp
                '-bufsize', `${BITRATE_VIDEO * 2}k`,
                '-tune', 'zerolatency',
                // keyframe mỗi 1 giây → decoder recover nhanh hơn khi có WiFi jitter
                '-g', `${VIDEO_FPS}`,
            ],
        };
        if (AUDIO_DELAY_MS > 0) streamOptions.audioDelayMs = AUDIO_DELAY_MS;

        const prepared = prepareStream(streamInput, streamOptions, abortController.signal);

        // ===== INJECT -re NẾU inputOptions KHÔNG ĐƯỢC THƯ VIỆN HỖ TRỢ =====
        // -re ép ffmpeg đọc input đúng realtime pace → tránh encode burst 70fps đầu video
        // Nếu prepareStream không nhận inputOptions, hook trực tiếp vào fluent-ffmpeg command
        if (prepared.command && typeof prepared.command.inputOption === 'function') {
            try {
                prepared.command.inputOption('-re');
                console.log('[STREAM] Đã inject -re vào ffmpeg input (fluent-ffmpeg hook)');
            } catch (e) {
                console.warn('[STREAM] Không inject được -re:', e.message);
            }
        }

        // ===== LOG FPS / DROPS / FRAMESIZE =====
        // Thử 2 cách hook: fluent-ffmpeg progress event và stderr parse
        let stderrBuf = '';
        let lastStatTs = 0;

        // Cách 1: fluent-ffmpeg .on('progress') — fired mỗi giây tự động
        if (typeof prepared.command?.on === 'function') {
            prepared.command.on('progress', (prog) => {
                const fps = prog.currentFps ?? prog.fps ?? 0;
                const frames = prog.frames ?? 0;
                const kbps = prog.currentKbps ?? prog.bitrate ?? 0;
                const time = prog.timemark ?? '?';

                const fpsWarn = fps > 0 && fps < VIDEO_FPS * 0.9 ? ' ⚠️ FPS THẤP' : '';
                const bitrWarn = kbps > BITRATE_VIDEO * 1.3 ? ' ⚠️ BITRATE SPIKE' : '';

                console.log(
                    `[STREAM][STATS] fps=${fps}${fpsWarn}` +
                    ` bitrate=${kbps}kbps${bitrWarn}` +
                    ` frames=${frames} time=${time}`
                );
            });
        }

        // Cách 2: fallback stderr parse (khi thư viện không fire progress)
        const stderrSrc = prepared.command?.stderr ?? prepared.command?.ffmpegProc?.stderr;
        if (stderrSrc) {
            stderrSrc.on('data', (chunk) => {
                stderrBuf += chunk.toString();
                const now = Date.now();
                if (now - lastStatTs < 3000) return;
                lastStatTs = now;

                // frame= 90 fps= 30 q=28.0 size= 2340kB time=00:00:03 bitrate=6400kbits/s dup=0 drop=0
                const m = stderrBuf.match(
                    /frame=\s*(\d+)\s+fps=\s*([\d.]+)\s+q=([\d.-]+)\s+(?:L?size=\s*(\d+)kB\s+)?time=([\d:.]+)\s+bitrate=\s*([\d.]+)kbits\/s(?:.*?dup=\s*(\d+))?(?:.*?drop=\s*(\d+))?/
                );
                if (m) {
                    const [, frames, fps, q, sizeKB, time, kbps, dup, drop] = m;
                    const fpsN = parseFloat(fps);
                    const dropN = parseInt(drop || '0');
                    const fsKB = (sizeKB && frames)
                        ? (parseInt(sizeKB) / parseInt(frames)).toFixed(1) : '?';

                    const fpsWarn = fpsN < VIDEO_FPS * 0.9 ? ' ⚠️ FPS THẤP' : '';
                    const dropWarn = dropN > 0 ? ` ⚠️ DROP=${dropN}` : '';
                    const fsWarn = fsKB !== '?' && parseFloat(fsKB) > 30 ? ' ⚠️ FRAMESIZE SPIKE' : '';

                    console.log(
                        `[STREAM][STATS] frame=${frames} fps=${fps}${fpsWarn}` +
                        ` q=${q} bitrate=${kbps}kbps` +
                        ` frameSize≈${fsKB}KB/f${fsWarn}` +
                        ` dup=${dup || 0}${dropWarn} time=${time}`
                    );
                }

                if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000);
            });
        } else {
            console.log('[STREAM][DEBUG] Không hook được stderr/progress → kiểm tra version thư viện');
        }

        prepared.command.on('error', (err, _stdout, stderr) => {
            console.error('[STREAM] ffmpeg error:', err?.message || err);
            if (stderr) console.error('[STREAM] ffmpeg stderr:', String(stderr).slice(-800));
        });
        prepared.output.on('error', err => {
            console.error('[STREAM] output error:', err?.message);
            try { abortController.abort(err); } catch { }
        });

        // Lưu session
        streamSessions.set(guildId, {
            abortController,
            voiceChannelId,
            input,
            sourceType,
            startedAt: Date.now(),
            textChannel,
        });

        // Thông báo đang phát
        const sourceLabel = {
            youtube: '▶️ YouTube',
            hls: '📡 HLS/Livestream',
            file: '📁 File local',
            direct: '🔗 Link trực tiếp',
        }[sourceType] ?? '🔗 Link';

        const queue = getQueue(guildId);
        const queueInfo = queue.length > 0 ? `\n📋 Hàng đợi: **${queue.length}** bài tiếp theo` : '';

        if (textChannel) {
            await textChannel.send(
                `🎬 **Đang phát**\n` +
                `📺 Nguồn: ${sourceLabel}\n` +
                `🔗 \`${input.length > 70 ? input.slice(0, 70) + '...' : input}\`\n` +
                `> Thêm bởi: <@${addedBy}>` +
                queueInfo
            ).catch(() => { });
        }

        // Stream
        // readrateInitialBurst: file local không cần burst cao (không có network latency)
        // Burst cao → ffmpeg encode chưa kịp → frame queue spike → giật đầu video
        // File local: burst=1 (realtime pace). YouTube/HLS đã download xong nên cũng =1.
        await Promise.all([
            prepared.promise.catch(err => {
                if (err?.name === 'AbortError' || err?.message?.includes('abort')) return;
                throw err;
            }),
            playStream(prepared.output, streamer, {
                type: 'go-live',
                format: 'nut',
                readrateInitialBurst: 1, // 1 = pace đúng bitrate, không burst → tránh giật đầu
            }, abortController.signal),
        ]);

        console.log('[STREAM] playOne kết thúc:', input.slice(0, 60));

    } catch (err) {
        if (err?.name === 'AbortError' || err?.message?.includes('abort')) {
            console.log('[STREAM] playOne bị abort (skip/stop)');
            throw err; // re-throw để playNext biết là bị abort chủ động
        }
        console.error('[STREAM] playOne lỗi:', err.message);
        if (textChannel) {
            await textChannel.send(`⚠️ Lỗi khi phát: \`${err.message}\``).catch(() => { });
        }
    } finally {
        cleanupInput();
        streamSessions.delete(guildId);
        try { streamer.leaveVoice(guildId); } catch { }
    }
}

// ===== VÒNG LẶP QUEUE =====
async function playNext(guildId, voiceChannelId, textChannel) {
    const queue = getQueue(guildId);

    while (queue.length > 0) {
        // Kiểm tra có session đang chạy không (có thể bị stop từ ngoài)
        // Nếu session vẫn còn nhưng không phải do queue loop → dừng
        const item = queue.shift();
        console.log(`[STREAM] Queue còn ${queue.length} bài sau khi lấy 1`);

        try {
            await playOne(guildId, voiceChannelId, item, textChannel);
        } catch (err) {
            // Nếu bị abort chủ động (stop/skip) → dừng vòng lặp
            if (err?.name === 'AbortError' || err?.message?.includes('abort')) {
                console.log('[STREAM] Queue loop dừng do abort');
                return;
            }
            // Lỗi thường → bỏ qua bài này, chạy bài tiếp
            console.error('[STREAM] Bỏ qua bài lỗi, chạy tiếp');
        }

        // Nghỉ 1 giây giữa các bài
        if (queue.length > 0) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    // Hết queue
    if (textChannel) {
        await textChannel.send('✅ Hết hàng đợi, stream kết thúc.').catch(() => { });
    }
    console.log('[STREAM] Queue rỗng, dừng.');
}

// ===== STOP HOÀN TOÀN =====
async function stopStream(guildId) {
    streamQueues.set(guildId, []); // xóa queue
    const session = streamSessions.get(guildId);
    if (!session) return false;
    try { session.abortController?.abort(); } catch { }
    try { streamer?.leaveVoice(guildId); } catch { }
    streamSessions.delete(guildId);
    console.log(`[STREAM] Stop + clear queue guild ${guildId}`);
    return true;
}

// ===== SKIP =====
async function skipStream(guildId) {
    const session = streamSessions.get(guildId);
    if (!session) return false;
    try { session.abortController?.abort(); } catch { }
    // Không xóa queue, playNext sẽ tự chạy bài tiếp
    console.log(`[STREAM] Skip guild ${guildId}`);
    return true;
}

// ===== ADD TO QUEUE & START IF IDLE =====
async function addToQueue(interaction, input) {
    const guildId = interaction.guildId;
    const voiceChannel = interaction.member?.voice?.channel;
    const textChannel = interaction.channel;

    if (!voiceChannel)
        return interaction.editReply('❌ Bạn cần vào Voice Channel trước!');

    await getSelfbot();

    const guild = selfbot.guilds.cache.get(guildId);
    if (!guild)
        throw new Error('Account phụ chưa vào server này! Hãy mời vào trước.');

    const queue = getQueue(guildId);

    // Nếu đang có stream → thêm vào queue
    if (streamSessions.has(guildId)) {
        if (queue.length >= MAX_QUEUE) {
            return interaction.editReply(`❌ Hàng đợi đầy (tối đa ${MAX_QUEUE} bài)!`);
        }
        queue.push({ input, addedBy: interaction.user.id });
        return interaction.editReply(
            `✅ Đã thêm vào hàng đợi!\n` +
            `📋 Vị trí: **#${queue.length}**\n` +
            `🔗 \`${input.length > 70 ? input.slice(0, 70) + '...' : input}\``
        );
    }

    // Chưa có stream → thêm vào queue rồi bắt đầu luôn
    queue.push({ input, addedBy: interaction.user.id });
    await interaction.editReply('🔄 Đang chuẩn bị stream...');

    // Chạy queue non-blocking
    playNext(guildId, voiceChannel.id, textChannel).catch(err => {
        console.error('[STREAM] playNext crash:', err.message);
    });
}

// ===== MODULE EXPORT =====
module.exports = (client) => {
    client.once('ready', () => {
        cleanupOldTempFiles(); // Xóa file tạm còn sót từ lần chạy trước
        getSelfbot().catch(err => console.error('[STREAM] Lỗi login account phụ:', err.message));
    });

    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        // ===== /stream =====
        if (interaction.commandName === 'stream') {
            await interaction.deferReply();
            const input = interaction.options.getString('input');
            try {
                await addToQueue(interaction, input);
            } catch (err) {
                console.error('[STREAM] addToQueue lỗi:', err.message);
                await interaction.editReply(`❌ Lỗi: \`${err.message}\``).catch(() => { });
            }
        }

        // ===== /streamtest — phát thẳng file local, bỏ qua queue =====
        if (interaction.commandName === 'streamtest') {
            await interaction.deferReply();
            const voiceChannel = interaction.member?.voice?.channel;
            if (!voiceChannel)
                return interaction.editReply('❌ Vào Voice Channel trước!');

            const TEST_FILE = 'C:\\Users\\tatua\\Documents\\_1778585447874.mp4';
            await interaction.editReply(`🧪 Test stream: \`${TEST_FILE}\``);

            await getSelfbot();
            playOne(interaction.guildId, voiceChannel.id, {
                input: TEST_FILE,
                addedBy: interaction.user.id,
            }, interaction.channel).catch(err => {
                console.error('[STREAMTEST] lỗi:', err.message);
            });
        }

        // ===== /streamstop =====
        if (interaction.commandName === 'streamstop') {
            await interaction.deferReply();
            const stopped = await stopStream(interaction.guildId);
            await interaction.editReply(
                stopped
                    ? '⏹️ Đã dừng stream và xóa toàn bộ hàng đợi.'
                    : '❌ Không có stream nào đang chạy.'
            );
        }

        // ===== /streamskip =====
        if (interaction.commandName === 'streamskip') {
            await interaction.deferReply();
            const queue = getQueue(interaction.guildId);
            if (queue.length === 0 && !streamSessions.has(interaction.guildId)) {
                return interaction.editReply('❌ Không có gì để skip.');
            }
            const skipped = await skipStream(interaction.guildId);
            await interaction.editReply(
                skipped
                    ? `⏭️ Đã skip! Hàng đợi còn **${queue.length}** bài.`
                    : '❌ Không có stream nào đang chạy.'
            );
        }

        // ===== /streamqueue =====
        if (interaction.commandName === 'streamqueue') {
            const session = streamSessions.get(interaction.guildId);
            const queue = getQueue(interaction.guildId);

            if (!session && queue.length === 0) {
                return interaction.reply({ content: '📋 Hàng đợi trống.', ephemeral: true });
            }

            let msg = '';

            if (session) {
                const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);
                msg += `**🎬 Đang phát:**\n`;
                msg += `\`${session.input.length > 70 ? session.input.slice(0, 70) + '...' : session.input}\`\n`;
                msg += `⏱️ \`${Math.floor(elapsed / 60)}m ${elapsed % 60}s\`\n\n`;
            }

            if (queue.length > 0) {
                msg += `**📋 Hàng đợi (${queue.length} bài):**\n`;
                queue.slice(0, 10).forEach((item, i) => {
                    const label = item.input.length > 60
                        ? item.input.slice(0, 60) + '...'
                        : item.input;
                    msg += `**${i + 1}.** \`${label}\` — <@${item.addedBy}>\n`;
                });
                if (queue.length > 10) {
                    msg += `_...và ${queue.length - 10} bài nữa_\n`;
                }
            } else {
                msg += `📋 Hàng đợi trống — đang phát bài cuối.`;
            }

            await interaction.reply({ content: msg, ephemeral: true });
        }

        // ===== /streamclear =====
        if (interaction.commandName === 'streamclear') {
            const queue = getQueue(interaction.guildId);
            const count = queue.length;
            streamQueues.set(interaction.guildId, []);
            await interaction.reply({
                content: count > 0
                    ? `🗑️ Đã xóa **${count}** bài khỏi hàng đợi. Bài đang phát vẫn tiếp tục.`
                    : '📋 Hàng đợi đã trống rồi.',
                ephemeral: true,
            });
        }

        // ===== /streaminfo =====
        if (interaction.commandName === 'streaminfo') {
            const session = streamSessions.get(interaction.guildId);
            if (!session)
                return interaction.reply({ content: '❌ Không có stream nào đang chạy.', ephemeral: true });
            const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);
            const queue = getQueue(interaction.guildId);
            await interaction.reply({
                content:
                    `📺 **Stream đang chạy**\n` +
                    `🔗 Nguồn: \`${session.input.slice(0, 80)}\`\n` +
                    `📡 Loại: \`${session.sourceType}\`\n` +
                    `⏱️ Thời gian: \`${Math.floor(elapsed / 60)}m ${elapsed % 60}s\`\n` +
                    `📋 Hàng đợi: **${queue.length}** bài\n` +
                    `🎥 Chất lượng: \`${VIDEO_WIDTH}x${VIDEO_HEIGHT} @ ${VIDEO_FPS}fps | ${BITRATE_VIDEO}kbps\``,
                ephemeral: true,
            });
        }

        // ===== /streamsync =====
        if (interaction.commandName === 'streamsync') {
            await interaction.reply({
                content:
                    `⚙️ **Hướng dẫn chỉnh A/V Sync**\n\n` +
                    `Mở \`Stream.js\`, tìm:\n` +
                    `\`const AUDIO_DELAY_MS = 0;\`\n\n` +
                    `• **Video chậm hơn audio** → tăng lên \`150\`, \`200\`, \`300\`\n` +
                    `• **Audio chậm hơn video** → giữ \`0\`\n\n` +
                    `Restart bot và stream lại.\n` +
                    `Delay hiện tại: \`${AUDIO_DELAY_MS}ms\``,
                ephemeral: true,
            });
        }
    });
};

// ===== SLASH COMMANDS =====
const streamCommands = [
    new SlashCommandBuilder()
        .setName('stream')
        .setDescription('Stream video / thêm vào hàng đợi')
        .addStringOption(o =>
            o.setName('input')
                .setDescription('YouTube URL / link mp4 / HLS / file local')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('streamtest')
        .setDescription('Test stream file local hardcode — debug fps'),
    new SlashCommandBuilder()
        .setName('streamskip')
        .setDescription('Bỏ qua bài hiện tại, phát bài tiếp theo'),
    new SlashCommandBuilder()
        .setName('streamqueue')
        .setDescription('Xem hàng đợi đang chờ'),
    new SlashCommandBuilder()
        .setName('streamclear')
        .setDescription('Xóa hàng đợi (bài đang phát vẫn tiếp tục)'),
    new SlashCommandBuilder()
        .setName('streaminfo')
        .setDescription('Xem thông tin stream + chất lượng hiện tại'),
    new SlashCommandBuilder()
        .setName('streamsync')
        .setDescription('Hướng dẫn chỉnh A/V sync delay'),
].map(c => c.toJSON());

module.exports.streamCommands = streamCommands;