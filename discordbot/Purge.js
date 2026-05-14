const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    PermissionFlagsBits,
    SlashCommandBuilder,
    ChannelType,
    MessageFlags,
    ComponentType
} = require('discord.js');

// ===========================
// HELPERS
// ===========================
function hasPermission(member) {
    return member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.permissions.has(PermissionFlagsBits.ManageMessages);
}

function fmtTime(date) {
    return date.toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        dateStyle: 'short',
        timeStyle: 'short'
    });
}

function truncate(str, max = 60) {
    if (!str) return '_[không có text]_';
    return str.length > max ? str.slice(0, max) + '…' : str;
}

// Discord chỉ bulk delete được tin nhắn < 14 ngày
// ===========================
// AUTO-DELETE HELPER
// ===========================
async function autoDelete(interaction, delay = 60_000) {
    setTimeout(async () => {
        try { await interaction.deleteReply(); } catch { /* đã xóa hoặc không có quyền */ }
    }, delay);
}

const BULK_LIMIT_MS = 14 * 24 * 60 * 60 * 1000;

// ===========================
// SLASH COMMANDS EXPORT
// ===========================
const purgeCommands = [
    new SlashCommandBuilder()
        .setName('purge')
        .setDescription('🗑 Xóa tin nhắn của một thành viên hoặc app/bot trong channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addSubcommand(sub => sub
            .setName('quick')
            .setDescription('Xóa nhanh N tin nhắn mới nhất của thành viên hoặc bot/app')
            .addIntegerOption(o => o
                .setName('amount')
                .setDescription('Số lượng tin nhắn muốn xóa (1–500)')
                .setMinValue(1)
                .setMaxValue(500)
                .setRequired(true))
            .addUserOption(o => o
                .setName('member')
                .setDescription('Chọn thành viên (người) muốn xóa tin nhắn'))
            .addStringOption(o => o
                .setName('app_id')
                .setDescription('Nhập User ID của bot/app (dùng khi không chọn được qua member)'))
            .addChannelOption(o => o
                .setName('channel')
                .setDescription('Channel muốn xóa (mặc định: channel hiện tại)')
                .addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(sub => sub
            .setName('select')
            .setDescription('Xem và chọn từng tin nhắn muốn xóa (phân trang 25 tin/trang)')
            .addUserOption(o => o
                .setName('member')
                .setDescription('Chọn thành viên (người) muốn xem tin nhắn'))
            .addStringOption(o => o
                .setName('app_id')
                .setDescription('Nhập User ID của bot/app (dùng khi không chọn được qua member)'))
            .addChannelOption(o => o
                .setName('channel')
                .setDescription('Channel muốn xem (mặc định: channel hiện tại)')
                .addChannelTypes(ChannelType.GuildText)))
].map(c => c.toJSON());

// ===========================
// FETCH TIN NHẮN CỦA USER
// Fetch tối đa `limit` tin nhắn của user trong channel
// ===========================
async function fetchUserMessages(channel, userId, limit = 500) {
    const result = [];
    let lastId = null;

    while (result.length < limit) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const batch = await channel.messages.fetch(options);
        if (batch.size === 0) break;

        for (const msg of batch.values()) {
            if (msg.author.id === userId) {
                result.push(msg);
                if (result.length >= limit) break;
            }
        }

        lastId = batch.last()?.id;
        if (batch.size < 100) break;
    }

    // Sắp xếp mới nhất trước (batch đã có thứ tự, nhưng đảm bảo chắc)
    result.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    return result;
}

// ===========================
// SESSION LƯU TRẠNG THÁI CHỌN TIN NHẮN
// ===========================
const selectSessions = new Map();
// key: userId, value: { messages, selected: Set<msgId>, page, channelId, targetUser, interactionId, lastInteraction }

// ===========================
// BUILD EMBED TRANG
// ===========================
function buildPageEmbed(session, page) {
    const { messages, selected, targetUser } = session;
    const PAGE_SIZE = 25;
    const totalPages = Math.ceil(messages.length / PAGE_SIZE);
    const start = page * PAGE_SIZE;
    const pageMessages = messages.slice(start, start + PAGE_SIZE);

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setAuthor({
            name: `🗑 Chọn tin nhắn để xóa · ${targetUser.username}`,
            iconURL: targetUser.displayAvatarURL()
        })
        .setDescription([
            `📋 Tổng: **${messages.length}** tin nhắn · Trang **${page + 1}/${totalPages}**`,
            `✅ Đã chọn: **${selected.size}** tin nhắn`,
            '',
            '> Dùng menu bên dưới để **chọn/bỏ chọn** tin nhắn.',
            '> Bấm **🗑 Xóa đã chọn** để xóa, hoặc **❌ Huỷ** để thoát.'
        ].join('\n'))
        .setTimestamp();

    // Hiển thị danh sách tin nhắn trang hiện tại
    const lines = pageMessages.map((msg, idx) => {
        const num = start + idx + 1;
        const check = selected.has(msg.id) ? '✅' : '⬜';
        const time = fmtTime(msg.createdAt);
        const content = truncate(msg.content || (msg.attachments.size ? '[File/Ảnh]' : '[Embed]'), 55);
        return `${check} \`${num}.\` **${time}** — ${content}`;
    });

    embed.addFields({
        name: `📄 Trang ${page + 1} (tin ${start + 1}–${Math.min(start + PAGE_SIZE, messages.length)})`,
        value: lines.join('\n') || '_Không có tin nhắn_'
    });

    return embed;
}

// ===========================
// BUILD SELECT MENU
// ===========================
function buildSelectMenu(session, page) {
    const { messages, selected } = session;
    const PAGE_SIZE = 25;
    const start = page * PAGE_SIZE;
    const pageMessages = messages.slice(start, start + PAGE_SIZE);

    const options = pageMessages.map((msg, idx) => {
        const num = start + idx + 1;
        const time = fmtTime(msg.createdAt);
        const content = truncate(msg.content || (msg.attachments.size ? '[File/Ảnh]' : '[Embed]'), 50);
        const isSelected = selected.has(msg.id);
        return {
            label: `${isSelected ? '✅ ' : ''}${num}. ${content}`.slice(0, 100),
            description: time.slice(0, 50),
            value: msg.id,
            default: isSelected
        };
    });

    return new StringSelectMenuBuilder()
        .setCustomId('purge_select_msgs')
        .setPlaceholder('Chọn tin nhắn muốn xóa (có thể chọn nhiều)...')
        .setMinValues(0)
        .setMaxValues(options.length)
        .addOptions(options);
}

// ===========================
// BUILD NAVIGATION BUTTONS
// ===========================
function buildNavButtons(session, page) {
    const PAGE_SIZE = 25;
    const totalPages = Math.ceil(session.messages.length / PAGE_SIZE);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('purge_prev')
            .setLabel('◀ Trang trước')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
        new ButtonBuilder()
            .setCustomId('purge_next')
            .setLabel('Trang sau ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages - 1),
        new ButtonBuilder()
            .setCustomId('purge_select_all_page')
            .setLabel('✅ Chọn tất cả trang này')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('purge_deselect_all_page')
            .setLabel('⬜ Bỏ chọn trang này')
            .setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('purge_confirm')
            .setLabel(`🗑 Xóa ${session.selected.size} tin nhắn đã chọn`)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(session.selected.size === 0),
        new ButtonBuilder()
            .setCustomId('purge_select_all')
            .setLabel('☑️ Chọn TẤT CẢ')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('purge_cancel')
            .setLabel('❌ Huỷ')
            .setStyle(ButtonStyle.Secondary)
    );

    return [row1, row2];
}

// ===========================
// MODULE CHÍNH
// ===========================
module.exports = (client) => {

    client.on('interactionCreate', async interaction => {

        // ── /purge quick ─────────────────────────────────────────
        if (interaction.isChatInputCommand() && interaction.commandName === 'purge') {

            if (!hasPermission(interaction.member)) {
                return interaction.reply({
                    content: '❌ Bạn cần quyền **Manage Messages** hoặc **Administrator**.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const sub = interaction.options.getSubcommand();
            const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

            // Resolve targetUser: member picker hoac app_id string
            let targetUser = interaction.options.getUser('member') || null;
            const appId = (interaction.options.getString('app_id') || '').trim() || null;

            if (!targetUser && appId) {
                try {
                    targetUser = await interaction.client.users.fetch(appId);
                } catch {
                    return interaction.reply({
                        content: `❌ Không tìm thấy user/app với ID \`${appId}\`. Kiểm tra lại ID nhé.`,
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            if (!targetUser) {
                return interaction.reply({
                    content: '❌ Cần chọn **member** hoặc nhập **app_id** của bot/app.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const targetLabel = targetUser.bot
                ? `🤖 ${targetUser.username} (bot/app)`
                : `👤 ${targetUser.username}`;

            // ──── QUICK ────────────────────────────────────────────
            if (sub === 'quick') {
                const amount = interaction.options.getInteger('amount');

                await interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setColor(0xFEE75C)
                        .setDescription(`🔍 Đang tìm **${amount}** tin nhắn của **${targetLabel}** trong <#${targetChannel.id}>...`)],
                    flags: MessageFlags.Ephemeral
                });

                try {
                    const userMsgs = await fetchUserMessages(targetChannel, targetUser.id, amount);

                    if (userMsgs.length === 0) {
                        return interaction.editReply({
                            embeds: [new EmbedBuilder()
                                .setColor(0xFEE75C)
                                .setDescription(`📭 Không tìm thấy tin nhắn nào của **${targetLabel}** trong <#${targetChannel.id}>.`)]
                        });
                    }

                    const now = Date.now();
                    const bulkable = userMsgs.filter(m => now - m.createdTimestamp < BULK_LIMIT_MS);
                    const old = userMsgs.filter(m => now - m.createdTimestamp >= BULK_LIMIT_MS);

                    let deleted = 0;
                    let failedOld = 0;

                    // Xóa tin nhắn < 14 ngày bằng bulkDelete (nhanh)
                    if (bulkable.length > 0) {
                        const chunks = [];
                        for (let i = 0; i < bulkable.length; i += 100) {
                            chunks.push(bulkable.slice(i, i + 100));
                        }
                        for (const chunk of chunks) {
                            try {
                                const ids = chunk.map(m => m.id);
                                await targetChannel.bulkDelete(ids, true);
                                deleted += chunk.length;
                            } catch (e) {
                                console.error('[PURGE] bulkDelete lỗi:', e.message);
                            }
                        }
                    }

                    // Xóa tin nhắn cũ > 14 ngày từng cái một (chậm)
                    if (old.length > 0) {
                        for (const msg of old) {
                            try {
                                await msg.delete();
                                deleted++;
                                // Rate limit phòng tránh
                                await new Promise(r => setTimeout(r, 300));
                            } catch {
                                failedOld++;
                            }
                        }
                    }

                    const lines = [
                        `✅ Đã xóa **${deleted}** tin nhắn của **${targetUser.username}** trong <#${targetChannel.id}>.`,
                    ];
                    if (failedOld > 0) lines.push(`⚠️ **${failedOld}** tin nhắn quá cũ hoặc đã bị xóa không thể xóa được.`);
                    if (deleted < userMsgs.length) lines.push(`ℹ️ Tìm được ${userMsgs.length} tin, xóa được ${deleted}.`);

                    await interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setColor(0x57F287)
                            .setDescription(lines.join('\n'))
                            .setTimestamp()]
                    });
                    autoDelete(interaction);
                    return;

                } catch (err) {
                    console.error('[PURGE quick] Lỗi:', err);
                    return interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setColor(0xED4245)
                            .setDescription(`❌ Lỗi: ${err.message}`)]
                    });
                }
            }

            // ──── SELECT ────────────────────────────────────────────
            if (sub === 'select') {

                await interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setColor(0xFEE75C)
                        .setDescription(`🔍 Đang tải tin nhắn của **${targetLabel}** trong <#${targetChannel.id}>...`)],
                    flags: MessageFlags.Ephemeral
                });

                try {
                    const userMsgs = await fetchUserMessages(targetChannel, targetUser.id, 500);

                    if (userMsgs.length === 0) {
                        return interaction.editReply({
                            embeds: [new EmbedBuilder()
                                .setColor(0xFEE75C)
                                .setDescription(`📭 Không tìm thấy tin nhắn nào của **${targetLabel}** trong <#${targetChannel.id}>.`)]
                        });
                    }

                    const session = {
                        messages: userMsgs,
                        selected: new Set(),
                        page: 0,
                        channelId: targetChannel.id,
                        targetUser,
                        userId: interaction.user.id
                    };

                    selectSessions.set(interaction.user.id, session);

                    const embed = buildPageEmbed(session, 0);
                    const selectMenu = new ActionRowBuilder().addComponents(buildSelectMenu(session, 0));
                    const navRows = buildNavButtons(session, 0);

                    await interaction.editReply({
                        embeds: [embed],
                        components: [selectMenu, ...navRows]
                    });

                    // Tự hủy session sau 10 phút không dùng
                    session._timeout = setTimeout(() => {
                        selectSessions.delete(interaction.user.id);
                    }, 10 * 60 * 1000);

                } catch (err) {
                    console.error('[PURGE select] Lỗi:', err);
                    return interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setColor(0xED4245)
                            .setDescription(`❌ Lỗi: ${err.message}`)]
                    });
                }
            }
        }

        // ── XỬ LÝ SELECT MENU CHỌN TIN NHẮN ──────────────────────
        if (interaction.isStringSelectMenu() && interaction.customId === 'purge_select_msgs') {
            const session = selectSessions.get(interaction.user.id);
            if (!session) return interaction.reply({ content: '❌ Session đã hết hạn, chạy lại `/purge select`.', flags: MessageFlags.Ephemeral });

            const PAGE_SIZE = 25;
            const start = session.page * PAGE_SIZE;
            const pageMessages = session.messages.slice(start, start + PAGE_SIZE);
            const pageIds = new Set(pageMessages.map(m => m.id));

            // Bỏ chọn tất cả tin trong trang này trước
            for (const id of pageIds) session.selected.delete(id);
            // Thêm lại những cái được chọn
            for (const id of interaction.values) session.selected.add(id);

            // Reset timeout
            clearTimeout(session._timeout);
            session._timeout = setTimeout(() => selectSessions.delete(interaction.user.id), 10 * 60 * 1000);

            const embed = buildPageEmbed(session, session.page);
            const selectMenu = new ActionRowBuilder().addComponents(buildSelectMenu(session, session.page));
            const navRows = buildNavButtons(session, session.page);

            await interaction.update({ embeds: [embed], components: [selectMenu, ...navRows] });
        }

        // ── XỬ LÝ BUTTONS ─────────────────────────────────────────
        if (interaction.isButton()) {
            const session = selectSessions.get(interaction.user.id);

            // ── Điều hướng trang ──
            if (interaction.customId === 'purge_prev' || interaction.customId === 'purge_next') {
                if (!session) return interaction.reply({ content: '❌ Session đã hết hạn.', flags: MessageFlags.Ephemeral });

                if (interaction.customId === 'purge_prev') session.page = Math.max(0, session.page - 1);
                else {
                    const totalPages = Math.ceil(session.messages.length / 25);
                    session.page = Math.min(totalPages - 1, session.page + 1);
                }

                clearTimeout(session._timeout);
                session._timeout = setTimeout(() => selectSessions.delete(interaction.user.id), 10 * 60 * 1000);

                const embed = buildPageEmbed(session, session.page);
                const selectMenu = new ActionRowBuilder().addComponents(buildSelectMenu(session, session.page));
                const navRows = buildNavButtons(session, session.page);
                await interaction.update({ embeds: [embed], components: [selectMenu, ...navRows] });
            }

            // ── Chọn tất cả trang này ──
            if (interaction.customId === 'purge_select_all_page') {
                if (!session) return interaction.reply({ content: '❌ Session đã hết hạn.', flags: MessageFlags.Ephemeral });

                const PAGE_SIZE = 25;
                const start = session.page * PAGE_SIZE;
                const pageMessages = session.messages.slice(start, start + PAGE_SIZE);
                for (const msg of pageMessages) session.selected.add(msg.id);

                clearTimeout(session._timeout);
                session._timeout = setTimeout(() => selectSessions.delete(interaction.user.id), 10 * 60 * 1000);

                const embed = buildPageEmbed(session, session.page);
                const selectMenu = new ActionRowBuilder().addComponents(buildSelectMenu(session, session.page));
                const navRows = buildNavButtons(session, session.page);
                await interaction.update({ embeds: [embed], components: [selectMenu, ...navRows] });
            }

            // ── Bỏ chọn tất cả trang này ──
            if (interaction.customId === 'purge_deselect_all_page') {
                if (!session) return interaction.reply({ content: '❌ Session đã hết hạn.', flags: MessageFlags.Ephemeral });

                const PAGE_SIZE = 25;
                const start = session.page * PAGE_SIZE;
                const pageMessages = session.messages.slice(start, start + PAGE_SIZE);
                for (const msg of pageMessages) session.selected.delete(msg.id);

                clearTimeout(session._timeout);
                session._timeout = setTimeout(() => selectSessions.delete(interaction.user.id), 10 * 60 * 1000);

                const embed = buildPageEmbed(session, session.page);
                const selectMenu = new ActionRowBuilder().addComponents(buildSelectMenu(session, session.page));
                const navRows = buildNavButtons(session, session.page);
                await interaction.update({ embeds: [embed], components: [selectMenu, ...navRows] });
            }

            // ── Chọn TẤT CẢ tin nhắn ──
            if (interaction.customId === 'purge_select_all') {
                if (!session) return interaction.reply({ content: '❌ Session đã hết hạn.', flags: MessageFlags.Ephemeral });

                for (const msg of session.messages) session.selected.add(msg.id);

                clearTimeout(session._timeout);
                session._timeout = setTimeout(() => selectSessions.delete(interaction.user.id), 10 * 60 * 1000);

                const embed = buildPageEmbed(session, session.page);
                const selectMenu = new ActionRowBuilder().addComponents(buildSelectMenu(session, session.page));
                const navRows = buildNavButtons(session, session.page);
                await interaction.update({ embeds: [embed], components: [selectMenu, ...navRows] });
            }

            // ── Huỷ ──
            if (interaction.customId === 'purge_cancel') {
                if (session) {
                    clearTimeout(session._timeout);
                    selectSessions.delete(interaction.user.id);
                }
                await interaction.update({
                    embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('❌ Đã huỷ thao tác xóa.')],
                    components: []
                });
            }

            // ── XÁC NHẬN XÓA ──
            if (interaction.customId === 'purge_confirm') {
                if (!session) return interaction.reply({ content: '❌ Session đã hết hạn.', flags: MessageFlags.Ephemeral });
                if (!hasPermission(interaction.member)) return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });

                if (session.selected.size === 0) {
                    return interaction.reply({ content: '⚠️ Chưa chọn tin nhắn nào!', flags: MessageFlags.Ephemeral });
                }

                await interaction.update({
                    embeds: [new EmbedBuilder()
                        .setColor(0xFEE75C)
                        .setDescription(`⏳ Đang xóa **${session.selected.size}** tin nhắn...`)],
                    components: []
                });

                try {
                    const channel = interaction.guild.channels.cache.get(session.channelId);
                    if (!channel) throw new Error('Không tìm thấy channel');

                    const selectedIds = [...session.selected];
                    const now = Date.now();

                    // Phân loại tin nhắn bulk vs cũ
                    const msgMap = new Map(session.messages.map(m => [m.id, m]));
                    const bulkable = selectedIds.filter(id => {
                        const m = msgMap.get(id);
                        return m && (now - m.createdTimestamp < BULK_LIMIT_MS);
                    });
                    const old = selectedIds.filter(id => {
                        const m = msgMap.get(id);
                        return m && (now - m.createdTimestamp >= BULK_LIMIT_MS);
                    });

                    let deleted = 0;
                    let failed = 0;

                    // Bulk delete (< 14 ngày), tối đa 100 cái/lần
                    for (let i = 0; i < bulkable.length; i += 100) {
                        const chunk = bulkable.slice(i, i + 100);
                        try {
                            await channel.bulkDelete(chunk, true);
                            deleted += chunk.length;
                        } catch (e) {
                            console.error('[PURGE confirm bulkDelete]', e.message);
                            // Fallback xóa từng cái
                            for (const id of chunk) {
                                try {
                                    const msg = await channel.messages.fetch(id).catch(() => null);
                                    if (msg) { await msg.delete(); deleted++; }
                                } catch { failed++; }
                                await new Promise(r => setTimeout(r, 200));
                            }
                        }
                    }

                    // Xóa từng cái (> 14 ngày)
                    for (const id of old) {
                        try {
                            const msg = await channel.messages.fetch(id).catch(() => null);
                            if (msg) { await msg.delete(); deleted++; }
                            else failed++;
                        } catch { failed++; }
                        await new Promise(r => setTimeout(r, 300));
                    }

                    clearTimeout(session._timeout);
                    selectSessions.delete(interaction.user.id);

                    const lines = [`✅ Đã xóa **${deleted}** tin nhắn của **${session.targetUser.username}**.`];
                    if (failed > 0) lines.push(`⚠️ **${failed}** tin nhắn không thể xóa (đã bị xóa hoặc lỗi).`);

                    await interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setColor(0x57F287)
                            .setDescription(lines.join('\n'))
                            .setTimestamp()],
                        components: []
                    });
                    autoDelete(interaction);

                } catch (err) {
                    console.error('[PURGE confirm] Lỗi:', err);
                    await interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setColor(0xED4245)
                            .setDescription(`❌ Lỗi khi xóa: ${err.message}`)],
                        components: []
                    });
                }
            }
        }
    });
};

module.exports.purgeCommands = purgeCommands;