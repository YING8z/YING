const {
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits,
    ChannelType,
    SlashCommandBuilder,
    MessageFlags,
    AttachmentBuilder
} = require('discord.js');
const https = require('https');
const http = require('http');
// ===========================
// AUTO-DELETE HELPER
// Xóa tin nhắn sau 'delay' ms (mặc định 60 giây)
// ===========================
async function autoDelete(msgOrInteraction, delay = 60_000) {
    setTimeout(async () => {
        try {
            if (typeof msgOrInteraction.delete === 'function') {
                await msgOrInteraction.delete();
            } else if (typeof msgOrInteraction.deleteReply === 'function') {
                await msgOrInteraction.deleteReply();
            }
        } catch { /* đã bị xóa hoặc không có quyền */ }
    }, delay);
}

const fs = require('fs');

// ===========================
// STORAGE
// ===========================
const SCHEDULE_FILE = './schedules.json';

const loadSchedules = () => {
    try {
        if (!fs.existsSync(SCHEDULE_FILE)) return [];
        return JSON.parse(fs.readFileSync(SCHEDULE_FILE));
    } catch { return []; }
};

const saveSchedules = (list) => {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(list, null, 2));
};

// ===========================
// MEDIA STORAGE CHANNEL
// ===========================
const STORAGE_CHANNEL_NAME = '📦-media-storage';
let storageChannel = null; // cache sau khi tìm/tạo

async function getStorageChannel(guild) {
    if (storageChannel && storageChannel.guildId === guild.id) return storageChannel;

    // Tìm channel đã có
    let ch = guild.channels.cache.find(
        c => c.name === STORAGE_CHANNEL_NAME && c.type === ChannelType.GuildText
    );

    if (!ch) {
        // Tạo mới, ẩn với @everyone, chỉ bot thấy
        try {
            ch = await guild.channels.create({
                name: STORAGE_CHANNEL_NAME,
                type: ChannelType.GuildText,
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone.id,
                        deny: [PermissionFlagsBits.ViewChannel]
                    },
                    {
                        id: guild.client.user.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.AttachFiles
                        ]
                    }
                ],
                topic: 'Channel lưu trữ ảnh cho scheduler — ĐỪNG XOÁ'
            });
            console.log(`[SCHED] Đã tạo storage channel: #${ch.name}`);
        } catch (err) {
            console.error('[SCHED] Không tạo được storage channel:', err.message);
            return null;
        }
    }

    storageChannel = ch;
    return ch;
}

// Download ảnh từ URL → Buffer
function downloadBuffer(url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, res => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

// Upload ảnh vào storage channel → trả về URL vĩnh viễn
async function storeImage(guild, sourceUrl, filename) {
    try {
        const ch = await getStorageChannel(guild);
        if (!ch) return sourceUrl; // fallback: dùng URL gốc

        const buf = await downloadBuffer(sourceUrl);
        const attachment = new AttachmentBuilder(buf, { name: filename || 'image.gif' });
        const msg = await ch.send({ files: [attachment] });
        const stored = msg.attachments.first()?.url;
        console.log(`[SCHED] Đã lưu ảnh vào storage: ${stored}`);
        return stored || sourceUrl;
    } catch (err) {
        console.error('[SCHED] Lỗi lưu ảnh:', err.message);
        return sourceUrl; // fallback
    }
}

// ===========================
// HELPER
// ===========================
function genId() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Việt Nam = UTC+7
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

function nowVN() {
    return new Date(Date.now() + VN_OFFSET_MS);
}

// Parse "DD/MM/YYYY HH:MM" theo giờ Việt Nam → trả về Date (UTC)
function parseDateTime(str) {
    const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const [, dd, mm, yyyy, hh, min] = m;
    // Coi input là giờ VN (UTC+7) → convert sang UTC
    const utcMs = Date.UTC(
        parseInt(yyyy),
        parseInt(mm) - 1,
        parseInt(dd),
        parseInt(hh) - 7,   // trừ 7 giờ để ra UTC
        parseInt(min)
    );
    const d = new Date(utcMs);
    return isNaN(d.getTime()) ? null : d;
}

// Format Date → chuỗi giờ VN đẹp
function fmtDate(d) {
    if (!d) return 'N/A';
    return d.toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        dateStyle: 'short',
        timeStyle: 'short'
    });
}

// Trả về giờ VN hiện tại dạng { hour, minute }
function vnTime() {
    const vn = new Date(Date.now() + VN_OFFSET_MS);
    return { hour: vn.getUTCHours(), minute: vn.getUTCMinutes() };
}

function isImageUrl(url) {
    return /\.(png|jpg|jpeg|webp|gif)(\?.*)?$/i.test(url);
}

function hasPermission(member) {
    return member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function embedStep(step, total, title, desc, color = 0x5865F2) {
    return new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: `📅 Lên lịch tin nhắn · Bước ${step}/${total}` })
        .setTitle(title)
        .setDescription(desc);
}

// ===========================
// SESSION
// ===========================
const sessions = new Map();

const STEPS = {
    SELECT_CHANNEL: 'select_channel',
    INPUT_DATETIME: 'input_datetime',
    INPUT_MESSAGE: 'input_message',
};

// ===========================
// TIMERS
// ===========================
const timers = new Map();

function clearTimer(id) {
    const t = timers.get(id);
    if (!t) return;
    clearTimeout(t.timeout);
    clearInterval(t.interval);
    timers.delete(id);
}

async function sendScheduledMessage(client, job) {
    try {
        const channel = await client.channels.fetch(job.channelId).catch(() => null);
        if (!channel) return console.error(`[SCHED] Không tìm thấy channel cho job ${job.id}`);

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTimestamp();

        if (job.message) embed.setDescription(job.message);
        if (job.imageUrl) embed.setImage(job.imageUrl);

        await channel.send({
            content: '@everyone',
            allowedMentions: { parse: ['everyone'] },
            embeds: [embed]
        });
        console.log(`[SCHED] ✅ Gửi job ${job.id} → #${channel.name}`);
    } catch (err) {
        console.error(`[SCHED] ❌ Lỗi job ${job.id}:`, err.message);
    }
}

function scheduleJob(client, job) {
    clearTimer(job.id);

    const start = new Date(job.startAt);
    const end = new Date(job.endAt);
    const now = Date.now();

    if (end.getTime() <= now) {
        console.log(`[SCHED] Job ${job.id} đã hết hạn`);
        return;
    }

    // Giờ gửi theo VN: lấy từ startAt (đã convert sang UTC khi parse)
    const startDate = new Date(job.startAt);
    const vnStart = new Date(startDate.getTime() + VN_OFFSET_MS);
    const targetHour = vnStart.getUTCHours();
    const targetMin = vnStart.getUTCMinutes();

    function msToNextSend() {
        // Tính thời điểm gửi tiếp theo theo giờ VN
        const nowUTC = Date.now();
        const nowVNMs = nowUTC + VN_OFFSET_MS;
        const nowVNDate = new Date(nowVNMs);

        // Thời điểm gửi hôm nay (giờ VN) → convert sang UTC
        const todaySendVN = new Date(Date.UTC(
            nowVNDate.getUTCFullYear(),
            nowVNDate.getUTCMonth(),
            nowVNDate.getUTCDate(),
            targetHour,
            targetMin,
            0
        ));
        const todaySendUTC = todaySendVN.getTime() - VN_OFFSET_MS;

        if (todaySendUTC > nowUTC) return todaySendUTC - nowUTC;

        // Đã qua giờ hôm nay → ngày mai
        return todaySendUTC + 24 * 60 * 60 * 1000 - nowUTC;
    }

    const firstDelay = start.getTime() > now ? start.getTime() - now : msToNextSend();

    const timeout = setTimeout(async () => {
        if (Date.now() > new Date(job.endAt).getTime()) {
            const list = loadSchedules().filter(j => j.id !== job.id);
            saveSchedules(list);
            timers.delete(job.id);
            return;
        }

        await sendScheduledMessage(client, job);

        const iv = setInterval(async () => {
            if (Date.now() > new Date(job.endAt).getTime()) {
                clearInterval(iv);
                timers.delete(job.id);
                const list = loadSchedules().filter(j => j.id !== job.id);
                saveSchedules(list);
                return;
            }
            await sendScheduledMessage(client, job);
        }, 24 * 60 * 60 * 1000);

        const existing = timers.get(job.id) || {};
        timers.set(job.id, { ...existing, interval: iv });
    }, firstDelay);

    timers.set(job.id, { timeout, interval: null });
    console.log(`[SCHED] Job ${job.id} → sau ${Math.round(firstDelay / 1000)}s · hết hạn ${fmtDate(end)}`);
}

function initScheduler(client) {
    const list = loadSchedules();
    console.log(`[SCHED] Load ${list.length} jobs`);
    for (const job of list) scheduleJob(client, job);
}

// ===========================
// EXPORT COMMANDS
// ===========================
const scheduleCommands = [
    new SlashCommandBuilder()
        .setName('schedule')
        .setDescription('📅 Quản lý tin nhắn lên lịch')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('Thêm lịch gửi tin nhắn mới'))
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('Xem danh sách lịch đã đặt'))
        .addSubcommand(sub => sub
            .setName('cancel')
            .setDescription('Huỷ một lịch theo ID')
            .addStringOption(o => o
                .setName('id')
                .setDescription('ID của lịch (lấy từ /schedule list)')
                .setRequired(true)))
].map(c => c.toJSON());

module.exports.scheduleCommands = scheduleCommands;

// ===========================
// MAIN
// ===========================
module.exports = (client) => {
    initScheduler(client);

    // ── interactionCreate ──────────────────────────────────────
    client.on('interactionCreate', async interaction => {

        // ── /schedule ──
        if (interaction.isChatInputCommand() && interaction.commandName === 'schedule') {
            if (!hasPermission(interaction.member)) {
                await interaction.reply({
                    content: '❌ Bạn cần quyền **Administrator** hoặc **Manage Server**.',
                    flags: MessageFlags.Ephemeral
                });
                autoDelete(interaction);
                return;
            }

            const sub = interaction.options.getSubcommand();

            // ──── ADD ────────────────────────────────────────────
            if (sub === 'add') {
                const channels = interaction.guild.channels.cache
                    .filter(c => c.type === ChannelType.GuildText)
                    .sort((a, b) => a.position - b.position)
                    .first(25);

                const options = channels.map(c => ({
                    label: `# ${c.name}`,
                    value: c.id,
                    description: c.topic ? c.topic.slice(0, 50) : undefined
                }));

                const select = new StringSelectMenuBuilder()
                    .setCustomId('sched_channel')
                    .setPlaceholder('Chọn channel...')
                    .addOptions(options);

                const row = new ActionRowBuilder().addComponents(select);

                const embed = embedStep(1, 3,
                    '📢 Chọn channel gửi tin nhắn',
                    'Hãy chọn channel mà bot sẽ gửi tin nhắn theo lịch.'
                );

                await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });

                sessions.set(interaction.user.id, {
                    step: STEPS.SELECT_CHANNEL,
                    guildId: interaction.guild.id,
                    interactionChannelId: interaction.channel.id,
                    data: {}
                });

                return;
            }

            // ──── LIST ───────────────────────────────────────────
            if (sub === 'list') {
                const list = loadSchedules().filter(j => j.guildId === interaction.guild.id);

                if (list.length === 0) {
                    await interaction.reply({
                        embeds: [new EmbedBuilder().setColor(0xFEE75C).setDescription('📭 Chưa có lịch nào.')],
                        flags: MessageFlags.Ephemeral
                    });
                    autoDelete(interaction);
                    return;
                }

                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle(`📋 Danh sách lịch · ${list.length} job`)
                    .setTimestamp();

                for (const job of list.slice(0, 10)) {
                    const start = new Date(job.startAt);
                    const end = new Date(job.endAt);
                    const preview = (job.message || '').slice(0, 80) + ((job.message || '').length > 80 ? '…' : '');
                    embed.addFields({
                        name: `\`${job.id}\` · <#${job.channelId}>`,
                        value: [
                            `📅 **Bắt đầu:** ${fmtDate(start)}`,
                            `🏁 **Kết thúc:** ${fmtDate(end)}`,
                            `⏰ **Giờ gửi:** ${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')} mỗi ngày`,
                            `💬 **Nội dung:** ${preview || '_Không có text_'}`,
                            job.imageUrl ? `🖼 **Ảnh:** có` : ''
                        ].filter(Boolean).join('\n')
                    });
                }

                if (list.length > 10) embed.setFooter({ text: `Hiển thị 10/${list.length}` });

                // Nút xoá (tối đa 5 vì Discord giới hạn 5 ActionRow)
                const rows = list.slice(0, 5).map(job =>
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`sched_del_${job.id}`)
                            .setLabel(`🗑 Xoá ${job.id}`)
                            .setStyle(ButtonStyle.Danger)
                    )
                );

                await interaction.reply({ embeds: [embed], components: rows, flags: MessageFlags.Ephemeral });
                autoDelete(interaction, 120_000);
                return;
            }

            // ──── CANCEL ─────────────────────────────────────────
            if (sub === 'cancel') {
                const id = interaction.options.getString('id').toUpperCase();
                const list = loadSchedules();
                const idx = list.findIndex(j => j.id === id && j.guildId === interaction.guild.id);

                if (idx === -1) {
                    await interaction.reply({ content: `❌ Không tìm thấy job \`${id}\``, flags: MessageFlags.Ephemeral });
                    autoDelete(interaction);
                    return;
                }

                clearTimer(id);
                list.splice(idx, 1);
                saveSchedules(list);

                await interaction.reply({
                    embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`✅ Đã huỷ lịch \`${id}\`.`)],
                    flags: MessageFlags.Ephemeral
                });
                autoDelete(interaction);
                return;
            }
        }

        // ── Select menu chọn channel ──
        if (interaction.isStringSelectMenu() && interaction.customId === 'sched_channel') {
            const session = sessions.get(interaction.user.id);
            if (!session || session.step !== STEPS.SELECT_CHANNEL) return;

            session.data.channelId = interaction.values[0];
            session.step = STEPS.INPUT_DATETIME;
            sessions.set(interaction.user.id, session);

            const embed = embedStep(2, 3,
                '📅 Nhập ngày giờ bắt đầu & kết thúc',
                [
                    `✅ Channel đã chọn: <#${session.data.channelId}>`,
                    '',
                    'Nhập **2 dòng** vào chat bên dưới:',
                    '```',
                    'Dòng 1 → ngày giờ BẮT ĐẦU',
                    'Dòng 2 → ngày giờ KẾT THÚC',
                    '```',
                    '**Định dạng:** `DD/MM/YYYY HH:MM`',
                    '',
                    '**Ví dụ:**',
                    '```',
                    '25/12/2025 08:00',
                    '31/12/2025 23:59',
                    '```',
                    '> 🔁 Bot sẽ gửi **mỗi ngày** vào đúng giờ bắt đầu cho đến khi hết hạn.'
                ].join('\n'),
                0xFEE75C
            );

            // Cập nhật ephemeral confirm
            await interaction.update({
                embeds: [new EmbedBuilder().setColor(0x57F287).setDescription(`✅ Đã chọn <#${session.data.channelId}>! Xem hướng dẫn bước 2 trong channel.`)],
                components: []
            });
            autoDelete(interaction);

            // Gửi hướng dẫn bước 2 ra channel thật để user thấy và nhập
            const realChannel = await interaction.guild.channels.fetch(session.interactionChannelId).catch(() => null);
            if (realChannel) { const m = await realChannel.send({ embeds: [embed] }); autoDelete(m); }
            return;
        }

        // ── Button xoá từ /schedule list ──
        if (interaction.isButton() && interaction.customId.startsWith('sched_del_')) {
            if (!hasPermission(interaction.member)) {
                return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
            }

            const id = interaction.customId.replace('sched_del_', '');
            const list = loadSchedules();
            const idx = list.findIndex(j => j.id === id);

            if (idx === -1) {
                return interaction.reply({ content: `❌ Không tìm thấy job \`${id}\``, flags: MessageFlags.Ephemeral });
            }

            clearTimer(id);
            list.splice(idx, 1);
            saveSchedules(list);

            await interaction.reply({ content: `✅ Đã xoá lịch \`${id}\`.`, flags: MessageFlags.Ephemeral }); autoDelete(interaction);
            await interaction.message.edit({ components: [] }).catch(() => { });
            return;
        }
    });

    // ── messageCreate — nhận input từng bước ──────────────────
    client.on('messageCreate', async message => {
        if (message.author.bot) return;
        if (!message.guild) return;

        const session = sessions.get(message.author.id);
        if (!session) return;
        if (message.guild.id !== session.guildId) return;
        if (message.channel.id !== session.interactionChannelId) return;

        console.log(`[SCHED] Step nhận: user=${message.author.username}, step=${session.step}, channel=${message.channel.id}, expected=${session.interactionChannelId}`);

        // ── Bước 2: nhập start + end ──
        if (session.step === STEPS.INPUT_DATETIME) {
            const lines = message.content.trim().split('\n').map(l => l.trim()).filter(Boolean);

            if (lines.length < 2) {
                return message.reply(
                    '❌ Cần nhập **2 dòng**:\n```\nDD/MM/YYYY HH:MM  ← bắt đầu\nDD/MM/YYYY HH:MM  ← kết thúc\n```'
                );
            }

            const start = parseDateTime(lines[0]);
            const end = parseDateTime(lines[1]);

            if (!start) return message.reply(`❌ Dòng 1 sai định dạng: \`${lines[0]}\`\nDùng: \`DD/MM/YYYY HH:MM\``);
            if (!end) return message.reply(`❌ Dòng 2 sai định dạng: \`${lines[1]}\`\nDùng: \`DD/MM/YYYY HH:MM\``);
            if (end <= start) return message.reply('❌ Ngày kết thúc phải **sau** ngày bắt đầu.');
            if (start < new Date()) return message.reply('❌ Ngày bắt đầu phải ở **tương lai**. (Giờ VN hiện tại: ' + fmtDate(new Date()) + ')');

            session.data.startAt = start.toISOString();
            session.data.endAt = end.toISOString();
            session.step = STEPS.INPUT_MESSAGE;
            sessions.set(message.author.id, session);

            await message.delete().catch(() => { });

            const embed = embedStep(3, 3,
                '💬 Nhập nội dung tin nhắn',
                [
                    `✅ **Bắt đầu:** ${fmtDate(start)}`,
                    `✅ **Kết thúc:** ${fmtDate(end)}`,
                    '',
                    'Gửi nội dung tin nhắn muốn bot đăng vào chat.',
                    '',
                    '> 🖼 Có thể **đính kèm ảnh** (png, jpg, webp, gif) cùng tin nhắn.',
                    '> 🔗 Hoặc dán **link ảnh** trực tiếp vào nội dung.',
                    '> ✏️ Để trống nội dung nếu chỉ muốn gửi ảnh.'
                ].join('\n'),
                0x57F287
            );

            { const m = await message.channel.send({ embeds: [embed] }); autoDelete(m); }
            return;
        }

        // ── Bước 3: nhận nội dung + ảnh ──
        if (session.step === STEPS.INPUT_MESSAGE) {
            const content = message.content.trim();

            // Lấy ảnh từ attachment
            let imageUrl = null;
            let imageFilename = 'image.gif';
            const attachment = message.attachments.first();
            if (attachment && isImageUrl(attachment.url)) {
                imageUrl = attachment.url;
                imageFilename = attachment.name || 'image.gif';
            }

            // Hoặc từ URL trong nội dung
            if (!imageUrl) {
                const urlMatch = content.match(/https?:\/\/\S+\.(png|jpg|jpeg|webp|gif)(\?\S*)?/i);
                if (urlMatch) imageUrl = urlMatch[0];
                imageFilename = urlMatch ? urlMatch[0].split('/').pop().split('?')[0] : 'image.gif';
            }

            if (!content && !imageUrl) {
                return message.reply('❌ Cần có nội dung text hoặc ảnh. Vui lòng nhập lại.');
            }

            // Re-upload ảnh vào storage channel để có URL vĩnh viễn
            if (imageUrl) {
                const stored = await storeImage(message.guild, imageUrl, imageFilename);
                if (stored) imageUrl = stored;
            }

            // Lưu job
            const job = {
                id: genId(),
                guildId: session.guildId,
                channelId: session.data.channelId,
                startAt: session.data.startAt,
                endAt: session.data.endAt,
                message: content || null,
                imageUrl: imageUrl || null,
                createdBy: message.author.id,
                createdAt: new Date().toISOString()
            };

            const list = loadSchedules();
            list.push(job);
            saveSchedules(list);
            scheduleJob(client, job);
            sessions.delete(message.author.id);

            await message.delete().catch(() => { });

            // ── Embed tổng kết ──
            const start = new Date(job.startAt);
            const end = new Date(job.endAt);
            const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
            const timeStr = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;

            const summaryEmbed = new EmbedBuilder()
                .setColor(0x57F287)
                .setAuthor({ name: '✅ Lên lịch thành công!' })
                .setTitle('📅 Thông tin lịch gửi tin nhắn')
                .addFields(
                    { name: '🆔 ID', value: `\`${job.id}\``, inline: true },
                    { name: '📢 Channel', value: `<#${job.channelId}>`, inline: true },
                    { name: '⏰ Giờ gửi', value: `\`${timeStr}\` mỗi ngày`, inline: true },
                    { name: '📅 Bắt đầu', value: fmtDate(start), inline: true },
                    { name: '🏁 Kết thúc', value: fmtDate(end), inline: true },
                    { name: '🔁 Số ngày', value: `${days} ngày`, inline: true },
                    {
                        name: '💬 Nội dung',
                        value: job.message
                            ? (job.message.length > 300 ? job.message.slice(0, 300) + '…' : job.message)
                            : '_Không có text_'
                    },
                )
                .setFooter({ text: `Tạo bởi ${message.author.username} · /schedule list để xem · /schedule cancel để huỷ` })
                .setTimestamp();

            if (job.imageUrl) summaryEmbed.setImage(job.imageUrl);

            { const m = await message.channel.send({ embeds: [summaryEmbed] }); autoDelete(m); }
            return;
        }
    });
};

module.exports.scheduleCommands = scheduleCommands;