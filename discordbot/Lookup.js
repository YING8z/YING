// ===== LOOKUP MODULE =====
const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const fs = require('fs');

// ===== BR (SINH TỒN): Tính rank từ BrRankPoint =====
// Dựa theo bảng điểm chuẩn chính thức
const getBrRankDisplay = (brRankPoint, brMaxRank) => {
  if (brRankPoint === undefined || brRankPoint === null) return getBrBadgeName(brMaxRank);

  const pts = Number(brRankPoint);
  let tier, sub;

  if (pts >= 12000) { tier = '🏅 Đại Cao Thủ'; sub = ''; }
  else if (pts >= 9000) { tier = '🏅 Đại Cao Thủ'; sub = ''; }
  else if (pts >= 8000) { tier = '⚡ Cao Thủ'; sub = ' → Đại Cao Thủ'; }
  else if (pts >= 7100) { tier = '⚡ Cao Thủ'; sub = ''; }
  else if (pts >= 6300) { tier = '🌟 Siêu Huyền Thoại'; sub = ' → Cao Thủ'; }
  else if (pts >= 4900) { tier = '🌟 Siêu Huyền Thoại'; sub = ''; }
  else if (pts >= 4300) { tier = '🟣 Huyền Thoại'; sub = ' → Siêu Huyền Thoại'; }
  else if (pts >= 3800) { tier = '🟣 Huyền Thoại'; sub = ''; }
  else if (pts >= 3500) { tier = '💎 Kim Cương V'; sub = ' → Huyền Thoại'; }
  else if (pts >= 3350) { tier = '💎 Kim Cương IV–V'; sub = ''; }
  else if (pts >= 3200) { tier = '💎 Kim Cương III–IV'; sub = ''; }
  else if (pts >= 3050) { tier = '💎 Kim Cương II–III'; sub = ''; }
  else if (pts >= 2900) { tier = '💎 Kim Cương I–II'; sub = ''; }
  else if (pts >= 2750) { tier = '🔷 Bạch Kim IV–V'; sub = ' → Kim Cương'; }
  else if (pts >= 2600) { tier = '🔷 Bạch Kim IV–V'; sub = ''; }
  else if (pts >= 2475) { tier = '🔷 Bạch Kim III–IV'; sub = ''; }
  else if (pts >= 2350) { tier = '🔷 Bạch Kim II–III'; sub = ''; }
  else if (pts >= 2225) { tier = '🔷 Bạch Kim I–II'; sub = ''; }
  else if (pts >= 2100) { tier = '🥇 Vàng IV'; sub = ' → Bạch Kim'; }
  else if (pts >= 1975) { tier = '🥇 Vàng III–IV'; sub = ''; }
  else if (pts >= 1850) { tier = '🥇 Vàng II–III'; sub = ''; }
  else if (pts >= 1725) { tier = '🥇 Vàng I–II'; sub = ''; }
  else if (pts >= 1600) { tier = '🥈 Bạc III'; sub = ' → Vàng'; }
  else if (pts >= 1500) { tier = '🥈 Bạc II–III'; sub = ''; }
  else if (pts >= 1400) { tier = '🥈 Bạc I–II'; sub = ''; }
  else if (pts >= 1300) { tier = '🥉 Đồng III'; sub = ' → Bạc'; }
  else { tier = '🥉 Đồng I–III'; sub = ''; }

  return `${tier}${sub}\n📊 ${pts} điểm`;
};

const getBrBadgeName = (badgeId) => {
  if (!badgeId) return '—';
  if (badgeId >= 324) return '🏅 Đại Cao Thủ';
  if (badgeId === 323) return '⚡ Cao Thủ';
  if (badgeId >= 321) return '🌟 Siêu Huyền Thoại';
  if (badgeId >= 316) return '🟣 Huyền Thoại';
  if (badgeId >= 313) return '💎 Kim Cương';
  if (badgeId >= 310) return '🔷 Bạch Kim';
  if (badgeId >= 307) return '🥇 Vàng';
  if (badgeId >= 304) return '🥈 Bạc';
  if (badgeId >= 301) return '🥉 Đồng';
  return `Badge #${badgeId}`;
};

// ===== CS (TỬ CHIẾN): Tính rank từ CsMaxRank + CsRankPoint =====
//
// CsMaxRank   = badge ID xác định tier hiện tại
// CsRankPoint = sao hiện tại TRONG tier (reset khi lên tier)
//
// Cấu trúc:
//   Đồng/Bạc/Vàng/Bạch Kim : 3 sub (I~III) × 5 sao mỗi sub
//   Kim Cương               : 5 sub (I~V)   × 5 sao mỗi sub
//   Huyền Thoại trở lên     : badge 316+, phân loại bằng số sao
//     0–24  sao → Huyền Thoại
//     25–49 sao → Đại Huyền Thoại
//     50–99 sao → Cao Thủ
//     100+  sao → Đại Cao Thủ
//   Thách Đấu               : badge 324+ (top 7000 server)

const getCsRankDisplay = (csMaxRank, csRankPoint) => {
  if (!csMaxRank) return '—';

  const stars = csRankPoint != null ? Number(csRankPoint) : null;
  const sTop = stars != null ? `\n★ ${stars} sao` : '';

  // Sub-tier 3 sub × 5 sao (Đồng / Bạc / Vàng / Bạch Kim)
  const sub3 = () => {
    if (stars == null) return '';
    const subIdx = Math.min(Math.floor(stars / 5), 2); // 0=I, 1=II, 2=III
    const label = ['I', 'II', 'III'][subIdx];
    const starInSub = stars % 5;
    return `\n★ ${starInSub}/5 sao (${label})`;
  };

  // Sub-tier 5 sub × 5 sao (Kim Cương I~V)
  const sub5 = () => {
    if (stars == null) return '';
    const subIdx = Math.min(Math.floor(stars / 5), 4); // 0=I ... 4=V
    const label = ['I', 'II', 'III', 'IV', 'V'][subIdx];
    const starInSub = stars % 5;
    return `\n★ ${starInSub}/5 sao (${label})`;
  };

  // Thách Đấu: badge 324+ (top 7000 server)
  if (csMaxRank >= 324) return `👑 Thách Đấu${sTop}`;

  // Huyền Thoại trở lên: badge 316+, phân loại bằng số sao
  if (csMaxRank >= 316) {
    if (stars >= 100) return `⚡ Đại Cao Thủ${sTop}`;
    else if (stars >= 50) return `🌟 Cao Thủ${sTop}`;
    else if (stars >= 25) return `🟣 Đại Huyền Thoại${sTop}`;
    else return `🦸 Huyền Thoại${sTop}`;
  }

  if (csMaxRank >= 313) return `💎 Kim Cương${sub5()}`;
  else if (csMaxRank >= 310) return `🔷 Bạch Kim${sub3()}`;
  else if (csMaxRank >= 307) return `🥇 Vàng${sub3()}`;
  else if (csMaxRank >= 304) return `🥈 Bạc${sub3()}`;
  else if (csMaxRank >= 301) return `🥉 Đồng${sub3()}`;
  else return `Badge #${csMaxRank}`;
};

const FF_REGIONS = [
  { name: '🇻🇳 Việt Nam', value: 'vn' },
  { name: '🇸🇬 Singapore', value: 'sg' },
  { name: '🇮🇩 Indonesia', value: 'id' },
  { name: '🇮🇳 India', value: 'ind' },
  { name: '🇹🇭 Thailand', value: 'th' },
  { name: '🇹🇼 Taiwan', value: 'tw' },
  { name: '🇵🇰 Pakistan', value: 'pk' },
  { name: '🇧🇩 Bangladesh', value: 'bd' },
  { name: '🌍 Middle East', value: 'me' },
  { name: '🌎 Brazil', value: 'br' },
];

async function fetchHLGaming(sectionName, uid, region, extra = '') {
  const useruid = process.env.FF_HL_USERUID;
  const apiKey = process.env.FF_HL_APIKEY;
  const url =
    `https://proapis.hlgamingofficial.com/main/games/freefire/account/api` +
    `?sectionName=${sectionName}&PlayerUid=${uid}&region=${region}` +
    `&useruid=${useruid}&api=${apiKey}${extra}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HL Gaming HTTP ${res.status}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Phản hồi không hợp lệ: ${text.slice(0, 100)}`); }
  if (text.includes('not in allowlist')) throw new Error('IP server chưa được whitelist tại hlgamingofficial.com → Dashboard → IP Whitelist');
  if (json.error || json.status === false || json.success === false)
    throw new Error(json.message ?? json.error ?? 'API báo lỗi');
  return json;
}

async function lookupFreeFire(uid, region) {
  if (!process.env.FF_HL_USERUID || !process.env.FF_HL_APIKEY)
    throw new Error('Chưa cấu hình FF_HL_USERUID / FF_HL_APIKEY trong .env\nĐăng ký miễn phí: hlgamingofficial.com');

  const [infoData, imgData] = await Promise.all([
    fetchHLGaming('AccountInfo', uid, region),
    fetchHLGaming('AllData', uid, region, '&filter=isIMG').catch(() => null),
  ]);

  const r = infoData?.result;
  if (!r?.AccountName) throw new Error(`Không tìm thấy người chơi UID ${uid} tại khu vực ${region.toUpperCase()}`);

  const imgResult = imgData?.result ?? {};
  const avatarUrl = imgResult.OutfitImageUrl ?? imgResult.AvatarImageUrl ?? null;
  const bannerUrl = imgResult.BannerImageUrl ?? null;

  const lastLogin = r.AccountLastLogin
    ? new Date(r.AccountLastLogin * 1000).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : 'Không rõ';

  const ngayTao = r.AccountCreateTime
    ? new Date(r.AccountCreateTime * 1000).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : 'Không rõ';

  const embed = new EmbedBuilder()
    .setTitle(`🔥 Free Fire — ${r.AccountName}`)
    .setColor(0xff4500)
    .setFooter({ text: `UID: ${uid} | Khu vực: ${r.AccountRegion ?? region.toUpperCase()} | The Xiao` })
    .addFields(
      { name: '⭐ Cấp độ', value: String(r.AccountLevel ?? '?'), inline: true },
      { name: '❤️ Lượt thích', value: String(r.AccountLikes ?? '0'), inline: true },
      { name: '🎖️ Huy hiệu BP', value: String(r.AccountBPBadges ?? '?'), inline: true },
      { name: '🏆 Rank Sinh Tồn', value: getBrRankDisplay(r.BrRankPoint, r.BrMaxRank), inline: true },
      { name: '⚔️ Rank Tử Chiến', value: getCsRankDisplay(r.CsMaxRank, r.CsRankPoint), inline: true },
      { name: '📊 Mùa giải', value: `Mùa ${r.AccountSeasonId ?? '?'}`, inline: true },
      { name: '📅 Ngày tạo', value: ngayTao, inline: true },
      { name: '🕐 Đăng nhập lần cuối', value: lastLogin, inline: true },
      { name: '🌏 Khu vực', value: r.AccountRegion ?? region.toUpperCase(), inline: true },
    );

  if (avatarUrl) embed.setThumbnail(avatarUrl);
  if (bannerUrl) embed.setImage(bannerUrl);

  return embed;
}

async function lookupRoblox(input) {
  // Nếu input là số → dùng làm UID, nếu là chữ → tìm theo username
  let uid = input;

  if (!/^\d+$/.test(input)) {
    // Lookup username → UID
    const usernameRes = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [input], excludeBannedUsers: false }),
    });
    if (!usernameRes.ok) throw new Error(`Không thể tìm username "${input}"`);
    const usernameData = await usernameRes.json();
    if (!usernameData.data?.length) throw new Error(`Không tìm thấy username "${input}" trên Roblox`);
    uid = usernameData.data[0].id;
    console.log(`[ROBLOX] Username "${input}" → UID ${uid}`);
  }

  const [userRes, thumbRes, badgesRes, groupsRes] = await Promise.all([
    fetch(`https://users.roblox.com/v1/users/${uid}`),
    fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${uid}&size=150x150&format=Png&isCircular=false`),
    fetch(`https://badges.roblox.com/v1/users/${uid}/badges?limit=10&sortOrder=Asc`),
    fetch(`https://groups.roblox.com/v1/users/${uid}/groups/roles`),
  ]);

  if (!userRes.ok) throw new Error(`Không tìm thấy user Roblox với ID: ${uid}`);

  const user = await userRes.json();
  if (user.errors?.length) throw new Error(user.errors[0]?.message ?? 'User không tồn tại');

  const thumbData = await thumbRes.json();
  const badgesData = badgesRes.ok ? await badgesRes.json() : null;
  const groupsData = groupsRes.ok ? await groupsRes.json() : null;

  const avatarUrl = thumbData.data?.[0]?.imageUrl ?? null;
  const badgeCount = badgesData?.data?.length ?? 0;
  const groupCount = groupsData?.data?.length ?? 0;
  const created = user.created
    ? new Date(user.created).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : '?';

  const embed = new EmbedBuilder()
    .setTitle(`🎮 Roblox — ${user.displayName ?? user.name}`)
    .setColor(0xe03c31)
    .setURL(`https://www.roblox.com/users/${uid}/profile`)
    .setFooter({ text: `User ID: ${uid} | Hoàn toàn miễn phí` })
    .addFields(
      { name: '👤 Username', value: `@${user.name}`, inline: true },
      { name: '📅 Ngày tạo', value: created, inline: true },
      { name: '🔒 Đã xác minh', value: user.hasVerifiedBadge ? '✅ Có' : '❌ Không', inline: true },
      { name: '🏅 Badges', value: `${badgeCount}+`, inline: true },
      { name: '👥 Groups', value: String(groupCount), inline: true },
      { name: '🔗 Profile', value: `[Xem trên Roblox](https://www.roblox.com/users/${uid}/profile)`, inline: true },
    );

  if (user.description?.trim())
    embed.setDescription(`> ${user.description.slice(0, 200)}${user.description.length > 200 ? '...' : ''}`);

  if (avatarUrl) embed.setThumbnail(avatarUrl);
  return embed;
}

// ===== CONFIG: lưu channel được phép dùng lookup theo guild =====
const LOOKUP_CONFIG_FILE = './lookup_config.json';

const loadLookupConfig = () => {
  if (!fs.existsSync(LOOKUP_CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(LOOKUP_CONFIG_FILE)); } catch { return {}; }
};

const saveLookupConfig = (cfg) => {
  fs.writeFileSync(LOOKUP_CONFIG_FILE, JSON.stringify(cfg, null, 2));
};

const getLookupChannelId = (guildId) => loadLookupConfig()[guildId] ?? null;

// ===== SLASH COMMANDS =====
const lookupCommands = [
  // Lệnh tra cứu — ai cũng dùng được
  new SlashCommandBuilder()
    .setName('lookup')
    .setDescription('🔍 Tra cứu thông tin người chơi theo ID (miễn phí)')
    .addStringOption(o =>
      o.setName('game').setDescription('Chọn game').setRequired(true)
        .addChoices(
          { name: '🎮 Roblox (miễn phí, không cần key)', value: 'roblox' },
          { name: '🔥 Free Fire (miễn phí qua HL Gaming)', value: 'freefire' },
        )
    )
    .addStringOption(o =>
      o.setName('uid').setDescription('UID / ID người chơi — Roblox có thể nhập username').setRequired(true)
    )
    .addStringOption(o =>
      o.setName('region').setDescription('Region — chỉ dùng cho Free Fire (mặc định: vn)').setRequired(false)
        .addChoices(...FF_REGIONS)
    )
    .toJSON(),

  // Lệnh set channel — chỉ hiện với người có quyền Quản lý Server
  new SlashCommandBuilder()
    .setName('setlookup')
    .setDescription('⚙️ Chọn channel cho phép dùng lệnh lookup')
    .setDefaultMemberPermissions(0x20) // MANAGE_GUILD
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('Channel muốn cho phép dùng lookup')
        .setRequired(true)
    )
    .toJSON(),
];

// ===== HANDLER =====
module.exports = (client) => {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // ── /setlookup ──────────────────────────────────────────────
    if (interaction.commandName === 'setlookup') {
      const channel = interaction.options.getChannel('channel');
      const cfg = loadLookupConfig();
      cfg[interaction.guildId] = channel.id;
      saveLookupConfig(cfg);
      console.log(`[LOOKUP] Guild ${interaction.guildId} set channel → #${channel.name} (${channel.id})`);
      return interaction.reply({
        content: `✅ Đã set! Lệnh **/lookup** chỉ hoạt động trong <#${channel.id}> từ bây giờ.`,
        ephemeral: true,
      });
    }

    // ── /lookup ──────────────────────────────────────────────────
    if (interaction.commandName !== 'lookup') return;

    // Kiểm tra channel được phép
    const allowedChannelId = getLookupChannelId(interaction.guildId);
    if (allowedChannelId && interaction.channelId !== allowedChannelId) {
      return interaction.reply({
        content: `❌ Lệnh này chỉ dùng được trong <#${allowedChannelId}>!`,
        ephemeral: true,
      });
    }

    const game = interaction.options.getString('game');
    const uid = interaction.options.getString('uid').trim();
    const region = interaction.options.getString('region') ?? 'vn';

    if (game === 'freefire' && !/^\d+$/.test(uid))
      return interaction.reply({ content: '❌ Free Fire UID phải là **dãy số**. Vui lòng kiểm tra lại!', ephemeral: true });

    // Tránh lỗi 10062 khi bot vừa restart
    if (interaction.replied || interaction.deferred) return;

    try {
      await interaction.deferReply();
    } catch (err) {
      console.warn(`[LOOKUP] deferReply thất bại (interaction hết hạn): ${err.message}`);
      return;
    }

    try {
      let embed;
      if (game === 'freefire') embed = await lookupFreeFire(uid, region);
      else if (game === 'roblox') embed = await lookupRoblox(uid);
      else return interaction.editReply('❌ Game chưa được hỗ trợ.');
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error(`[LOOKUP][${game.toUpperCase()}] UID ${uid}:`, err.message);
      try { await interaction.editReply(`❌ Lỗi: **${err.message}**`); } catch { }
    }
  });
};

module.exports.lookupCommands = lookupCommands;