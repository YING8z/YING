const { EmbedBuilder, SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const https = require('https');
const http = require('http');
const path = require('path');

// ===== FONTS =====
try {
  GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'NotoSans-Bold.ttf'), 'NotoSans');
  GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'NotoSans-Regular.ttf'), 'NotoSans');
} catch (e) {
  console.warn('[CONTACT] Font load failed:', e.message);
}

// ===== COMMANDS =====
const contactCommands = [
  new SlashCommandBuilder()
    .setName('contact')
    .setDescription('📬 Xem thông tin liên hệ chủ sở hữu bot')
    .toJSON()
];

// ===== HELPERS =====
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(downloadBuffer(res.headers.location));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

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

// ===== GENERATE CONTACT CARD =====
async function generateContactCard(botAvatarUrl) {
  const W = 900, H = 380;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ── Background dark gradient ──
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0,   '#0a0a0f');
  bg.addColorStop(0.4, '#0f0a1a');
  bg.addColorStop(1,   '#0a0f1a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // ── Ánh sáng góc trái (tím hồng) ──
  const glow1 = ctx.createRadialGradient(0, 0, 0, 0, 0, 320);
  glow1.addColorStop(0, 'rgba(180, 60, 220, 0.18)');
  glow1.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, W, H);

  // ── Ánh sáng góc phải (cyan xanh) ──
  const glow2 = ctx.createRadialGradient(W, H, 0, W, H, 350);
  glow2.addColorStop(0, 'rgba(0, 180, 255, 0.15)');
  glow2.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // ── Lưới chấm trang trí ──
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  for (let x = 30; x < W; x += 45) {
    for (let y = 30; y < H; y += 45) {
      ctx.beginPath();
      ctx.arc(x, y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Đường viền gradient ──
  const border = ctx.createLinearGradient(0, 0, W, H);
  border.addColorStop(0,   '#b44bdc');
  border.addColorStop(0.5, '#4b8fdc');
  border.addColorStop(1,   '#00c8ff');
  ctx.strokeStyle = border;
  ctx.lineWidth = 2;
  roundRect(ctx, 3, 3, W - 6, H - 6, 20);
  ctx.stroke();

  // ── Header bar ──
  const headerGrad = ctx.createLinearGradient(0, 0, W, 0);
  headerGrad.addColorStop(0, 'rgba(180,75,220,0.3)');
  headerGrad.addColorStop(0.5, 'rgba(75,143,220,0.2)');
  headerGrad.addColorStop(1, 'rgba(0,200,255,0.1)');
  ctx.fillStyle = headerGrad;
  ctx.beginPath();
  ctx.moveTo(3, 3);
  ctx.lineTo(W - 3, 3);
  ctx.lineTo(W - 3, 65);
  ctx.lineTo(3, 65);
  ctx.closePath();
  ctx.fill();

  ctx.font = 'bold 14px NotoSans';
  ctx.fillStyle = 'rgba(200,180,255,0.9)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('*  THONG TIN LIEN HE CHU SO HUU BOT  *', W / 2, 34);

  // Dòng kẻ dưới header
  const lineGrad = ctx.createLinearGradient(0, 0, W, 0);
  lineGrad.addColorStop(0,   'rgba(180,75,220,0)');
  lineGrad.addColorStop(0.3, 'rgba(180,75,220,0.8)');
  lineGrad.addColorStop(0.7, 'rgba(0,200,255,0.8)');
  lineGrad.addColorStop(1,   'rgba(0,200,255,0)');
  ctx.strokeStyle = lineGrad;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, 65);
  ctx.lineTo(W - 40, 65);
  ctx.stroke();

  // ── Avatar bot ──
  const cx = 115, cy = 215;
  const avatarR = 72;

  const avatarGlow = ctx.createRadialGradient(cx, cy, 40, cx, cy, 120);
  avatarGlow.addColorStop(0, 'rgba(180,75,220,0.3)');
  avatarGlow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = avatarGlow;
  ctx.beginPath();
  ctx.arc(cx, cy, 120, 0, Math.PI * 2);
  ctx.fill();

  const ringGrad = ctx.createLinearGradient(cx - avatarR, cy - avatarR, cx + avatarR, cy + avatarR);
  ringGrad.addColorStop(0, '#b44bdc');
  ringGrad.addColorStop(0.5, '#4b8fdc');
  ringGrad.addColorStop(1, '#00c8ff');
  ctx.strokeStyle = ringGrad;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, avatarR + 5, 0, Math.PI * 2);
  ctx.stroke();

  try {
    const buf = await downloadBuffer(botAvatarUrl);
    const img = await loadImage(buf);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, avatarR, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, cx - avatarR, cy - avatarR, avatarR * 2, avatarR * 2);
    ctx.restore();
  } catch {
    ctx.fillStyle = '#1a0a2e';
    ctx.beginPath();
    ctx.arc(cx, cy, avatarR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b44bdc';
    ctx.font = 'bold 40px NotoSans';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('X', cx, cy);
  }

  // Badge BOT
  ctx.fillStyle = 'rgba(75,143,220,0.85)';
  roundRect(ctx, cx - 24, cy + avatarR - 2, 48, 22, 11);
  ctx.fill();
  ctx.font = 'bold 11px NotoSans';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('BOT', cx, cy + avatarR + 9);

  // ── Separator dọc ──
  const sepX = 215;
  const sepG = ctx.createLinearGradient(sepX, 80, sepX, H - 30);
  sepG.addColorStop(0, 'rgba(180,75,220,0)');
  sepG.addColorStop(0.2, 'rgba(180,75,220,0.6)');
  sepG.addColorStop(0.8, 'rgba(0,200,255,0.6)');
  sepG.addColorStop(1, 'rgba(0,200,255,0)');
  ctx.strokeStyle = sepG;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(sepX, 80);
  ctx.lineTo(sepX, H - 30);
  ctx.stroke();

  // ── Text bên phải ──
  const textX = 240;
  ctx.textAlign = 'left';

  // Tên chủ
  const nameGrad = ctx.createLinearGradient(textX, 0, textX + 400, 0);
  nameGrad.addColorStop(0, '#e8d5ff');
  nameGrad.addColorStop(1, '#80d4ff');
  ctx.fillStyle = nameGrad;
  ctx.font = 'bold 36px NotoSans';
  ctx.textBaseline = 'top';
  ctx.fillText('Xiao', textX, 82);

  ctx.font = '13px NotoSans';
  ctx.fillStyle = 'rgba(180,160,220,0.6)';
  ctx.fillText('Chu so huu  |  Bot cua Xiao', textX, 126);

  // Divider
  ctx.strokeStyle = 'rgba(180,75,220,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(textX, 150);
  ctx.lineTo(W - 30, 150);
  ctx.stroke();

  // ── Contact items ──
  const items = [
    { icon: '✉', label: 'EMAIL', value: 'tatuananh311@gmail.com' },
    { icon: '◈', label: 'DISCORD', value: 'xiao.1jing' },
    { icon: '◉', label: 'INSTAGRAM', value: 'xiao.1jing' },
    { icon: '⬡', label: 'WEBSITE', value: 'junybaby.id.vn' },
  ];

  let itemY = 164;
  for (const item of items) {
    // Pill icon
    const pillGrad = ctx.createLinearGradient(textX, itemY, textX + 36, itemY + 26);
    pillGrad.addColorStop(0, 'rgba(180,75,220,0.25)');
    pillGrad.addColorStop(1, 'rgba(0,200,255,0.15)');
    ctx.fillStyle = pillGrad;
    roundRect(ctx, textX, itemY, 36, 26, 7);
    ctx.fill();

    ctx.font = 'bold 13px NotoSans';
    ctx.fillStyle = '#c8aaff';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.icon, textX + 11, itemY + 13);

    // Label nhỏ
    ctx.font = 'bold 10px NotoSans';
    ctx.fillStyle = 'rgba(160,140,200,0.65)';
    ctx.fillText(item.label, textX + 46, itemY + 5);

    // Value
    ctx.font = 'bold 15px NotoSans';
    ctx.fillStyle = '#ddd0ff';
    ctx.fillText(item.value, textX + 46, itemY + 20);

    itemY += 42;
  }

  // ── Footer note ──
  ctx.strokeStyle = 'rgba(100,80,160,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(textX, H - 50);
  ctx.lineTo(W - 30, H - 50);
  ctx.stroke();

  ctx.font = '11px NotoSans';
  ctx.fillStyle = 'rgba(160,140,200,0.45)';
  ctx.textBaseline = 'middle';
  ctx.fillText('Moi van de lien quan den Bot cua Xiao — lien he de duoc xu ly som nhat co the', textX, H - 32);

  // ── Dots trang trí ──
  const dotColors = ['#b44bdc', '#4b8fdc', '#00c8ff'];
  dotColors.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.arc(W - 25 - i * 16, H - 20, 4.5, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  return canvas.toBuffer('image/png');
}

// ===== MODULE =====
module.exports = (client) => {

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'contact') return;

    await interaction.deferReply();

    try {
      const botAvatarUrl = client.user.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true });
      const cardBuf = await generateContactCard(botAvatarUrl);
      const cardName = 'contact_card.png';
      const attachment = new AttachmentBuilder(cardBuf, { name: cardName });

      const embed = new EmbedBuilder()
        .setColor(0xb44bdc)
        .setAuthor({
          name: 'Bot của Xiao · Thông tin liên hệ',
          iconURL: client.user.displayAvatarURL()
        })
        .setDescription([
          '> Mọi vấn đề liên quan đến **Bot của Xiao** vui lòng liên hệ để được xử lý sớm nhất có thể! 🙏',
          '',
          '📧  `tatuananh311@gmail.com`',
          '🔷  **Discord** — `xiao.1jing`',
          '📸  **Instagram** — [xiao.1jing](https://www.instagram.com/xiao.1jing)',
          '🌐  **Website** — [junybaby.id.vn](https://junybaby.id.vn)',
        ].join('\n'))
        .setImage(`attachment://${cardName}`)
        .setFooter({
          text: `Requested by ${interaction.user.username} · Tự xóa sau 10 phút`,
          iconURL: interaction.user.displayAvatarURL()
        })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], files: [attachment] });

    } catch (err) {
      console.error('[CONTACT] Lỗi tạo card:', err.message);

      // Fallback embed nếu canvas lỗi
      const embed = new EmbedBuilder()
        .setColor(0xb44bdc)
        .setAuthor({
          name: 'Bot của Xiao · Thông tin liên hệ',
          iconURL: client.user.displayAvatarURL()
        })
        .setDescription([
          '> Mọi vấn đề liên quan đến **Bot của Xiao** vui lòng liên hệ để được xử lý sớm nhất có thể! 🙏',
          '',
          '📧  `tatuananh311@gmail.com`',
          '🔷  **Discord** — `xiao.1jing`',
          '📸  **Instagram** — [xiao.1jing](https://www.instagram.com/xiao.1jing)',
          '🌐  **Website** — [junybaby.id.vn](https://junybaby.id.vn)',
        ].join('\n'))
        .setFooter({
          text: `Requested by ${interaction.user.username} · Tự xóa sau 10 phút`,
          iconURL: interaction.user.displayAvatarURL()
        })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }

    // Tự xóa sau 10 phút
    setTimeout(async () => {
      try {
        await interaction.deleteReply();
        console.log(`[CONTACT] Đã xóa /contact của ${interaction.user.username}`);
      } catch { /* đã xóa thủ công */ }
    }, 10 * 60 * 1000);
  });

};

module.exports.contactCommands = contactCommands;