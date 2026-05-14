const fs = require('fs');
const path = require('path');
const {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  MessageFlags,
  ChannelType,
} = require('discord.js');

// ── Config ─────────────────────────────────────────────────────────────────
const BANNED_WORDS_FILE      = path.join(__dirname, 'banned_words.json');
const GUILD_BADWORDS_FILE    = path.join(__dirname, 'guild_badwords.json');
const WARNING_DELETE_MS      = 15_000;
// Score tối thiểu để tính là vi phạm – chỉ dùng score, không tin vào flagged field của Groq
const DEFAULT_THRESHOLD      = Number(process.env.TOXIC_THRESHOLD         || 0.88);
const AUTO_APPROVE_COUNT     = Number(process.env.BADWORD_AUTO_APPROVE_COUNT || 3);
const GROQ_COOLDOWN_MS       = Number(process.env.GROQ_COOLDOWN_MS        || 10 * 60 * 1000);
const GROQ_MIN_INTERVAL_MS   = Number(process.env.GROQ_MIN_INTERVAL_MS    || 2_000);
const CACHE_MAX              = 500;

// Từ ngắn (≤3 ký tự) được chia 2 nhóm:
// TOXIC_SHORT   : từ tục ngắn → match exact token (không fuzzy, không prefix, không substring dài)
// SAFE_SHORT    : từ viết tắt thông thường → match exact token
// Từ không thuộc nhóm nào mà ≤3 ký tự → bỏ qua hoàn toàn (quá ngắn, dễ false positive)
const TOXIC_SHORT = new Set(['lon','dit','cut','cuc','cac','cc','cl','dm','vl','vc','nc','cb','vkl','loz','lol']);
const SAFE_SHORT  = new Set(['dm','cl','cc','vl','vc','nc','cb','vkl']); // alias, giữ để tham chiếu

// Stopwords tiếng Việt thường gặp – không dùng làm candidate cho AI
const STOPWORDS = new Set([
  'la','va','thi','nhe','roi','nha','the','cho','tao','moi',
  'de','cua','vay','anh','chi','ban','toi','that','di','da',
  'ra','len','xuong','vao','ra','qua','lai','cung','dang',
]);

// ── State ──────────────────────────────────────────────────────────────────
let globalWords     = [];   // từ đã normalize (không dấu) — dùng cho extractCandidateWord
let globalRawWords  = [];   // từ gốc (giữ dấu) — dùng cho findMatchedWord
let guildData     = {};
let groqCooldownUntil = 0;
let groqLastCallAt    = 0;
let groqQueueRunning  = false;

const groqQueue = [];
const groqCache = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LEET_MAP = {
  // Leet speak số → chữ
  '0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','@':'a','$':'s','!':'i',
};

// Ký tự trông giống chữ khác (bypass trick) — xử lý TRƯỚC khi lowercase
const LOOKALIKE_MAP = {
  'I' : 'l',  // I hoa → l thường  ("Iồn" → "lồn")
  'Ɩ' : 'l',
  'ⅼ' : 'l',
  'ｌ' : 'l',
  '|' : 'l',
  'О' : 'O',  // chữ O Cyrillic → O Latin
  'о' : 'o',  // chữ o Cyrillic → o Latin
  'а' : 'a',  // chữ a Cyrillic → a Latin
  'е' : 'e',  // chữ e Cyrillic → e Latin
};

/**
 * Kiểm tra từ có chứa dấu tiếng Việt không.
 * Dùng để tự động phân loại từ cấm vào lớp "có dấu" hay "không dấu".
 */
function hasToneMark(text) {
  // Các combining diacritics của tiếng Việt (NFD) hoặc ký tự có dấu thông thường
  const decomposed = String(text).normalize('NFD');
  return /[\u0300-\u036f]/.test(decomposed) || /[đĐ]/.test(text);
}

/**
 * Normalize KHÔNG dấu — dùng cho từ bypass (viết tắt, leet, không dấu).
 * Xóa hết dấu tiếng Việt để bắt: "lon", "l0n", "dm", "vcl"...
 */
function normalizeNoDiacritic(text) {
  return String(text || '')
    .split('').map((ch) => LOOKALIKE_MAP[ch] || ch).join('')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .split('').map((ch) => LEET_MAP[ch] || ch).join('')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/(.)\1{2,}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize CÓ DẤU — dùng cho từ có dấu tiếng Việt rõ ràng.
 * Giữ nguyên dấu, chỉ lowercase + dọn ký tự đặc biệt.
 * Dùng để phân biệt "mà" ≠ "má" ≠ "mạ".
 */
function normalizeWithDiacritic(text) {
  return String(text || '')
    .split('').map((ch) => LOOKALIKE_MAP[ch] || ch).join('')
    .toLowerCase()
    // Chuẩn hoá về NFC để nhất quán
    .normalize('NFC')
    // Bỏ ký tự đặc biệt nhưng GIỮ chữ tiếng Việt có dấu
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/(.)\1{2,}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * normalizeText — alias dùng chung cho các chỗ khác trong code
 * (extractCandidateWord, loadGlobalWords, v.v.) — giữ hành vi cũ.
 */
function normalizeText(text) {
  return normalizeNoDiacritic(text);
}

function distanceLevenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0)
  );
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[a.length][b.length];
}

/**
 * Kiểm tra xem nội dung có chứa từ cấm không.
 *
 * ── 2 LỚP KIỂM TRA ────────────────────────────────────────────────────────
 *
 * Lớp A — CÓ DẤU (từ có dấu tiếng Việt, ví dụ: "lồn", "địt", "mẹ mày"):
 *   → match trên text GIỮ DẤU → "mà" KHÔNG match "má"
 *   → CŨNG check bypass không dấu: "lon" bị bắt bởi "lồn"
 *     nhưng chỉ khi token trong chat thực sự không có dấu
 *
 * Lớp B — KHÔNG DẤU (viết tắt, leet: "dm", "vcl", "l0n"):
 *   → match trên text ĐÃ STRIP DẤU
 *   → nhưng chỉ match khi token trong chat KHÔNG có dấu
 *     → "mà" (có dấu) sẽ KHÔNG match "ma" (không dấu)
 *
 * Trả về từ cấm khớp đầu tiên (dạng gốc), hoặc null.
 */
function findMatchedWord(content, guildWords) {
  if (!content) return null;

  // globalRawWords: từ gốc (có dấu), guildWords: cũng từ gốc
  const allWords = [...new Set([...globalRawWords, ...guildWords])];

  // tokensA[i] và tokensB[i] luôn align theo vị trí trong câu
  const tokensA = normalizeWithDiacritic(content).split(' ').filter(Boolean); // có dấu
  const tokensB = normalizeNoDiacritic(content).split(' ').filter(Boolean);   // không dấu

  for (const word of allWords) {
    const isAccented = hasToneMark(word);

    if (isAccented) {
      // ── Lớp A: từ có dấu ────────────────────────────────────────────────
      const normWord   = normalizeWithDiacritic(word);
      const wTokensA   = normWord.split(' ').filter(Boolean);

      // A1: match chính xác có dấu
      if (_phraseMatch(wTokensA, tokensA)) return word;

      // A2: check bypass không dấu (vd: "lon" bypass "lồn")
      //     chỉ match nếu token trong chat thực sự không có dấu
      const normWordB  = normalizeNoDiacritic(word);
      const wTokensB   = normWordB.split(' ').filter(Boolean);
      if (_phraseMatchNoAccent(wTokensB, tokensA, tokensB)) return word;

    } else {
      // ── Lớp B: từ không dấu ─────────────────────────────────────────────
      const normWord = normalizeNoDiacritic(word);
      const wTokens  = normWord.split(' ').filter(Boolean);
      const wLen     = normWord.length;

      if (wTokens.length > 1) {
        // Phrase không dấu: chỉ match khi token trong chat cũng không có dấu
        if (_phraseMatchNoAccent(wTokens, tokensA, tokensB)) return word;
      } else {
        // Single token không dấu: loop có index để đối chiếu với tokensA
        for (let i = 0; i < tokensB.length; i++) {
          // Bỏ qua nếu token này trong chat có dấu tiếng Việt
          // → "mà" có dấu → tokensA[i]="mà" → hasToneMark → skip → không match "ma"
          if (hasToneMark(tokensA[i])) continue;

          const t = tokensB[i];
          if (wLen <= 3) {
            if (t === normWord) return word;
          } else {
            if (t === normWord) return word;
            if (t.startsWith(normWord) && t.length - wLen <= 2) return word;
            if (wLen >= 5 && t.length >= 5 && distanceLevenshtein(t, normWord) <= 1) return word;
          }
        }
      }
    }
  }

  return null;
}

/** Phrase match strict trên mảng token. */
function _phraseMatch(wordTokens, tokens) {
  const pl = wordTokens.length;
  for (let i = 0; i <= tokens.length - pl; i++) {
    let ok = true;
    for (let j = 0; j < pl; j++) {
      if (tokens[i + j] !== wordTokens[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Phrase match không dấu: chỉ khớp khi KHÔNG có token nào trong đoạn đó
 * có dấu tiếng Việt (tokensA dùng để kiểm tra dấu, tokensB để so sánh).
 */
function _phraseMatchNoAccent(wordTokensB, tokensA, tokensB) {
  const pl = wordTokensB.length;
  for (let i = 0; i <= tokensB.length - pl; i++) {
    let anyAccented = false;
    for (let j = 0; j < pl; j++) {
      if (hasToneMark(tokensA[i + j])) { anyAccented = true; break; }
    }
    if (anyAccented) continue;

    let ok = true;
    for (let j = 0; j < pl; j++) {
      if (tokensB[i + j] !== wordTokensB[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function extractCandidateWord(content, knownWords) {
  const tokens = normalizeText(content).split(' ').filter((t) => t.length >= 2);
  for (const token of tokens) {
    if (STOPWORDS.has(token)) continue;
    if (knownWords.includes(token)) continue;
    return token;
  }
  return normalizeText(content).slice(0, 32).trim() || null;
}

// ── File I/O ───────────────────────────────────────────────────────────────
function loadGlobalWords() {
  try {
    if (!fs.existsSync(BANNED_WORDS_FILE))
      fs.writeFileSync(BANNED_WORDS_FILE, JSON.stringify([], null, 2));
    const parsed = JSON.parse(fs.readFileSync(BANNED_WORDS_FILE, 'utf8'));
    if (Array.isArray(parsed)) {
      globalRawWords = parsed.filter(Boolean);                          // giữ nguyên dấu
      globalWords    = parsed.map((w) => normalizeText(w)).filter(Boolean); // không dấu
    } else {
      globalRawWords = [];
      globalWords    = [];
    }
    console.log(`[BADWORD] Loaded ${globalRawWords.length} global words.`);
  } catch (err) {
    console.error('[BADWORD] Load global words failed:', err.message);
    globalRawWords = [];
    globalWords    = [];
  }
}

function loadGuildData() {
  try {
    if (!fs.existsSync(GUILD_BADWORDS_FILE))
      fs.writeFileSync(GUILD_BADWORDS_FILE, JSON.stringify({}, null, 2));
    guildData = JSON.parse(fs.readFileSync(GUILD_BADWORDS_FILE, 'utf8')) || {};
  } catch (err) {
    console.error('[BADWORD] Load guild data failed:', err.message);
    guildData = {};
  }
}

function saveGuildData() {
  fs.writeFileSync(GUILD_BADWORDS_FILE, JSON.stringify(guildData, null, 2));
}

/**
 * Đảm bảo guild có đầy đủ các trường, bao gồm cả exemptChannels / exemptMembers.
 */
function ensureGuild(guildId) {
  if (!guildData[guildId]) guildData[guildId] = {};
  const g = guildData[guildId];
  if (!Array.isArray(g.words))           g.words = [];
  if (!Array.isArray(g.ignored))         g.ignored = [];
  if (!g.pending || typeof g.pending !== 'object') g.pending = {};
  if (!Array.isArray(g.exemptChannels))  g.exemptChannels = [];
  if (!Array.isArray(g.exemptMembers))   g.exemptMembers  = [];
  return g;
}

// ── Exempt helpers ─────────────────────────────────────────────────────────
function isExempt(message, guild) {
  if (guild.exemptChannels.includes(message.channelId))       return true;
  if (guild.exemptMembers.includes(message.author.id))        return true;
  // Kiểm tra luôn thread parent channel nếu có
  if (message.channel?.parentId &&
      guild.exemptChannels.includes(message.channel.parentId)) return true;
  return false;
}

// ── Groq Cache ─────────────────────────────────────────────────────────────
function getCached(content) {
  return groqCache.has(content) ? groqCache.get(content) : undefined;
}
function setCache(content, result) {
  if (groqCache.size >= CACHE_MAX) groqCache.delete(groqCache.keys().next().value);
  groqCache.set(content, result);
}

// ── Groq Queue ─────────────────────────────────────────────────────────────
function enqueueGroq(content, onResult) {
  const cached = getCached(content);
  if (cached !== undefined) {
    Promise.resolve().then(() => onResult(cached));
    return;
  }
  groqQueue.push({ content, onResult });
  processGroqQueue();
}

async function processGroqQueue() {
  if (groqQueueRunning) return;
  groqQueueRunning = true;

  while (groqQueue.length > 0) {
    if (Date.now() < groqCooldownUntil) {
      console.warn(
        `[BADWORD] Cooldown còn ${Math.round((groqCooldownUntil - Date.now()) / 1000)}s, xóa queue.`
      );
      groqQueue.length = 0;
      break;
    }

    const elapsed = Date.now() - groqLastCallAt;
    if (elapsed < GROQ_MIN_INTERVAL_MS) await sleep(GROQ_MIN_INTERVAL_MS - elapsed);

    const task = groqQueue.shift();
    if (!task) continue;

    groqLastCallAt = Date.now();
    let result = null;
    try {
      result = await fetchGroqModeration(task.content);
      if (result) setCache(task.content, result);
    } catch (err) {
      console.error('[BADWORD] Groq error:', err.message);
    }
    try { task.onResult(result); } catch { /* ignore */ }
  }

  groqQueueRunning = false;
}

// ── Groq API ───────────────────────────────────────────────────────────────
async function fetchGroqModeration(content) {
  if (!process.env.GROQ_API_KEY) return null;
  if (Date.now() < groqCooldownUntil)  return null;

  const prompt = [
    'Bạn là bộ lọc nội dung chat tiếng Việt.',
    'Nhiệm vụ: đánh giá mức độ thô tục / chửi bậy của đoạn chat bên dưới.',
    '',
    'Quy tắc chấm điểm score (0.0 → 1.0):',
    '  0.0–0.3 : hoàn toàn bình thường, không có gì xúc phạm',
    '  0.3–0.6 : hơi tiêu cực hoặc có từ nhạy cảm nhưng không rõ ràng',
    '  0.6–0.85: có từ thô tục nhẹ hoặc ngữ cảnh không rõ',
    '  0.85–1.0: chửi bậy rõ ràng, từ tục tiểu, viết tắt xấu (cl, vl, dmm, cc, cặc, lồn, địt, đụ...)',
    '',
    'LƯU Ý QUAN TRỌNG:',
    '  - Từ "đi", "di", "đã", "da", "cái", "con" dùng bình thường → score thấp',
    '  - Chỉ cho score cao khi chắc chắn 100% là từ tục/chửi bậy',
    '  - Ngữ cảnh giao tiếp bình thường → KHÔNG phạt',
    '',
    'Chỉ trả về JSON, không giải thích: {"score":number,"reason":"string"}',
    '',
    `CHAT: "${content}"`,
  ].join('\n');

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model      : process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
        temperature: 0,
        max_tokens : 120,
        messages   : [{ role: 'user', content: prompt }],
      }),
    });

    if (res.status === 429) {
      groqCooldownUntil = Date.now() + GROQ_COOLDOWN_MS;
      console.warn(`[BADWORD] Rate limit → cooldown ${Math.round(GROQ_COOLDOWN_MS / 60000)} phút`);
      return null;
    }
    if (!res.ok) return null;

    const data  = await res.json();
    const text  = data?.choices?.[0]?.message?.content;
    if (!text) return null;

    const clean  = text.replace(/```json[\s\S]*?```|```/g, '').trim();
    const parsed = JSON.parse(clean);
    const score  = Math.max(0, Math.min(1, Number(parsed?.score) || 0));

    // Chỉ dùng score để quyết định – không tin vào parsed.flagged
    // vì Groq hay trả flagged=true ngay cả khi score thấp
    return {
      provider: 'groq',
      flagged : score >= DEFAULT_THRESHOLD,
      score,
      reason  : String(parsed?.reason || 'toxic'),
    };
  } catch (err) {
    console.error('[BADWORD] Groq fetch error:', err.message);
    return null;
  }
}

// ── Misc ───────────────────────────────────────────────────────────────────
function sendWarning(message, text) {
  message.channel
    .send(`⚠️ ${message.author}, ${text}`)
    .then((msg) => setTimeout(() => msg.delete().catch(() => {}), WARNING_DELETE_MS))
    .catch(() => {});
}

function upsertPending(guildId, candidate, details) {
  const guild = ensureGuild(guildId);
  if (guild.ignored.includes(candidate)) return { autoApproved: false };

  const existing = guild.pending[candidate] || { count: 0, reasons: [], lastScore: 0 };
  existing.count      += 1;
  existing.lastScore   = Math.max(existing.lastScore || 0, details.score || 0);
  existing.preview     = details.preview || existing.preview;
  if (details.reason && !existing.reasons.includes(details.reason))
    existing.reasons.push(details.reason);
  guild.pending[candidate] = existing;

  let autoApproved = false;
  if (existing.count >= AUTO_APPROVE_COUNT && !guild.words.includes(candidate)) {
    guild.words.push(candidate);
    delete guild.pending[candidate];
    autoApproved = true;
  }

  saveGuildData();
  return { autoApproved };
}

function requireManager(interaction) {
  return (
    interaction.member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  );
}

// ── Slash Commands ─────────────────────────────────────────────────────────
const badwordCommands = [
  new SlashCommandBuilder()
    .setName('badword')
    .setDescription('⚙️ Quản lý từ cấm')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

    // ── Từ cấm ──────────────────────────────────────────────────────────
    .addSubcommand((s) =>
      s.setName('add')
        .setDescription('Thêm từ cấm vào danh sách của server')
        .addStringOption((o) =>
          o.setName('word').setDescription('Từ cần cấm').setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s.setName('remove')
        .setDescription('Xóa từ cấm khỏi danh sách của server')
        .addStringOption((o) =>
          o.setName('word').setDescription('Từ cần xóa').setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s.setName('list').setDescription('Xem danh sách từ cấm của server')
    )

    // ── Pending / review ────────────────────────────────────────────────
    .addSubcommand((s) =>
      s.setName('review').setDescription('Xem danh sách từ đang chờ duyệt (AI đề xuất)')
    )
    .addSubcommand((s) =>
      s.setName('approve')
        .setDescription('Duyệt từ đang pending vào danh sách cấm')
        .addStringOption((o) =>
          o.setName('word').setDescription('Từ cần duyệt').setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s.setName('ignore')
        .setDescription('Bỏ qua từ pending (không cấm)')
        .addStringOption((o) =>
          o.setName('word').setDescription('Từ cần bỏ qua').setRequired(true)
        )
    )

    // ── Exempt channel ───────────────────────────────────────────────────
    .addSubcommand((s) =>
      s.setName('exempt-channel-add')
        .setDescription('Thêm channel được miễn kiểm duyệt từ cấm')
        .addChannelOption((o) =>
          o.setName('channel')
            .setDescription('Channel cần miễn')
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildForum,
              ChannelType.GuildAnnouncement
            )
            .setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s.setName('exempt-channel-remove')
        .setDescription('Xóa channel khỏi danh sách miễn kiểm duyệt')
        .addStringOption((o) =>
          o.setName('channel_id')
            .setDescription('ID của channel cần xóa (dùng /badword exempt-list để xem)')
            .setRequired(true)
        )
    )

    // ── Exempt member ────────────────────────────────────────────────────
    .addSubcommand((s) =>
      s.setName('exempt-member-add')
        .setDescription('Thêm thành viên được miễn kiểm duyệt từ cấm')
        .addUserOption((o) =>
          o.setName('user').setDescription('Thành viên cần miễn').setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s.setName('exempt-member-remove')
        .setDescription('Xóa thành viên khỏi danh sách miễn kiểm duyệt')
        .addUserOption((o) =>
          o.setName('user').setDescription('Thành viên cần xóa').setRequired(true)
        )
    )

    // ── Exempt list ──────────────────────────────────────────────────────
    .addSubcommand((s) =>
      s.setName('exempt-list')
        .setDescription('Xem danh sách channel và thành viên được miễn kiểm duyệt')
    )

    .toJSON(),
];

// ── Load ───────────────────────────────────────────────────────────────────
loadGlobalWords();
loadGuildData();

// ── Export ─────────────────────────────────────────────────────────────────
module.exports = (client) => {
  // ── Interaction handler ────────────────────────────────────────────────
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'badword') return;
    if (!requireManager(interaction)) {
      return interaction.reply({
        content: '❌ Bạn cần quyền **Quản lý server** để dùng lệnh này.',
        flags  : MessageFlags.Ephemeral,
      });
    }

    const sub    = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const guild  = ensureGuild(guildId);

    // ── /badword add ────────────────────────────────────────────────────
    if (sub === 'add') {
      const raw  = interaction.options.getString('word', true);
      const word = normalizeText(raw);
      if (!word) return interaction.reply({ content: '❌ Từ không hợp lệ.', flags: MessageFlags.Ephemeral });
      if (guild.words.includes(word))
        return interaction.reply({ content: `⚠️ \`${word}\` đã có trong danh sách.`, flags: MessageFlags.Ephemeral });

      guild.words.push(word);
      // Xóa khỏi ignored nếu có
      guild.ignored = guild.ignored.filter((w) => w !== word);
      saveGuildData();
      return interaction.reply({ content: `✅ Đã thêm \`${word}\` vào danh sách từ cấm.`, flags: MessageFlags.Ephemeral });
    }

    // ── /badword remove ─────────────────────────────────────────────────
    if (sub === 'remove') {
      const word = normalizeText(interaction.options.getString('word', true));
      const idx  = guild.words.indexOf(word);
      if (idx === -1)
        return interaction.reply({ content: `⚠️ Không tìm thấy \`${word}\` trong danh sách.`, flags: MessageFlags.Ephemeral });

      guild.words.splice(idx, 1);
      saveGuildData();
      return interaction.reply({ content: `✅ Đã xóa \`${word}\` khỏi danh sách từ cấm.`, flags: MessageFlags.Ephemeral });
    }

    // ── /badword list ────────────────────────────────────────────────────
    if (sub === 'list') {
      const combined = [...new Set([...globalWords, ...guild.words])];
      if (!combined.length)
        return interaction.reply({ content: 'ℹ️ Danh sách từ cấm trống.', flags: MessageFlags.Ephemeral });

      const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('🚫 Danh sách từ cấm')
        .addFields(
          { name: `🌐 Global (${globalWords.length})`, value: globalWords.join(', ') || '*(trống)*', inline: false },
          { name: `🏠 Server (${guild.words.length})`,  value: guild.words.join(', ')  || '*(trống)*', inline: false }
        )
        .setFooter({ text: `Tổng: ${combined.length} từ` })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ── /badword review ──────────────────────────────────────────────────
    if (sub === 'review') {
      const entries = Object.entries(guild.pending);
      if (!entries.length)
        return interaction.reply({ content: 'ℹ️ Không có từ nào đang chờ duyệt.', flags: MessageFlags.Ephemeral });

      const lines = entries.map(([word, info]) =>
        `• \`${word}\` — xuất hiện **${info.count}** lần, score **${(info.lastScore || 0).toFixed(2)}**`
      );
      const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('🕐 Từ đang chờ duyệt (AI đề xuất)')
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Dùng /badword approve hoặc /badword ignore để xử lý.' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ── /badword approve ─────────────────────────────────────────────────
    if (sub === 'approve') {
      const word = normalizeText(interaction.options.getString('word', true));
      if (!guild.pending[word])
        return interaction.reply({ content: `⚠️ \`${word}\` không có trong danh sách pending.`, flags: MessageFlags.Ephemeral });

      guild.words.push(word);
      delete guild.pending[word];
      saveGuildData();
      return interaction.reply({ content: `✅ Đã duyệt và cấm từ \`${word}\`.`, flags: MessageFlags.Ephemeral });
    }

    // ── /badword ignore ──────────────────────────────────────────────────
    if (sub === 'ignore') {
      const word = normalizeText(interaction.options.getString('word', true));
      delete guild.pending[word];
      if (!guild.ignored.includes(word)) guild.ignored.push(word);
      saveGuildData();
      return interaction.reply({ content: `✅ Đã bỏ qua từ \`${word}\` (sẽ không bị đề xuất lại).`, flags: MessageFlags.Ephemeral });
    }

    // ── /badword exempt-channel-add ──────────────────────────────────────
    if (sub === 'exempt-channel-add') {
      const channel = interaction.options.getChannel('channel', true);
      if (guild.exemptChannels.includes(channel.id))
        return interaction.reply({ content: `⚠️ ${channel} đã trong danh sách miễn rồi.`, flags: MessageFlags.Ephemeral });

      guild.exemptChannels.push(channel.id);
      saveGuildData();
      return interaction.reply({ content: `✅ Đã thêm ${channel} vào danh sách **miễn kiểm duyệt**.\nMọi tin nhắn trong channel này sẽ không bị lọc từ cấm.`, flags: MessageFlags.Ephemeral });
    }

    // ── /badword exempt-channel-remove ──────────────────────────────────
    if (sub === 'exempt-channel-remove') {
      const channelId = interaction.options.getString('channel_id', true).trim();
      const idx = guild.exemptChannels.indexOf(channelId);
      if (idx === -1)
        return interaction.reply({ content: `⚠️ Không tìm thấy channel ID \`${channelId}\` trong danh sách miễn.`, flags: MessageFlags.Ephemeral });

      guild.exemptChannels.splice(idx, 1);
      saveGuildData();
      return interaction.reply({ content: `✅ Đã xóa <#${channelId}> khỏi danh sách miễn kiểm duyệt.`, flags: MessageFlags.Ephemeral });
    }

    // ── /badword exempt-member-add ───────────────────────────────────────
    if (sub === 'exempt-member-add') {
      const user = interaction.options.getUser('user', true);
      if (guild.exemptMembers.includes(user.id))
        return interaction.reply({ content: `⚠️ ${user} đã trong danh sách miễn rồi.`, flags: MessageFlags.Ephemeral });

      guild.exemptMembers.push(user.id);
      saveGuildData();
      return interaction.reply({ content: `✅ Đã thêm ${user} vào danh sách **miễn kiểm duyệt**.\nTin nhắn của người này sẽ không bị lọc từ cấm.`, flags: MessageFlags.Ephemeral });
    }

    // ── /badword exempt-member-remove ───────────────────────────────────
    if (sub === 'exempt-member-remove') {
      const user = interaction.options.getUser('user', true);
      const idx  = guild.exemptMembers.indexOf(user.id);
      if (idx === -1)
        return interaction.reply({ content: `⚠️ ${user} không có trong danh sách miễn.`, flags: MessageFlags.Ephemeral });

      guild.exemptMembers.splice(idx, 1);
      saveGuildData();
      return interaction.reply({ content: `✅ Đã xóa ${user} khỏi danh sách miễn kiểm duyệt.`, flags: MessageFlags.Ephemeral });
    }

    // ── /badword exempt-list ─────────────────────────────────────────────
    if (sub === 'exempt-list') {
      const channelMentions = guild.exemptChannels.length
        ? guild.exemptChannels.map((id) => `<#${id}> (\`${id}\`)`).join('\n')
        : '*(trống)*';
      const memberMentions = guild.exemptMembers.length
        ? guild.exemptMembers.map((id) => `<@${id}> (\`${id}\`)`).join('\n')
        : '*(trống)*';

      const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ Danh sách miễn kiểm duyệt từ cấm')
        .addFields(
          { name: `📢 Channel được miễn (${guild.exemptChannels.length})`, value: channelMentions, inline: false },
          { name: `👤 Thành viên được miễn (${guild.exemptMembers.length})`, value: memberMentions, inline: false }
        )
        .setFooter({ text: 'Dùng /badword exempt-channel-remove hoặc exempt-member-remove để xóa.' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  });

  // ── Message handler ────────────────────────────────────────────────────
  client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot || !message.content?.trim()) return;

    const guild = ensureGuild(message.guild.id);

    // Kiểm tra exempt trước – bỏ qua nếu channel hoặc member được miễn
    if (isExempt(message, guild)) return;

    // Static word check
    const matchedWord = findMatchedWord(message.content, guild.words);
    if (matchedWord) {
      console.log(`[BADWORD] Static match: "${matchedWord}"`);
      try { await message.delete(); } catch { return; }
      sendWarning(message, `tin nhắn chứa từ cấm (**${matchedWord}**) và đã bị xóa.`);
      return;
    }

    // Groq AI check
    enqueueGroq(message.content, async (mod) => {
      if (!mod?.flagged) return;

      console.log(`[BADWORD] 🚩 Groq flagged | score=${mod.score?.toFixed(2)}`);
      try { await message.delete(); } catch { /* đã bị xóa */ }
      sendWarning(message, `nội dung vi phạm (score ${(mod.score || 0).toFixed(2)}) đã bị xóa.`);

      const knownWords = [...globalWords, ...guild.words];
      const candidate  = extractCandidateWord(message.content, knownWords);
      if (!candidate) return;

      const result = upsertPending(message.guild.id, candidate, {
        score  : mod.score,
        provider: mod.provider,
        reason : mod.reason,
        preview: message.content.slice(0, 120),
      });

      if (result.autoApproved) {
        message.channel
          .send(`🤖 Tự động thêm \`${candidate}\` vào danh sách cấm (xuất hiện ${AUTO_APPROVE_COUNT} lần).`)
          .catch(() => {});
      }
    });
  });
};

module.exports.badwordCommands = badwordCommands;

/**
 * Quét lại tin nhắn trong 1 channel, xóa nếu vi phạm.
 * Dùng khi bot khởi động để dọn tin nhắn cũ trong vòng X phút.
 */
module.exports.scanHistory = async (channel, guildId, minutesBack = 5) => {
  try {
    const guildCfg = ensureGuild(guildId);
    const messages = await channel.messages.fetch({ limit: 100 });
    const cutoff   = Date.now() - minutesBack * 60 * 1000;

    const recent = [...messages.values()].filter(
      (m) => !m.author.bot && m.createdTimestamp >= cutoff && m.content?.trim()
    );

    if (!recent.length) return;

    console.log(`[BADWORD][SCAN] #${channel.name} — ${recent.length} tin nhắn cần kiểm tra`);

    for (const message of recent) {
      if (isExempt(message, guildCfg)) continue;

      const matched = findMatchedWord(message.content, guildCfg.words);
      if (matched) {
        console.log(`[BADWORD][SCAN] Static match: "${matched}" — xóa tin của ${message.author.tag}`);
        try { await message.delete(); } catch (e) {
          console.error(`[BADWORD][SCAN] Xóa thất bại:`, e.message);
          continue;
        }
        sendWarning(message, `tin nhắn cũ chứa từ cấm (**${matched}**) đã bị xóa.`);
        continue;
      }

      if (process.env.GROQ_API_KEY) {
        await sleep(GROQ_MIN_INTERVAL_MS);
        const mod = await fetchGroqModeration(message.content);
        if (mod?.flagged) {
          console.log(`[BADWORD][SCAN] 🚩 Groq flagged | score=${mod.score?.toFixed(2)} — xóa tin của ${message.author.tag}`);
          try { await message.delete(); } catch (e) {
            console.error(`[BADWORD][SCAN] Xóa thất bại:`, e.message);
            continue;
          }
          sendWarning(message, `nội dung vi phạm cũ (score ${(mod.score || 0).toFixed(2)}) đã bị xóa.`);
        }
      }
    }
  } catch (err) {
    console.error(`[BADWORD][SCAN] Lỗi channel #${channel.name}:`, err.message);
  }
};