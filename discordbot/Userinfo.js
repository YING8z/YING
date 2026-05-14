// userinfo.js — Xem thông tin chi tiết người dùng Discord
// Dùng: require('./userinfo')(client)
// Đăng ký: const { userinfoCommands } = require('./userinfo')

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// ───────── Helpers ─────────

const BADGE_EMOJI = {
    ActiveDeveloper: '🟢 Active Developer',
    BugHunterLevel1: '🐛 Bug Hunter Lv1',
    BugHunterLevel2: '🐛 Bug Hunter Lv2',
    CertifiedModerator: '🛡️ Discord Moderator',
    HypeSquadOnlineHouse1: '🏠 HypeSquad Bravery',
    HypeSquadOnlineHouse2: '🏠 HypeSquad Brilliance',
    HypeSquadOnlineHouse3: '🏠 HypeSquad Balance',
    Hypesquad: '📣 HypeSquad Events',
    Partner: '🤝 Discord Partner',
    PremiumEarlySupporter: '🌟 Early Supporter',
    Staff: '⚙️ Discord Staff',
    VerifiedBotDeveloper: '✅ Verified Bot Dev',
    Quarantined: '🔒 Quarantined',
};

const BOT_TYPE = {
    ApplicationCommandInteraction: 'Slash Bot',
};

/** ms → "X ngày Y giờ Z phút" */
function msToDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    const parts = [];
    if (d) parts.push(`${d} ngày`);
    if (h % 24) parts.push(`${h % 24} giờ`);
    if (m % 60) parts.push(`${m % 60} phút`);
    return parts.length ? parts.join(' ') : 'vừa xong';
}

/** timestamp → "DD/MM/YYYY HH:MM:SS" */
function fmtDate(d) {
    if (!d) return 'N/A';
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Lấy màu dominant của member (highest role color) */
function roleColor(member) {
    if (!member) return 0x5865F2;
    const color = member.displayColor;
    return color === 0 ? 0x5865F2 : color;
}

/** Build embed chính */
function buildEmbed(user, member, guild) {
    const createdAt = user.createdAt;
    const joinedAt = member?.joinedAt ?? null;
    const accountAge = msToDuration(Date.now() - createdAt.getTime());
    const memberAge = joinedAt ? msToDuration(Date.now() - joinedAt.getTime()) : null;

    // Avatar
    const avatarURL = user.displayAvatarURL({ size: 4096, dynamic: true, extension: 'png' });

    // Badges
    const flags = user.flags?.toArray() ?? [];
    const badges = flags.map(f => BADGE_EMOJI[f] ?? `\`${f}\``);
    if (user.bot) badges.unshift('🤖 Bot');

    // Roles (member)
    let rolesStr = 'N/A';
    if (member?.roles) {
        const roles = [...member.roles.cache.values()]
            .filter(r => r.id !== guild?.id)           // bỏ @everyone
            .sort((a, b) => b.position - a.position)
            .map(r => `<@&${r.id}>`);
        rolesStr = roles.length ? roles.join(' ') : 'Không có role';
        if (rolesStr.length > 1024) rolesStr = roles.slice(0, 20).join(' ') + ` …+${roles.length - 20}`;
    }

    // Permissions (member top role)
    const isAdmin = member?.permissions?.has('Administrator') ?? false;
    const isMod = member?.permissions?.has('ManageMessages') ?? false;

    // Status / presence
    const presence = member?.presence;
    const statusMap = { online: '🟢 Online', idle: '🌙 Idle', dnd: '🔴 Do Not Disturb', offline: '⚫ Offline', invisible: '⚫ Invisible' };
    const statusStr = statusMap[presence?.status ?? 'offline'] ?? '⚫ Offline';
    const activities = presence?.activities ?? [];
    const actStr = activities.map(a => {
        if (a.type === 4) return `💬 ${a.state ?? a.name}`;         // Custom status
        if (a.type === 2) return `🎵 Nghe: **${a.details ?? a.name}**`;
        if (a.type === 0) return `🎮 Chơi: **${a.name}**`;
        if (a.type === 1) return `📺 Stream: **${a.name}**`;
        if (a.type === 3) return `📺 Xem: **${a.name}**`;
        return `• ${a.name}`;
    }).join('\n') || 'Không có';

    // Nitro / premium
    const premiumSince = member?.premiumSince;
    const nitroStr = premiumSince
        ? `💜 Boosting since ${fmtDate(premiumSince)}`
        : 'Không boost';

    // Highest role
    const highestRole = member?.roles.highest;
    const highestRoleStr = highestRole && highestRole.id !== guild?.id
        ? `<@&${highestRole.id}>`
        : '@everyone';

    const embed = new EmbedBuilder()
        .setColor(roleColor(member))
        .setTitle(`${user.bot ? '🤖 ' : ''}${user.globalName ?? user.username}`)
        .setDescription(
            [
                `**Username:** \`${user.username}\``,
                `**Display Name:** ${user.globalName ?? '_không có_'}`,
                `**ID:** \`${user.id}\``,
                member?.nickname ? `**Nickname:** ${member.nickname}` : null,
                `**Status:** ${statusStr}`,
            ].filter(Boolean).join('\n')
        )
        .setThumbnail(avatarURL)
        .addFields(
            {
                name: '📅 Tài khoản',
                value: [
                    `• Tạo lúc: **${fmtDate(createdAt)}**`,
                    `• Tuổi tài khoản: **${accountAge}**`,
                ].join('\n'),
                inline: true,
            },
            {
                name: `🏠 Trong server${guild ? ` • ${guild.name}` : ''}`,
                value: joinedAt
                    ? [`• Tham gia: **${fmtDate(joinedAt)}**`, `• Thời gian: **${memberAge}**`].join('\n')
                    : '_Không phải thành viên_',
                inline: true,
            },
            { name: '\u200B', value: '\u200B', inline: false },
            {
                name: '🎭 Hoạt động',
                value: actStr,
                inline: false,
            },
            {
                name: `🏅 Huy hiệu (${badges.length})`,
                value: badges.length ? badges.join('\n') : '_Không có_',
                inline: true,
            },
            {
                name: '🔑 Quyền nổi bật',
                value: [
                    isAdmin ? '👑 Administrator' : null,
                    isMod ? '🛡️ Manage Messages' : null,
                    member?.permissions?.has('ManageGuild') ? '⚙️ Manage Server' : null,
                    member?.permissions?.has('KickMembers') ? '👢 Kick Members' : null,
                    member?.permissions?.has('BanMembers') ? '🔨 Ban Members' : null,
                ].filter(Boolean).join('\n') || '_Không có quyền đặc biệt_',
                inline: true,
            },
            {
                name: '💎 Nitro Boost',
                value: nitroStr,
                inline: false,
            },
            {
                name: `🎪 Role cao nhất`,
                value: highestRoleStr,
                inline: true,
            },
            {
                name: `📋 Tổng số role`,
                value: member ? `${member.roles.cache.size - 1} role` : 'N/A',
                inline: true,
            },
            {
                name: '\u200B',
                value: '\u200B',
                inline: false,
            },
            {
                name: `🎭 Tất cả role`,
                value: rolesStr,
                inline: false,
            }
        )
        .setFooter({ text: `ID: ${user.id} • Thông tin tại` })
        .setTimestamp();

    return embed;
}

/** Build embed ảnh bìa */
function buildBannerEmbed(user, bannerURL) {
    return new EmbedBuilder()
        .setColor(user.accentColor ?? 0x5865F2)
        .setTitle(`🖼️ Banner của ${user.globalName ?? user.username}`)
        .setImage(bannerURL)
        .setFooter({ text: `ID: ${user.id}` });
}

/** Build buttons */
function buildButtons(user, avatarURL, bannerURL, hasMember) {
    const row = new ActionRowBuilder();

    row.addComponents(
        new ButtonBuilder()
            .setLabel('🖼️ Avatar')
            .setStyle(ButtonStyle.Link)
            .setURL(avatarURL),
    );

    if (hasMember) {
        // server avatar nếu khác
        row.addComponents(
            new ButtonBuilder()
                .setLabel('📋 Avatar Server')
                .setStyle(ButtonStyle.Link)
                .setURL(avatarURL),  // sẽ được thay đúng khi gọi
        );
    }

    if (bannerURL) {
        row.addComponents(
            new ButtonBuilder()
                .setLabel('🖼️ Banner')
                .setStyle(ButtonStyle.Link)
                .setURL(bannerURL),
        );
    }

    row.addComponents(
        new ButtonBuilder()
            .setLabel('🔗 Trang Discord')
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/users/${user.id}`),
    );

    return row;
}

// ───────── Handler ─────────

async function handleUserInfo(interaction) {
    await interaction.deferReply();

    const inputId = interaction.options.getString('id');
    const inputMention = interaction.options.getUser('user');

    let user = inputMention ?? null;
    let member = null;

    // Resolve theo ID nếu có
    if (!user && inputId) {
        try {
            user = await interaction.client.users.fetch(inputId, { force: true });
        } catch {
            return interaction.editReply({ content: `❌ Không tìm thấy user với ID \`${inputId}\`` });
        }
    }

    // Fallback: bản thân
    if (!user) {
        user = await interaction.client.users.fetch(interaction.user.id, { force: true });
    }

    // Fetch full profile (banner, accentColor)
    try { user = await interaction.client.users.fetch(user.id, { force: true }); } catch { }

    // Lấy member trong guild nếu có
    if (interaction.guild) {
        try { member = await interaction.guild.members.fetch(user.id); } catch { }
    }

    // URLs
    const avatarURL = user.displayAvatarURL({ size: 4096, dynamic: true, extension: 'png' });
    const serverAvatar = member?.displayAvatarURL({ size: 4096, dynamic: true, extension: 'png' });
    const bannerURL = user.bannerURL?.({ size: 4096, dynamic: true, extension: 'png' }) ?? null;

    const mainEmbed = buildEmbed(user, member, interaction.guild);
    const embeds = [mainEmbed];

    // Nếu có banner, thêm embed ảnh bìa
    if (bannerURL) embeds.push(buildBannerEmbed(user, bannerURL));

    // Buttons
    const row = new ActionRowBuilder();
    row.addComponents(
        new ButtonBuilder().setLabel('🖼️ Avatar').setStyle(ButtonStyle.Link).setURL(avatarURL),
    );
    if (serverAvatar && serverAvatar !== avatarURL) {
        row.addComponents(
            new ButtonBuilder().setLabel('📋 Avatar Server').setStyle(ButtonStyle.Link).setURL(serverAvatar),
        );
    }
    if (bannerURL) {
        row.addComponents(
            new ButtonBuilder().setLabel('🖼️ Banner').setStyle(ButtonStyle.Link).setURL(bannerURL),
        );
    }
    row.addComponents(
        new ButtonBuilder()
            .setLabel('🔗 Hồ sơ Discord')
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/users/${user.id}`),
    );

    await interaction.editReply({ embeds, components: [row] });
}

// ───────── Export ─────────

const userinfoCommands = [
    new SlashCommandBuilder()
        .setName('userinfo')
        .setDescription('Xem thông tin chi tiết của một người dùng')
        .addUserOption(o =>
            o.setName('user').setDescription('Mention người dùng (tùy chọn)').setRequired(false)
        )
        .addStringOption(o =>
            o.setName('id').setDescription('ID người dùng Discord (tùy chọn)').setRequired(false)
        )
        .toJSON(),
];

module.exports = (client) => {
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== 'userinfo') return;
        try {
            await handleUserInfo(interaction);
        } catch (err) {
            console.error('[USERINFO] Lỗi:', err);
            const msg = { content: '❌ Có lỗi xảy ra khi lấy thông tin người dùng.', ephemeral: true };
            interaction.replied || interaction.deferred
                ? await interaction.editReply(msg)
                : await interaction.reply(msg);
        }
    });
};

module.exports.userinfoCommands = userinfoCommands;