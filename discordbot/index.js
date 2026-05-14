//process.env.DEBUG = ''; // Tắt debug log của các thư viện (discord-video-stream, v.v.)
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');
const fs = require('fs');

// ===== DATA =====
const DATA_FOLDER = './.dataserver';

const getDataFile = (guildId) => `${DATA_FOLDER}/data_${guildId}.json`;

const ensureDataFolder = () => {
  if (!fs.existsSync(DATA_FOLDER)) {
    fs.mkdirSync(DATA_FOLDER, { recursive: true });
    console.log(`[DATA] Đã tạo thư mục: ${DATA_FOLDER}`);
  }
};

const loadData = (guildId) => {
  ensureDataFolder();
  const file = getDataFile(guildId);
  if (!fs.existsSync(file)) { fs.writeFileSync(file, '{}'); return {}; }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { console.error(`[DATA] Lỗi đọc file ${file}:`, err.message); return {}; }
};

const saveData = (guildId, d) => {
  ensureDataFolder();
  try { fs.writeFileSync(getDataFile(guildId), JSON.stringify(d, null, 2)); }
  catch (err) { console.error(`[DATA] Lỗi lưu:`, err.message); }
};

// ===== BOT =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,   // ← cần cho status/activity trong userinfo
  ]
});

require('./music')(client);
require('./scheduler')(client);
require('./purge')(client);
require('./welcome')(client);
require('./ping')(client);
require('./contact')(client);
require('./lookup')(client);
require('./wordchain')(client);
require('./help')(client, () => allCommandsForHelp);
//require('./bannedWords')(client);
require('./Download')(client);
require('./Convert')(client);
require('./Botoff')(client);
require('./stream')(client);            // ← STREAM
require('./secondaryAccounts')(client);
require('./userinfo')(client);          // ← USERINFO

// ===== SLASH COMMANDS =====
const { scheduleCommands } = require('./scheduler');
const { purgeCommands } = require('./purge');
const { welcomeCommands } = require('./welcome');
const { pingCommands } = require('./ping');
const { contactCommands } = require('./contact');
const { lookupCommands } = require('./lookup');
const { wordchainCommands } = require('./wordchain');
const { helpCommands } = require('./help');
//const { scanHistory, badwordCommands } = require('./bannedWords');
const { downloadCommands } = require('./Download');
const { convertCommands } = require('./Convert');
const { botoffCommands } = require('./Botoff');
const { streamCommands } = require('./stream');   // ← STREAM
const { userinfoCommands } = require('./userinfo'); // ← USERINFO

const commands = [
  new SlashCommandBuilder()
    .setName('play').setDescription('Phát nhạc')
    .addStringOption(o => o.setName('query').setDescription('Link YouTube hoặc tên').setRequired(true)),
  new SlashCommandBuilder().setName('pause').setDescription('Pause'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip bài hiện tại'),
].map(c => c.toJSON());

const allCommandsForHelp = [
  ...commands,
  ...scheduleCommands,
  ...purgeCommands,
  ...welcomeCommands,
  ...pingCommands,
  ...contactCommands,
  ...lookupCommands,
  ...wordchainCommands,
  ...helpCommands,
  //...badwordCommands,
  ...downloadCommands,
  ...convertCommands,
  ...botoffCommands,
  ...streamCommands,    // ← STREAM
  ...userinfoCommands,  // ← USERINFO
];

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: allCommandsForHelp });
    console.log('[CMD] Đã đăng ký slash commands GLOBAL');
  } catch (err) {
    console.error('[CMD] Lỗi đăng ký commands:', err);
  }
})();

// ===== NICKNAME SYNC =====
function getDisplayName(member) {
  return member.user.globalName || member.user.username;
}

async function enforceNickname(member, saved) {
  if (!saved.locked) return;
  const targetNick = saved.nickname ?? saved.username;
  if (member.nickname === targetNick) return;
  try { await member.setNickname(targetNick, 'Auto sync'); } catch { }
}

async function syncMember(member) {
  if (member.user.bot) return;
  const guildId = member.guild.id;
  const id = member.id;
  const username = member.user.username;
  const name = getDisplayName(member);
  const nickname = member.nickname ?? null;
  const data = loadData(guildId);
  const saved = data[id];

  if (!saved) {
    // Member mới: lưu thông tin hiện tại và lock
    data[id] = { username, name, nickname, locked: true };
    saveData(guildId, data);
    await enforceNickname(member, data[id]);
    return;
  }

  let changed = false;
  // Luôn sync username (login name)
  if (saved.username !== username) { saved.username = username; changed = true; }
  // Chỉ sync name (globalName) khi không bị lock — tránh ghi đè name bạn sửa tay
  if (!saved.locked && saved.name !== name) { saved.name = name; changed = true; }
  // Chỉ sync nickname từ Discord khi không bị lock
  if (!saved.locked && saved.nickname !== nickname) { saved.nickname = nickname; changed = true; }
  if (changed) saveData(guildId, data);
  // Luôn enforce nickname từ JSON lên Discord (kể cả khi không có gì thay đổi)
  await enforceNickname(member, saved);
}

async function syncGuild(guild) {
  let members;
  try { members = await guild.members.fetch(); }
  catch { return { synced: 0, failed: 1 }; }
  let synced = 0, failed = 0;
  await Promise.allSettled(
    [...members.values()].map(m => syncMember(m).then(() => synced++).catch(() => failed++))
  );
  return { synced, failed };
}

async function syncAllGuilds() {
  const guilds = [...client.guilds.cache.values()];
  const results = await Promise.allSettled(guilds.map(g => syncGuild(g)));
  let totalSynced = 0, totalFailed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') { totalSynced += r.value.synced; totalFailed += r.value.failed; }
  }
  console.log(`[NICK] Done — ${guilds.length} server(s) | ${totalSynced} synced${totalFailed ? ` | ${totalFailed} failed` : ''}`);
}

// ===== READY =====
client.once('ready', async () => {
  console.log(`[BOT] READY: ${client.user.tag} | ${client.guilds.cache.size} server(s)`);

  const updatePresence = () => {
    client.user.setPresence({
      status: 'online',
      activities: [{ name: `🎶 /help | Xiao Xinh Trai hihi`, type: 2 }],
    });
  };
  updatePresence();
  setInterval(updatePresence, 10 * 60 * 1000);
  await syncAllGuilds();

  // Bỏ comment block scanHistory nếu bạn bật lại bannedWords
  // console.log('[BADWORD] Bắt đầu quét tin nhắn 20 phút trước...');
  // let totalScanned = 0;
  // for (const [, guild] of client.guilds.cache) {
  //   const textChannels = guild.channels.cache.filter(c =>
  //     c.type === ChannelType.GuildText && c.viewable &&
  //     c.permissionsFor(guild.members.me)?.has('ReadMessageHistory')
  //   );
  //   for (const [, channel] of textChannels) {
  //     await scanHistory(channel, guild.id, 20);
  //     totalScanned++;
  //   }
  // }
  // console.log(`[BADWORD] Quét xong ${totalScanned} channel(s) — bắt đầu realtime.`);
});

// ===== GUILD EVENTS =====
client.on('guildCreate', async (guild) => {
  console.log(`[BOT] Được add vào server mới: ${guild.name} (${guild.id})`);
  await syncGuild(guild);
});

client.on('guildDelete', (guild) => {
  console.log(`[BOT] Bị remove khỏi server: ${guild.name} (${guild.id})`);

  const dataFile = getDataFile(guild.id);
  if (fs.existsSync(dataFile)) { fs.unlinkSync(dataFile); console.log(`[BOT] Đã xóa data nickname`); }

  for (const [file, key] of [
    ['./schedules.json', null],
    ['./welcome_config.json', guild.id],
    ['./download_config.json', guild.id],
    ['./convert_config.json', guild.id],
  ]) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = JSON.parse(fs.readFileSync(file));
      if (key === null) {
        const filtered = data.filter(j => j.guildId !== guild.id);
        fs.writeFileSync(file, JSON.stringify(filtered, null, 2));
      } else if (data[key]) {
        delete data[key];
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
      }
    } catch (err) { console.error(`[BOT] Lỗi xóa ${file}:`, err.message); }
  }
});

client.on('guildMemberAdd', async (member) => {
  if (member.user.bot) return;
  await syncMember(member);
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (newMember.user.bot) return;
  const nicknameChanged = oldMember.nickname !== newMember.nickname;
  const usernameChanged = oldMember.user.username !== newMember.user.username;
  const nameChanged = oldMember.user.globalName !== newMember.user.globalName;
  if (!nicknameChanged && !usernameChanged && !nameChanged) return;

  const guildId = newMember.guild.id;
  const data = loadData(guildId);
  const saved = data[newMember.id];
  if (!saved) return;

  if (usernameChanged || nameChanged) {
    if (usernameChanged) saved.username = newMember.user.username;
    // Chỉ sync name khi không bị lock — tránh ghi đè name bạn sửa tay
    if (nameChanged && !saved.locked) saved.name = getDisplayName(newMember);
    saveData(guildId, data);
    await enforceNickname(newMember, saved);
    return;
  }

  if (!nicknameChanged) return;

  if (saved.locked) {
    const target = saved.nickname ?? saved.username;
    if (newMember.nickname !== target) {
      try { await newMember.setNickname(target, 'Bị khóa'); } catch { }
    }
  } else {
    saved.nickname = newMember.nickname;
    saveData(guildId, data);
  }
});

// ===== ERROR HANDLER =====
process.on('unhandledRejection', (err) => console.error('[ERROR] Unhandled rejection:', err?.message ?? err));
process.on('uncaughtException', (err) => console.error('[ERROR] Uncaught exception:', err?.message ?? err));
client.on('error', (err) => {
  const msg = err?.message ?? String(err);
  if (msg.includes('Unknown interaction')) return;
  console.error('[BOT] Client error:', msg);
});

client.login(process.env.TOKEN);