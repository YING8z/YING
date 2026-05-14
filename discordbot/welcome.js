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
const fs = require('fs');
const https = require('https');
const http = require('http');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');

// Register Noto Sans fonts (tải về bỏ vào folder ./fonts/)
// Download: https://fonts.google.com/noto/specimen/Noto+Sans
// Cần file: NotoSans-Regular.ttf, NotoSans-Bold.ttf
try {
    GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'NotoSans-Bold.ttf'), 'NotoSans');
    GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'NotoSans-Regular.ttf'), 'NotoSans');
    console.log('[WELCOME] Fonts loaded OK');
} catch (e) {
    console.warn('[WELCOME] Font load failed:', e.message, '— chạy: node download_fonts.js');
}

// ===========================
// STORAGE
// ===========================
const WELCOME_FILE = './welcome_config.json';

const loadConfig = () => {
    try {
        if (!fs.existsSync(WELCOME_FILE)) return {};
        return JSON.parse(fs.readFileSync(WELCOME_FILE));
    } catch { return {}; }
};

const saveConfig = (data) => {
    fs.writeFileSync(WELCOME_FILE, JSON.stringify(data, null, 2));
};

// ===========================
// HELPERS
// ===========================
function hasPermission(member) {
    return member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function autoDelete(interaction, delay = 60_000) {
    setTimeout(async () => {
        try { await interaction.deleteReply(); } catch { }
    }, delay);
}

// Download buffer từ URL
function downloadBuffer(url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

// ===========================
// VẼ WELCOME CARD
// Canvas 900x320 — dark gradient + avatar tròn + text
// ===========================
async function generateWelcomeCard(member, memberCount) {
    const W = 900, H = 320;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // ── Background gradient tím đậm ──
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#0d0d1a');
    bg.addColorStop(0.5, '#1a0a2e');
    bg.addColorStop(1, '#0a0a1f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // ── Lưới chấm mờ trang trí ──
    ctx.fillStyle = 'rgba(139,92,246,0.08)';
    for (let x = 20; x < W; x += 40) {
        for (let y = 20; y < H; y += 40) {
            ctx.beginPath();
            ctx.arc(x, y, 1.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // ── Đường viền gradient bao quanh card ──
    const border = ctx.createLinearGradient(0, 0, W, H);
    border.addColorStop(0, '#8b5cf6');
    border.addColorStop(0.5, '#ec4899');
    border.addColorStop(1, '#3b82f6');
    ctx.strokeStyle = border;
    ctx.lineWidth = 2.5;
    roundRect(ctx, 4, 4, W - 8, H - 8, 18);
    ctx.stroke();

    // ── Vòng tròn phát sáng phía sau avatar ──
    const cx = 160, cy = H / 2;
    const glow = ctx.createRadialGradient(cx, cy, 50, cx, cy, 130);
    glow.addColorStop(0, 'rgba(139,92,246,0.35)');
    glow.addColorStop(1, 'rgba(139,92,246,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, 130, 0, Math.PI * 2);
    ctx.fill();

    // ── Vòng viền avatar (gradient) ──
    const avatarR = 78;
    const ringGrad = ctx.createLinearGradient(cx - avatarR, cy - avatarR, cx + avatarR, cy + avatarR);
    ringGrad.addColorStop(0, '#8b5cf6');
    ringGrad.addColorStop(0.5, '#ec4899');
    ringGrad.addColorStop(1, '#3b82f6');
    ctx.strokeStyle = ringGrad;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, avatarR + 6, 0, Math.PI * 2);
    ctx.stroke();

    // ── Avatar tròn ──
    try {
        const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true });
        const avatarBuf = await downloadBuffer(avatarUrl);
        const avatarImg = await loadImage(avatarBuf);

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, avatarR, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatarImg, cx - avatarR, cy - avatarR, avatarR * 2, avatarR * 2);
        ctx.restore();
    } catch {
        // Fallback circle nếu không load được avatar
        ctx.fillStyle = '#2d1b69';
        ctx.beginPath();
        ctx.arc(cx, cy, avatarR, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#8b5cf6';
        ctx.font = 'bold 48px NotoSans';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(stripEmoji(member.user.username)[0]?.toUpperCase() || '?', cx, cy);
    }

    // ── Separator dọc ──
    const sepX = 268;
    const sepGrad = ctx.createLinearGradient(sepX, 40, sepX, H - 40);
    sepGrad.addColorStop(0, 'rgba(139,92,246,0)');
    sepGrad.addColorStop(0.3, 'rgba(139,92,246,0.7)');
    sepGrad.addColorStop(0.7, 'rgba(236,72,153,0.7)');
    sepGrad.addColorStop(1, 'rgba(236,72,153,0)');
    ctx.strokeStyle = sepGrad;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sepX, 40);
    ctx.lineTo(sepX, H - 40);
    ctx.stroke();

    // ── Text bên phải ──
    const textX = 295;

    // "CHÀO MỪNG" badge nhỏ
    ctx.fillStyle = 'rgba(139,92,246,0.25)';
    roundRect(ctx, textX, 44, 148, 28, 14);
    ctx.fill();
    ctx.font = 'bold 12px NotoSans';
    ctx.fillStyle = '#c4b5fd';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('CHAO MUNG', textX + 22, 58);

    // Tên thành viên
    const displayName = stripEmoji(member.displayName || member.user.username);
    ctx.font = `bold ${displayName.length > 18 ? '26px' : '32px'} NotoSans`;
    const nameGrad = ctx.createLinearGradient(textX, 0, textX + 500, 0);
    nameGrad.addColorStop(0, '#e2d9f3');
    nameGrad.addColorStop(1, '#c4b5fd');
    ctx.fillStyle = nameGrad;
    ctx.textBaseline = 'top';
    ctx.fillText(displayName.length > 22 ? displayName.slice(0, 22) + '…' : displayName, textX, 86);

    // Username mờ nhỏ
    ctx.font = '14px NotoSans';
    ctx.fillStyle = 'rgba(196,181,253,0.55)';
    ctx.fillText('@' + member.user.username, textX, 128);

    // Divider nhỏ
    ctx.strokeStyle = 'rgba(139,92,246,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(textX, 152);
    ctx.lineTo(textX + 420, 152);
    ctx.stroke();

    // Số thành viên
    ctx.font = 'bold 15px NotoSans';
    ctx.fillStyle = '#f0abfc';
    ctx.fillText(`Thanh vien thu #${memberCount}`, textX, 166);

    // Server name
    const guildName = stripEmoji(member.guild.name);
    ctx.font = '13px NotoSans';
    ctx.fillStyle = 'rgba(226,217,243,0.7)';
    ctx.fillText(guildName.length > 32 ? guildName.slice(0, 32) + '...' : guildName, textX, 193);

    // Divider
    ctx.strokeStyle = 'rgba(139,92,246,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(textX, 218);
    ctx.lineTo(textX + 420, 218);
    ctx.stroke();

    // Hint nhỏ
    ctx.font = '12px NotoSans';
    ctx.fillStyle = 'rgba(196,181,253,0.45)';
    ctx.fillText('Doc luat  •  Chat cung moi nguoi  •  Chuc vui ve!', textX, 232);

    // Dots trang trí góc phải
    const dotColors = ['#8b5cf6', '#ec4899', '#3b82f6'];
    dotColors.forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(W - 30 - i * 18, H - 28, 5, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.globalAlpha = 1;

    return canvas.toBuffer('image/png');
}


// Strip emoji khỏi string để vẽ trên canvas không bị ô vuông
function stripEmoji(str) {
    return str
        .replace(/[🌀-🿿]/gu, '')   // emoji range
        .replace(/[☀-⛿]/gu, '')       // misc symbols
        .replace(/[✀-➿]/gu, '')       // dingbats
        .replace(/[︀-️]/gu, '')           // variation selectors
        .replace(/‍/gu, '')                    // zero width joiner
        .replace(/s{2,}/g, ' ')                   // collapse spaces
        .trim();
}

// Helper vẽ rectangle bo góc
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ===========================
// BUILD WELCOME EMBED
// ===========================
function buildWelcomeEmbed(member, memberCount, config, cardAttachmentName) {
    const rulesRef = config.rulesChannelId ? `<#${config.rulesChannelId}>` : '`#rules`';
    const chatRef = config.chatChannelId ? `<#${config.chatChannelId}>` : '`#general`';
    const supportRef = config.supportChannelId ? `<#${config.supportChannelId}>` : '`#support`';
    const guildName = member.guild.name;

    const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setDescription([
            `## 👋 Chào mừng ${member} đến với **${guildName}**!`,
            ``,
            `━━━━━━━━━━━━━━━━━━━`,
            `🎊 Bạn là thành viên thứ **#${memberCount}**`,
            `━━━━━━━━━━━━━━━━━━━`,
            ``,
            `**📌 Bắt đầu ngay:**`,
            `> 📜 Đọc luật tại ➤ ${rulesRef}`,
            `> 💬 Chat cùng mọi người ➤ ${chatRef}`,
            ``,
            `**⚠️ Lưu ý:**`,
            `> • Không spam / toxic`,
            `> • Tôn trọng mọi người`,
            `> • Vi phạm sẽ bị xử lý ngay`,
            ``,
            `━━━━━━━━━━━━━━━━━━━`,
            `✨ Chúc bạn trải nghiệm vui vẻ & leo rank cực nhanh!`,
            `🆘 Cần hỗ trợ ➤ ${supportRef}`,
            `━━━━━━━━━━━━━━━━━━━`,
        ].join('\n'))
        .setThumbnail(member.user.displayAvatarURL({ size: 256, dynamic: true }))
        .setImage(`attachment://${cardAttachmentName}`)
        .setFooter({
            text: `${guildName} · Tham gia lúc`,
            iconURL: member.guild.iconURL({ dynamic: true }) || undefined
        })
        .setTimestamp();

    return embed;
}

// ===========================
// BUILD DM EMBED
// ===========================
function buildDmEmbed(member, memberCount, config, cardAttachmentName) {
    const guildName = member.guild.name;
    const rulesRef = config.rulesChannelId ? `<#${config.rulesChannelId}>` : '`#rules`';
    const chatRef = config.chatChannelId ? `<#${config.chatChannelId}>` : '`#general`';
    const supportRef = config.supportChannelId ? `<#${config.supportChannelId}>` : '`#support`';

    const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setAuthor({
            name: `Chào mừng đến với ${guildName}!`,
            iconURL: member.guild.iconURL({ dynamic: true }) || undefined
        })
        .setDescription([
            `## Hey ${member.user.username}! 👋`,
            ``,
            `Mình là bot của **${guildName}**, rất vui được gặp bạn!`,
            `Bạn là thành viên thứ **#${memberCount}** — không tệ đâu nhé 😄`,
            ``,
            `**Để bắt đầu:**`,
            `> 📜 Đọc luật ➤ ${rulesRef}`,
            `> 💬 Chat ➤ ${chatRef}`,
            `> 🆘 Hỗ trợ ➤ ${supportRef}`,
            ``,
            `Chúc bạn có trải nghiệm thật vui vẻ! 🎉`,
        ].join('\n'))
        .setFooter({ text: 'Tin nhắn tự động từ bot · Đừng reply vào đây nhé' })
        .setTimestamp();

    if (cardAttachmentName) {
        embed.setImage(`attachment://${cardAttachmentName}`);
    }

    return embed;
}

// ===========================
// SLASH COMMANDS
// ===========================
const welcomeCommands = [
    new SlashCommandBuilder()
        .setName('welcome')
        .setDescription('🎉 Cấu hình tin nhắn chào mừng thành viên mới')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub => sub
            .setName('setup')
            .setDescription('Thiết lập welcome: chọn channel thông báo & các channel liên kết')
            .addChannelOption(o => o
                .setName('welcome_channel')
                .setDescription('Channel gửi tin nhắn chào mừng')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true))
            .addChannelOption(o => o
                .setName('rules_channel')
                .setDescription('Channel luật (hiện trong embed)')
                .addChannelTypes(ChannelType.GuildText))
            .addChannelOption(o => o
                .setName('chat_channel')
                .setDescription('Channel chat chính (hiện trong embed)')
                .addChannelTypes(ChannelType.GuildText))
            .addChannelOption(o => o
                .setName('support_channel')
                .setDescription('Channel hỗ trợ (hiện trong embed)')
                .addChannelTypes(ChannelType.GuildText))
            .addBooleanOption(o => o
                .setName('send_dm')
                .setDescription('Gửi DM riêng cho thành viên mới? (mặc định: bật)'))
        )
        .addSubcommand(sub => sub
            .setName('test')
            .setDescription('Thử gửi welcome card với tài khoản của bạn'))
        .addSubcommand(sub => sub
            .setName('disable')
            .setDescription('Tắt tính năng welcome'))
        .addSubcommand(sub => sub
            .setName('status')
            .setDescription('Xem cấu hình welcome hiện tại'))
].map(c => c.toJSON());

// ===========================
// MODULE CHÍNH
// ===========================
module.exports = (client) => {

    // ── guildMemberAdd ─────────────────────────────────────────
    client.on('guildMemberAdd', async (member) => {
        if (member.user.bot) return;

        const configs = loadConfig();
        const config = configs[member.guild.id];
        if (!config || !config.enabled || !config.welcomeChannelId) return;

        const channel = member.guild.channels.cache.get(config.welcomeChannelId);
        if (!channel) return;

        const memberCount = member.guild.memberCount;

        try {
            // Vẽ card
            const cardBuf = await generateWelcomeCard(member, memberCount);
            const cardName = `welcome_${member.id}.png`;
            const attachment = new AttachmentBuilder(cardBuf, { name: cardName });

            // Embed chính
            const embed = buildWelcomeEmbed(member, memberCount, config, cardName);

            // Gửi vào channel
            await channel.send({
                content: `> 🎊 ${member} vừa đặt chân vào server!`,
                embeds: [embed],
                files: [attachment]
            });

            // Gửi DM nếu bật
            if (config.sendDm !== false) {
                try {
                    const dmCardName = `welcome_dm_${member.id}.png`;
                    const dmAttachment = new AttachmentBuilder(cardBuf, { name: dmCardName });
                    const dmEmbed = buildDmEmbed(member, memberCount, config, dmCardName);
                    await member.send({ embeds: [dmEmbed], files: [dmAttachment] });
                } catch {
                    // DM có thể bị tắt — bỏ qua
                    console.log(`[WELCOME] Không gửi được DM cho ${member.user.username} (DM bị tắt)`);
                }
            }

            console.log(`[WELCOME] Đã chào mừng ${member.user.username} (#${memberCount}) trong #${channel.name}`);

        } catch (err) {
            console.error('[WELCOME] Lỗi gửi welcome:', err.message);
        }
    });

    // ── interactionCreate ──────────────────────────────────────
    client.on('interactionCreate', async interaction => {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== 'welcome') return;

        if (!hasPermission(interaction.member)) {
            return interaction.reply({
                content: '❌ Bạn cần quyền **Manage Server** hoặc **Administrator**.',
                flags: MessageFlags.Ephemeral
            });
        }

        const sub = interaction.options.getSubcommand();
        const configs = loadConfig();
        const gid = interaction.guild.id;

        // ──── SETUP ──────────────────────────────────────────────
        if (sub === 'setup') {
            const welcomeChannel = interaction.options.getChannel('welcome_channel');
            const rulesChannel = interaction.options.getChannel('rules_channel');
            const chatChannel = interaction.options.getChannel('chat_channel');
            const supportChannel = interaction.options.getChannel('support_channel');
            const sendDm = interaction.options.getBoolean('send_dm') ?? true;

            configs[gid] = {
                enabled: true,
                welcomeChannelId: welcomeChannel.id,
                rulesChannelId: rulesChannel?.id || null,
                chatChannelId: chatChannel?.id || null,
                supportChannelId: supportChannel?.id || null,
                sendDm,
                updatedBy: interaction.user.id,
                updatedAt: new Date().toISOString()
            };
            saveConfig(configs);

            const embed = new EmbedBuilder()
                .setColor(0x57F287)
                .setAuthor({ name: '✅ Welcome đã được thiết lập!' })
                .setDescription('Bot sẽ tự động chào mừng thành viên mới.')
                .addFields(
                    { name: '📢 Welcome channel', value: `<#${welcomeChannel.id}>`, inline: true },
                    { name: '📜 Rules channel', value: rulesChannel ? `<#${rulesChannel.id}>` : '_Chưa đặt_', inline: true },
                    { name: '💬 Chat channel', value: chatChannel ? `<#${chatChannel.id}>` : '_Chưa đặt_', inline: true },
                    { name: '🆘 Support channel', value: supportChannel ? `<#${supportChannel.id}>` : '_Chưa đặt_', inline: true },
                    { name: '📩 Gửi DM', value: sendDm ? '✅ Bật' : '❌ Tắt', inline: true },
                )
                .setFooter({ text: `Dùng /welcome test để thử • /welcome disable để tắt` })
                .setTimestamp();

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            autoDelete(interaction);
            return;
        }

        // ──── TEST ───────────────────────────────────────────────
        if (sub === 'test') {
            const config = configs[gid];
            if (!config || !config.enabled) {
                return interaction.reply({
                    content: '❌ Chưa setup welcome. Dùng `/welcome setup` trước nhé.',
                    flags: MessageFlags.Ephemeral
                });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            try {
                const member = interaction.member;
                const memberCount = interaction.guild.memberCount;

                const cardBuf = await generateWelcomeCard(member, memberCount);
                const cardName = `welcome_test_${member.id}.png`;
                const attachment = new AttachmentBuilder(cardBuf, { name: cardName });
                const embed = buildWelcomeEmbed(member, memberCount, config, cardName);

                await interaction.editReply({
                    content: '✅ Preview welcome card:',
                    embeds: [embed],
                    files: [attachment]
                });
                autoDelete(interaction, 90_000); // 90s cho test vì cần xem kỹ

            } catch (err) {
                console.error('[WELCOME test] Lỗi:', err);
                await interaction.editReply({ content: `❌ Lỗi tạo card: ${err.message}` });
            }
            return;
        }

        // ──── DISABLE ────────────────────────────────────────────
        if (sub === 'disable') {
            if (!configs[gid]) {
                return interaction.reply({
                    content: '⚠️ Welcome chưa được bật.',
                    flags: MessageFlags.Ephemeral
                });
            }
            configs[gid].enabled = false;
            saveConfig(configs);

            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0xED4245)
                    .setDescription('🔕 Đã tắt tính năng welcome. Dùng `/welcome setup` để bật lại.')],
                flags: MessageFlags.Ephemeral
            });
            autoDelete(interaction);
            return;
        }

        // ──── STATUS ─────────────────────────────────────────────
        if (sub === 'status') {
            const config = configs[gid];
            if (!config) {
                return interaction.reply({
                    content: '📭 Chưa cấu hình welcome. Dùng `/welcome setup` để thiết lập.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const embed = new EmbedBuilder()
                .setColor(config.enabled ? 0x57F287 : 0xED4245)
                .setTitle('📋 Trạng thái Welcome')
                .addFields(
                    { name: '🔘 Trạng thái', value: config.enabled ? '✅ Đang bật' : '❌ Đã tắt', inline: true },
                    { name: '📢 Welcome channel', value: config.welcomeChannelId ? `<#${config.welcomeChannelId}>` : '_Chưa đặt_', inline: true },
                    { name: '📜 Rules', value: config.rulesChannelId ? `<#${config.rulesChannelId}>` : '_Chưa đặt_', inline: true },
                    { name: '💬 Chat', value: config.chatChannelId ? `<#${config.chatChannelId}>` : '_Chưa đặt_', inline: true },
                    { name: '🆘 Support', value: config.supportChannelId ? `<#${config.supportChannelId}>` : '_Chưa đặt_', inline: true },
                    { name: '📩 Gửi DM', value: config.sendDm !== false ? '✅ Bật' : '❌ Tắt', inline: true },
                )
                .setFooter({ text: `Cập nhật lần cuối bởi user ID: ${config.updatedBy || 'N/A'}` })
                .setTimestamp(config.updatedAt ? new Date(config.updatedAt) : null);

            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
    });
};

module.exports.welcomeCommands = welcomeCommands;