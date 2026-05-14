const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const os = require('os');

// ===== EXPORT COMMANDS =====
const pingCommands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('📡 Xem network, uptime và thông tin hệ thống của bot')
    .toJSON()
];

// ===== HELPER FUNCTIONS =====

// Format uptime: giây → "X ngày X giờ X phút X giây"
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const parts = [];
  if (d > 0) parts.push(`${d} ngày`);
  if (h > 0) parts.push(`${h} giờ`);
  if (m > 0) parts.push(`${m} phút`);
  parts.push(`${s} giây`);

  return parts.join(' ');
}

// Format bytes → KB / MB / GB
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// Màu thanh status theo ping
function getPingColor(ping) {
  if (ping < 100) return 0x2ecc71;   // xanh lá — tốt
  if (ping < 200) return 0xf1c40f;   // vàng — ổn
  if (ping < 400) return 0xe67e22;   // cam — chậm
  return 0xe74c3c;                    // đỏ — tệ
}

// Emoji đánh giá ping
function getPingEmoji(ping) {
  if (ping < 100) return '🟢';
  if (ping < 200) return '🟡';
  if (ping < 400) return '🟠';
  return '🔴';
}

// Thanh tiến trình đơn giản bằng unicode
function buildBar(value, max, length = 10) {
  const filled = Math.round((value / max) * length);
  const empty = length - filled;
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
}

// CPU usage trung bình (%)
function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  }
  const usage = 100 - (totalIdle / totalTick) * 100;
  return Math.round(usage);
}

// ===== MODULE =====
module.exports = (client) => {

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'ping') return;

    await interaction.deferReply();

    // ─── Đo API latency ───────────────────────────────────────────────────
    const sentAt = Date.now();
    const wsPing = client.ws.ping; // WebSocket heartbeat latency (ms)

    // Gửi 1 lần đầu rỗng để đo round-trip
    await interaction.editReply({ content: '📡 Đang đo...' });
    const apiPing = Date.now() - sentAt;

    // ─── Hệ thống ─────────────────────────────────────────────────────────
    const uptimeBot   = process.uptime();              // uptime process Node (giây)
    const uptimeHost  = os.uptime();                   // uptime server/host (giây)
    const memTotal    = os.totalmem();
    const memFree     = os.freemem();
    const memUsed     = memTotal - memFree;
    const memPercent  = Math.round((memUsed / memTotal) * 100);
    const cpuUsage    = getCpuUsage();
    const cpuModel    = os.cpus()[0]?.model?.trim() || 'Không rõ';
    const cpuCores    = os.cpus().length;
    const nodeVer     = process.version;
    const platform    = os.platform();
    const arch        = os.arch();

    // ─── Discord stats ─────────────────────────────────────────────────────
    const guilds      = client.guilds.cache.size;
    const users       = client.guilds.cache.reduce((a, g) => a + g.memberCount, 0);
    const channels    = client.channels.cache.size;

    // ─── Màu theo ping ─────────────────────────────────────────────────────
    const color = getPingColor(Math.max(wsPing, apiPing));
    const pingEmoji = getPingEmoji(Math.max(wsPing, apiPing));

    // ─── Build embed ───────────────────────────────────────────────────────
    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({
        name: `${client.user.username} · Diagnostics`,
        iconURL: client.user.displayAvatarURL()
      })
      .setTitle(`${pingEmoji} Network & System Status`)
      .setDescription(
        `> Bot đang hoạt động bình thường trên **${guilds}** server(s) với **${users.toLocaleString()}** thành viên.`
      )

      // ─── NETWORK ──────────────────────────────────────────────────────
      .addFields(
        {
          name: '📡 __NETWORK__',
          value: [
            `**WebSocket Ping** : \`${wsPing >= 0 ? wsPing + ' ms' : 'N/A'}\` ${getPingEmoji(wsPing)}`,
            `**API Latency**    : \`${apiPing} ms\` ${getPingEmoji(apiPing)}`,
            `**Đánh giá**       : ${wsPing < 100 && apiPing < 150 ? '✅ Xuất sắc' : wsPing < 200 ? '⚡ Ổn định' : wsPing < 400 ? '⚠️ Hơi chậm' : '❌ Chậm'}`,
          ].join('\n'),
          inline: false
        },

        // ─── UPTIME ──────────────────────────────────────────────────
        {
          name: '⏱ __UPTIME__',
          value: [
            `**Bot**  : \`${formatUptime(uptimeBot)}\``,
            `**Host** : \`${formatUptime(uptimeHost)}\``,
          ].join('\n'),
          inline: true
        },

        // ─── DISCORD ──────────────────────────────────────────────────
        {
          name: '🤖 __DISCORD__',
          value: [
            `**Servers**  : \`${guilds}\``,
            `**Users**    : \`${users.toLocaleString()}\``,
            `**Channels** : \`${channels}\``,
          ].join('\n'),
          inline: true
        },

        // ─── Spacer ──────────────────────────────────────────────────
        { name: '\u200b', value: '\u200b', inline: false },

        // ─── MEMORY ──────────────────────────────────────────────────
        {
          name: '💾 __MEMORY__',
          value: [
            `**Dùng** : \`${formatBytes(memUsed)}\` / \`${formatBytes(memTotal)}\``,
            `**Free** : \`${formatBytes(memFree)}\``,
            `\`${buildBar(memUsed, memTotal)}\` **${memPercent}%**`,
          ].join('\n'),
          inline: true
        },

        // ─── CPU ──────────────────────────────────────────────────────
        {
          name: '🖥 __CPU__',
          value: [
            `**Model** : \`${cpuModel.length > 30 ? cpuModel.slice(0, 30) + '…' : cpuModel}\``,
            `**Cores** : \`${cpuCores} cores\``,
            `**Usage** : \`${buildBar(cpuUsage, 100)}\` **${cpuUsage}%**`,
          ].join('\n'),
          inline: true
        },

        // ─── SYSTEM ──────────────────────────────────────────────────
        {
          name: '⚙️ __SYSTEM__',
          value: [
            `**Node.js**  : \`${nodeVer}\``,
            `**Platform** : \`${platform} (${arch})\``,
            `**PID**      : \`${process.pid}\``,
          ].join('\n'),
          inline: false
        }
      )
      .setFooter({
        text: `Requested by ${interaction.user.username} · ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} · Tự xóa sau 5 phút`,
        iconURL: interaction.user.displayAvatarURL()
      });

    await interaction.editReply({ content: null, embeds: [embed] });

    // Tự xóa sau 5 phút
    setTimeout(async () => {
      try {
        await interaction.deleteReply();
        console.log(`[PING] Đã xóa tin nhắn /ping của ${interaction.user.username}`);
      } catch {
        // Tin nhắn đã bị xóa thủ công trước đó → bỏ qua
      }
    }, 5 * 60 * 1000);
  });

};

module.exports.pingCommands = pingCommands;