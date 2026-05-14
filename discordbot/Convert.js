/**
 * Convert.js — Đổi đuôi & nén file
 *
 * Hỗ trợ:
 *   Video  : mp4 mkv avi mov webm  →  mp3 / mp4 / gif
 *   Audio  : mp3 wav flac ogg m4a  →  mp3
 *   Ảnh    : png jpg jpeg webp     →  png / jpg / webp / gif
 *   GIF    : gif                   →  mp4 / gif (nén)
 *
 * Luồng:
 *   User đính kèm file + chọn action
 *   → tải attachment về tmp/
 *   → ffmpeg xử lý
 *   → < 10 MB: gửi thẳng Discord
 *   → ≥ 10 MB: zip → upload litterbox.catbox.moe → gửi link
 *   → cleanup tmp/
 *
 * Phụ thuộc: ffmpeg trong PATH, npm install form-data node-fetch@2
 *
 * Lệnh:
 *   /convert-setup  — Admin chọn kênh nhận output
 *   /convert        — User đính kèm file + chọn action
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    AttachmentBuilder,
    MessageFlags,
} = require('discord.js');

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const FormData = require('form-data');
const fetch = require('node-fetch');

const execFileAsync = promisify(execFile);

// ===== CONFIG =====
const CONFIG_FILE = './convert_config.json';

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch { return {}; }
}
function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ===== TMP =====
const TMP_DIR = './tmp_convert';
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function cleanupTmp() {
    try {
        const now = Date.now();
        for (const f of fs.readdirSync(TMP_DIR)) {
            const fp = path.join(TMP_DIR, f);
            try {
                if (now - fs.statSync(fp).mtimeMs > 3_600_000)
                    fs.rmSync(fp, { recursive: true, force: true });
            } catch { }
        }
    } catch { }
}
cleanupTmp();
setInterval(cleanupTmp, 30 * 60 * 1000);

// ===== CONSTANTS =====
const DIRECT_MAX_MB = 10;
const LITTERBOX_EXPIRY = '72h';

// ===== SUPPORTED EXTENSIONS =====
const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'webm'];
const AUDIO_EXTS = ['mp3', 'wav', 'flac', 'ogg', 'm4a'];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
const GIF_EXTS = ['gif'];
const ALL_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS, ...GIF_EXTS];

// ===== ACTION CHOICES =====
// Được generate động theo input ext, nhưng khai báo tất cả có thể ở đây
const ACTION_CHOICES = [
    { name: '🎵 Chuyển sang MP3', value: 'to_mp3' },
    { name: '🎬 Chuyển sang MP4', value: 'to_mp4' },
    { name: '🌀 Chuyển sang GIF', value: 'to_gif' },
    { name: '🖼️ Chuyển sang PNG', value: 'to_png' },
    { name: '🖼️ Chuyển sang JPG', value: 'to_jpg' },
    { name: '🖼️ Chuyển sang WEBP', value: 'to_webp' },
    { name: '📦 Nén video (giảm dung lượng)', value: 'compress_video' },
    { name: '📦 Nén audio (giảm dung lượng)', value: 'compress_audio' },
    { name: '📦 Nén ảnh (giảm dung lượng)', value: 'compress_image' },
    { name: '📦 Nén GIF (giảm dung lượng)', value: 'compress_gif' },
];

// ===== HELPERS =====
function fileSizeMB(fp) {
    try { return fs.statSync(fp).size / 1024 / 1024; }
    catch { return 0; }
}

function tmpPath(name) {
    return path.join(TMP_DIR, `${Date.now()}_${name}`);
}

function getExt(filename) {
    return path.extname(filename).replace('.', '').toLowerCase();
}

function cleanup(...files) {
    for (const f of files) {
        try { if (f && fs.existsSync(f)) fs.rmSync(f, { force: true }); }
        catch { }
    }
}

// ===== DOWNLOAD ATTACHMENT =====
async function downloadAttachment(url, destPath) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Tải file thất bại: ${res.status}`);
    const buf = await res.buffer();
    fs.writeFileSync(destPath, buf);
}

// ===== UPLOAD LITTERBOX =====
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
        headers: form.getHeaders(),
        timeout: 120_000,
    });

    const text = (await res.text()).trim();
    if (!text.startsWith('https://')) throw new Error(`Catbox lỗi: ${text}`);
    return text;
}

// ===== FFMPEG WRAPPERS =====

// Video → MP3
function convertToMp3(input, output) {
    return execFileAsync('ffmpeg', [
        '-y', '-i', input,
        '-vn', '-ar', '44100', '-ac', '2', '-b:a', '192k',
        output,
    ], { timeout: 300_000 });
}

// Video/anything → MP4 (re-encode H.264)
function convertToMp4(input, output) {
    return execFileAsync('ffmpeg', [
        '-y', '-i', input,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        output,
    ], { timeout: 600_000 });
}

// Video/GIF → GIF (2-pass palette để đẹp)
async function convertToGif(input, output) {
    const palette = tmpPath('palette.png');
    try {
        // Pass 1: tạo palette
        await execFileAsync('ffmpeg', [
            '-y', '-i', input,
            '-vf', 'fps=15,scale=480:-1:flags=lanczos,palettegen=max_colors=128',
            palette,
        ], { timeout: 120_000 });

        // Pass 2: render gif với palette
        await execFileAsync('ffmpeg', [
            '-y', '-i', input, '-i', palette,
            '-filter_complex', 'fps=15,scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer',
            output,
        ], { timeout: 300_000 });
    } finally {
        cleanup(palette);
    }
}

// GIF/Video → MP4
function convertGifToMp4(input, output) {
    return execFileAsync('ffmpeg', [
        '-y', '-i', input,
        '-movflags', '+faststart',
        '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        output,
    ], { timeout: 180_000 });
}

// Image → PNG/JPG/WEBP
function convertImage(input, output) {
    const ext = getExt(output);
    const args = ['-y', '-i', input];
    if (ext === 'jpg' || ext === 'jpeg') args.push('-q:v', '2');
    if (ext === 'webp') args.push('-quality', '85');
    args.push(output);
    return execFileAsync('ffmpeg', args, { timeout: 60_000 });
}

// Nén video: CRF cao hơn = nhỏ hơn
function compressVideo(input, output) {
    return execFileAsync('ffmpeg', [
        '-y', '-i', input,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '28',
        '-c:a', 'aac', '-b:a', '96k',
        '-vf', 'scale=iw*0.75:-2',
        '-movflags', '+faststart',
        output,
    ], { timeout: 600_000 });
}

// Nén audio: giảm bitrate
function compressAudio(input, output) {
    return execFileAsync('ffmpeg', [
        '-y', '-i', input,
        '-b:a', '96k',
        output,
    ], { timeout: 120_000 });
}

// Nén ảnh
function compressImage(input, output) {
    const ext = getExt(output);
    const args = ['-y', '-i', input];
    if (ext === 'png') args.push('-compression_level', '9');
    if (ext === 'jpg' || ext === 'jpeg') args.push('-q:v', '5');
    if (ext === 'webp') args.push('-quality', '60');
    args.push(output);
    return execFileAsync('ffmpeg', args, { timeout: 60_000 });
}

// Nén GIF: giảm fps + màu + resize
async function compressGif(input, output) {
    const palette = tmpPath('palette_c.png');
    try {
        await execFileAsync('ffmpeg', [
            '-y', '-i', input,
            '-vf', 'fps=10,scale=320:-1:flags=lanczos,palettegen=max_colors=64',
            palette,
        ], { timeout: 60_000 });

        await execFileAsync('ffmpeg', [
            '-y', '-i', input, '-i', palette,
            '-filter_complex', 'fps=10,scale=320:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer',
            output,
        ], { timeout: 180_000 });
    } finally {
        cleanup(palette);
    }
}

// ===== VALIDATE ACTION vs EXT =====
function validateAction(ext, action) {
    const isVideo = VIDEO_EXTS.includes(ext);
    const isAudio = AUDIO_EXTS.includes(ext);
    const isImage = IMAGE_EXTS.includes(ext);
    const isGif = ext === 'gif';

    const map = {
        to_mp3: isVideo || isAudio,
        to_mp4: isVideo || isGif,
        to_gif: isVideo || isGif || isImage,
        to_png: isImage || isGif,
        to_jpg: isImage || isGif,
        to_webp: isImage || isGif,
        compress_video: isVideo,
        compress_audio: isAudio,
        compress_image: isImage,
        compress_gif: isGif,
    };

    return map[action] ?? false;
}

// Output extension theo action
function outputExt(action, inputExt) {
    const m = {
        to_mp3: 'mp3',
        to_mp4: 'mp4',
        to_gif: 'gif',
        to_png: 'png',
        to_jpg: 'jpg',
        to_webp: 'webp',
        compress_video: 'mp4',
        compress_audio: inputExt === 'mp3' ? 'mp3' : 'mp3',
        compress_image: inputExt,
        compress_gif: 'gif',
    };
    return m[action] ?? inputExt;
}

// ===== RUN CONVERSION =====
async function runConvert(action, inputPath, outputPath, inputExt) {
    switch (action) {
        case 'to_mp3': return convertToMp3(inputPath, outputPath);
        case 'to_mp4':
            return (inputExt === 'gif')
                ? convertGifToMp4(inputPath, outputPath)
                : convertToMp4(inputPath, outputPath);
        case 'to_gif': return convertToGif(inputPath, outputPath);
        case 'to_png':
        case 'to_jpg':
        case 'to_webp': return convertImage(inputPath, outputPath);
        case 'compress_video': return compressVideo(inputPath, outputPath);
        case 'compress_audio': return compressAudio(inputPath, outputPath);
        case 'compress_image': return compressImage(inputPath, outputPath);
        case 'compress_gif': return compressGif(inputPath, outputPath);
        default: throw new Error('Action không hợp lệ');
    }
}

// ===== ACTION LABEL =====
function actionLabel(action) {
    return ACTION_CHOICES.find(a => a.value === action)?.name ?? action;
}

// ===== SLASH COMMANDS =====
const convertCommands = [
    new SlashCommandBuilder()
        .setName('convert-setup')
        .setDescription('(Admin) Chọn kênh nhận file output của /convert')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addChannelOption(o =>
            o.setName('channel')
                .setDescription('Kênh nhận file đã xử lý')
                .setRequired(true)
                .addChannelTypes(0) // 0 = GuildText, chỉ hiện text channel
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName('convert')
        .setDescription('Đổi đuôi hoặc nén file (video/audio/ảnh/gif)')
        .addAttachmentOption(o =>
            o.setName('file')
                .setDescription('File cần xử lý')
                .setRequired(true)
        )
        .addStringOption(o =>
            o.setName('action')
                .setDescription('Thao tác cần thực hiện')
                .setRequired(true)
                .addChoices(...ACTION_CHOICES)
        )
        .toJSON(),
];

// ===== MODULE =====
module.exports = (client) => {
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        // ── /convert-setup ───────────────────────────────────────
        if (interaction.commandName === 'convert-setup') {
            const channel = interaction.options.getChannel('channel');
            const cfg = loadConfig();
            cfg[interaction.guildId] = { channelId: channel.id, channelName: channel.name };
            saveConfig(cfg);

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setTitle('✅ Convert Setup')
                        .setDescription(`File output sẽ được gửi vào ${channel}\n\nDùng \`/convert\` để bắt đầu đổi đuôi hoặc nén file.`)
                        .setTimestamp(),
                ],
                flags: MessageFlags.Ephemeral,
            });
        }

        // ── /convert ─────────────────────────────────────────────
        if (interaction.commandName === 'convert') {
            const cfg = loadConfig();
            const guildCfg = cfg[interaction.guildId];

            if (!guildCfg) {
                return interaction.reply({
                    content: '⚠️ Chưa setup kênh output! Admin dùng `/convert-setup` trước nhé.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const targetChannel = interaction.guild.channels.cache.get(guildCfg.channelId);
            if (!targetChannel) {
                return interaction.reply({
                    content: `❌ Kênh <#${guildCfg.channelId}> không còn tồn tại. Admin cần \`/convert-setup\` lại.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const attachment = interaction.options.getAttachment('file');
            const action = interaction.options.getString('action');
            const origName = attachment.name || 'file';
            const inputExt = getExt(origName);

            // Kiểm tra định dạng hỗ trợ
            if (!ALL_EXTS.includes(inputExt)) {
                return interaction.reply({
                    content: `❌ Định dạng \`${inputExt}\` chưa được hỗ trợ.\nHỗ trợ: \`${ALL_EXTS.join(', ')}\``,
                    flags: MessageFlags.Ephemeral,
                });
            }

            // Kiểm tra action có phù hợp với file không
            if (!validateAction(inputExt, action)) {
                return interaction.reply({
                    content: `❌ Không thể thực hiện **${actionLabel(action)}** với file \`.${inputExt}\``,
                    flags: MessageFlags.Ephemeral,
                });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const outExt = outputExt(action, inputExt);
            const baseName = path.basename(origName, `.${inputExt}`);
            const inputPath = tmpPath(`input.${inputExt}`);
            const outputPath = tmpPath(`${baseName}_converted.${outExt}`);

            // Bước 1: thông báo đang tải
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setTitle('⏳ Đang tải file về server...')
                        .addFields(
                            { name: '📄 File', value: origName, inline: true },
                            { name: '📦 Thao tác', value: actionLabel(action), inline: true },
                            { name: '📁 Kích thước', value: `${(attachment.size / 1024 / 1024).toFixed(2)} MB`, inline: true },
                        )
                        .setFooter({ text: 'Bước 1/3 — Tải file...' })
                        .setTimestamp(),
                ],
            });

            try {
                await downloadAttachment(attachment.url, inputPath);
            } catch (err) {
                cleanup(inputPath);
                return interaction.editReply({ content: `❌ Tải file thất bại: ${err.message}`, embeds: [] });
            }

            // Bước 2: thông báo đang xử lý
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setTitle('⚙️ Đang xử lý...')
                        .addFields(
                            { name: '📄 File', value: origName, inline: true },
                            { name: '📦 Thao tác', value: actionLabel(action), inline: true },
                            { name: '🔄 Output', value: `.${outExt}`, inline: true },
                        )
                        .setFooter({ text: 'Bước 2/3 — ffmpeg đang chạy...' })
                        .setTimestamp(),
                ],
            });

            try {
                await runConvert(action, inputPath, outputPath, inputExt);
            } catch (err) {
                cleanup(inputPath, outputPath);
                return interaction.editReply({
                    content: `❌ Xử lý thất bại:\n\`\`\`${err.stderr || err.message}\`\`\``,
                    embeds: [],
                });
            }

            cleanup(inputPath);

            const sizeBefore = attachment.size / 1024 / 1024;
            const sizeAfter = fileSizeMB(outputPath);
            const savedPct = sizeBefore > 0
                ? ((1 - sizeAfter / sizeBefore) * 100).toFixed(1)
                : '0';
            const outFileName = `${baseName}_converted.${outExt}`;

            // ── < 10MB: gửi thẳng Discord ──
            if (sizeAfter < DIRECT_MAX_MB) {
                const file = new AttachmentBuilder(outputPath, { name: outFileName });

                const resultEmbed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('✅ Xử lý xong!')
                    .addFields(
                        { name: '📄 File gốc', value: `${origName} (${sizeBefore.toFixed(2)} MB)`, inline: false },
                        { name: '✨ File mới', value: `${outFileName} (${sizeAfter.toFixed(2)} MB)`, inline: false },
                        { name: '📉 Đã giảm', value: `${savedPct}%`, inline: true },
                        { name: '📦 Thao tác', value: actionLabel(action), inline: true },
                        { name: '👤 Bởi', value: `${interaction.user}`, inline: true },
                    )
                    .setFooter({ text: '⚡ Gửi trực tiếp — không qua catbox' })
                    .setTimestamp();

                try {
                    await targetChannel.send({ embeds: [resultEmbed], files: [file] });
                } catch (err) {
                    cleanup(outputPath);
                    return interaction.editReply({ content: `❌ Không gửi được vào ${targetChannel}: ${err.message}`, embeds: [] });
                }

                cleanup(outputPath);

                await interaction.editReply({
                    content: `✅ Xong! File đã gửi vào ${targetChannel}\n\n*⏳ Tin nhắn này sẽ tự xóa sau 30 giây...*`,
                    embeds: [],
                });
                setTimeout(() => interaction.deleteReply().catch(() => { }), 30_000);
                return;
            }

            // ── ≥ 10MB: upload catbox ──
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setTitle('⏳ Đang upload lên litterbox.catbox.moe...')
                        .addFields(
                            { name: '📄 File', value: outFileName, inline: true },
                            { name: '📁 Kích thước', value: `${sizeAfter.toFixed(2)} MB`, inline: true },
                        )
                        .setFooter({ text: 'Bước 3/3 — File lớn, đang upload catbox...' })
                        .setTimestamp(),
                ],
            });

            let fileUrl;
            try {
                fileUrl = await uploadToLitterbox(outputPath);
            } catch (err) {
                cleanup(outputPath);
                return interaction.editReply({ content: `❌ Upload thất bại: ${err.message}`, embeds: [] });
            }

            cleanup(outputPath);

            const resultEmbed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('✅ Xử lý xong!')
                .setURL(fileUrl)
                .addFields(
                    { name: '📄 File gốc', value: `${origName} (${sizeBefore.toFixed(2)} MB)`, inline: false },
                    { name: '✨ File mới', value: `${outFileName} (${sizeAfter.toFixed(2)} MB)`, inline: false },
                    { name: '📉 Đã giảm', value: `${savedPct}%`, inline: true },
                    { name: '📦 Thao tác', value: actionLabel(action), inline: true },
                    { name: '👤 Bởi', value: `${interaction.user}`, inline: true },
                    { name: '🔗 Link tải', value: `[👆 Nhấn để tải](${fileUrl})`, inline: false },
                )
                .setFooter({ text: `litterbox.catbox.moe — link tồn tại ${LITTERBOX_EXPIRY}` })
                .setTimestamp();

            try {
                await targetChannel.send({ embeds: [resultEmbed] });
            } catch (err) {
                return interaction.editReply({ content: `❌ Không gửi được vào ${targetChannel}: ${err.message}`, embeds: [] });
            }

            await interaction.editReply({
                content: `✅ Xong! Link đã gửi vào ${targetChannel}\n🔗 ${fileUrl}\n\n*⏳ Tin nhắn này sẽ tự xóa sau 30 giây...*`,
                embeds: [],
            });
            setTimeout(() => interaction.deleteReply().catch(() => { }), 30_000);
        }
    });
};

module.exports.convertCommands = convertCommands;