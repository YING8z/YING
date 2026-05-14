// ===== WORD CHAIN MODULE (NỐI TỪ TIẾNG VIỆT) - GROQ AI VALIDATOR =====
const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// GROQ CONFIG — dùng GROQ_API_KEY từ .env
// Free tier: 14,400 req/ngày, 30 req/phút
// ─────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? '';
const GROQ_MODEL = process.env.GROQ_MODEL ?? 'llama-3.1-8b-instant';
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const AI_ENABLED = Boolean(GROQ_API_KEY);

// Cache kết quả AI: word → { valid: bool, meaning: string }
// Tránh gọi API lặp lại cùng một từ trong suốt uptime của bot
const aiCache = new Map();

/**
 * Hỏi Groq/Llama: từ này có phải từ/cụm từ tiếng Việt hợp lệ không?
 * Trả về { valid: boolean, meaning: string }
 */
async function checkWordWithAI(word) {
    if (aiCache.has(word)) return aiCache.get(word);
    if (!AI_ENABLED) return { valid: false, meaning: '' };

    const prompt = `Kiểm tra từ tiếng Việt: "${word}"

Trả lời JSON theo đúng format này (không thêm gì khác):
{"valid": true, "meaning": "nghĩa ngắn"}
hoặc:
{"valid": false, "meaning": ""}

Quy tắc:
- valid là true nếu đây là từ/cụm từ tiếng Việt thực sự (kể cả từ lóng, địa danh, tên riêng VN)
- valid là false nếu là từ nước ngoài, vô nghĩa, hoặc tục tĩu
- meaning là 1 câu giải thích ngắn tiếng Việt (để trống nếu valid=false)`;

    try {
        const res = await fetch(GROQ_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`,
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                temperature: 0,
                max_tokens: 128,
                messages: [
                    {
                        role: 'system',
                        content: 'Chỉ trả lời bằng JSON hợp lệ. Không dùng markdown. Không giải thích. Giá trị "valid" phải là boolean true hoặc false.',
                    },
                    { role: 'user', content: prompt },
                ],
            }),
        });

        if (!res.ok) {
            console.error(`[Groq] HTTP ${res.status}:`, await res.text());
            return { valid: false, meaning: '' };
        }

        const data = await res.json();
        const rawText = (data?.choices?.[0]?.message?.content ?? '{}')
            .replace(/```json|```/g, '')  // bỏ markdown fence
            .replace(/[\r\n]/g, ' ')      // bỏ newline
            .trim();

        // Parse an toàn — nếu AI trả sai format thì không crash
        let parsed = {};
        try {
            parsed = JSON.parse(rawText);
        } catch (_) {
            // Thử extract bằng regex nếu JSON bị lỗi
            const validMatch = rawText.match(/"valid"\s*:\s*(true|false)/i);
            const meaningMatch = rawText.match(/"meaning"\s*:\s*"([^"]*)"/i);
            parsed = {
                valid: validMatch ? validMatch[1].toLowerCase() === 'true' : false,
                meaning: meaningMatch ? meaningMatch[1] : '',
            };
        }

        const result = {
            valid: Boolean(parsed.valid),
            meaning: typeof parsed.meaning === 'string' ? parsed.meaning.trim() : '',
        };

        aiCache.set(word, result);
        return result;
    } catch (err) {
        console.error('[Groq] Lỗi gọi API:', err);
        return { valid: false, meaning: '' };
    }
}


// ===================== LOAD WORD BANK =====================
let WORD_BANK = [];
let WORD_SET = new Set();

const VALID_VIETNAMESE_REGEX = /^[a-zA-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúýĂăĐđĨĩŨũƠơƯưẠ-ỹ\s]+$/;

function loadWordBank() {
    try {
        const filePath = path.join(__dirname, 'data', 'Viet74K.txt');
        if (!fs.existsSync(filePath)) {
            console.warn('⚠️ Không tìm thấy data/Viet74K.txt — dùng fallback');
            WORD_BANK = ['an toàn', 'toàn thắng', 'thắng lợi', 'lợi ích', 'ích quốc'];
            WORD_SET = new Set(WORD_BANK);
            return;
        }

        WORD_BANK = fs.readFileSync(filePath, 'utf8')
            .split('\n')
            .map(l => l.trim().toLowerCase())
            .filter(l => {
                if (l.length < 2) return false;
                if (l.startsWith('#')) return false;
                if (!VALID_VIETNAMESE_REGEX.test(l)) return false;
                const parts = l.split(' ');
                if (parts.length > 6) return false;
                if (parts.some(p => p.length === 0)) return false;
                return true;
            });

        WORD_SET = new Set(WORD_BANK);
        console.log(`✅ Loaded ${WORD_BANK.length.toLocaleString('vi-VN')} từ từ Viet74K.txt`);
        console.log(AI_ENABLED
            ? `✅ Groq AI validator: BẬT (${GROQ_MODEL})`
            : `⚠️  Groq AI validator: TẮT (chưa set GROQ_API_KEY)`
        );
    } catch (err) {
        console.error('❌ Lỗi load word bank:', err);
        WORD_BANK = ['an toàn', 'toàn thắng', 'thắng lợi'];
        WORD_SET = new Set(WORD_BANK);
    }
}

// ===================== CONFIG =====================
const CONFIG_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(CONFIG_DIR, 'wordchain_config.json');
let guildConfig = new Map();

function ensureDir() {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}
function loadConfig() {
    ensureDir();
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            guildConfig = new Map(Object.entries(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))));
            console.log(`✅ Load config wordchain: ${guildConfig.size} server`);
        }
    } catch (_) { }
}
function saveConfig() {
    ensureDir();
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(Object.fromEntries(guildConfig), null, 2)); }
    catch (e) { console.error('Save config error', e); }
}

loadWordBank();
loadConfig();

// ===================== GAME STATE =====================
const games = new Map();
const TIMEOUT_MS = 30_000;
const BOT_DELAY_MIN = 1300;
const BOT_DELAY_MAX = 2700;
const RANK_EMOJIS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

// ===================== UTILS =====================
const normalizeWord = (w) => w.trim().toLowerCase().replace(/\s+/g, ' ');
const getLastSyl = (p) => { const a = normalizeWord(p).split(' '); return a[a.length - 1]; };
const getFirstSyl = (p) => normalizeWord(p).split(' ')[0];
const isValidChain = (prev, next) => getLastSyl(prev) === getFirstSyl(next);
const isInDictionary = (w) => WORD_SET.has(normalizeWord(w));

const buildScoreText = (scores) => {
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return 'Chưa có ai ghi điểm ✨';
    return sorted.map(([id, s], i) => `${RANK_EMOJIS[i] ?? '🏅'} <@${id}> — **${s}** điểm`).join('\n');
};

// ===================== BOT WORD CHOOSER =====================
function botChooseWord(lastWord, usedWords) {
    const target = getLastSyl(lastWord);

    // Chỉ lấy từ đúng 2 âm tiết
    const candidates = WORD_BANK.filter(w =>
        w.split(' ').length === 2 &&
        getFirstSyl(w) === target &&
        !usedWords.has(w)
    );
    if (!candidates.length) return null;

    const scored = candidates.map(w => {
        const nxt = getLastSyl(w);
        const nextOpts = WORD_BANK.filter(x =>
            x.split(' ').length === 2 &&
            getFirstSyl(x) === nxt &&
            !usedWords.has(x) &&
            x !== w
        ).length;
        return { word: w, nextOpts };
    });

    const withOpts = scored.filter(s => s.nextOpts > 0);
    const finalPool = withOpts.length ? withOpts : scored;

    finalPool.sort((a, b) => a.nextOpts - b.nextOpts);
    const topN = Math.min(5, finalPool.length);
    return finalPool[Math.floor(Math.random() * topN)].word;
}

// ===================== TIMEOUT HELPER =====================
function startTurnTimeout(channelId, channel) {
    return setTimeout(async () => {
        const g = games.get(channelId);
        if (!g?.active) return;
        g.active = false;
        games.delete(channelId);
        await channel.send({
            embeds: [new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('⏰ Hết Giờ! Game kết thúc.')
                .setDescription(`Từ cuối: **${g.currentWord}**\nKhông có ai nối trong **${TIMEOUT_MS / 1000} giây**.`)
                .addFields({ name: '🏆 Bảng Xếp Hạng Cuối', value: buildScoreText(g.scores) })
                .setTimestamp()],
        });
    }, TIMEOUT_MS);
}

// ===================== COMMANDS =====================
const wordchainCommands = [
    new SlashCommandBuilder()
        .setName('wordchain')
        .setDescription('🔤 Trò chơi Nối Từ Tiếng Việt')
        .addSubcommand(s => s.setName('setup').setDescription('⚙️ Thiết lập kênh chơi (chỉ quản lý)'))
        .addSubcommand(s => s.setName('remove').setDescription('🗑️ Xóa thiết lập kênh'))
        .addSubcommand(s => s.setName('start').setDescription('▶️ Bắt đầu game'))
        .addSubcommand(s => s.setName('stop').setDescription('⏹️ Dừng game'))
        .addSubcommand(s => s.setName('hint').setDescription('💡 Gợi ý từ (trừ 1 điểm)'))
        .addSubcommand(s => s.setName('score').setDescription('🏆 Xem bảng điểm'))
        .addSubcommand(s => s.setName('skip').setDescription('⏭️ Bot nối thay (trừ 1 điểm)'))
        .toJSON(),
];

// ===================== MODULE EXPORT =====================
module.exports = (client) => {

    // ══════════════════════════════════════════
    //  MESSAGE LISTENER — người chơi nhập từ
    // ══════════════════════════════════════════
    client.on('messageCreate', async (message) => {
        if (message.author.bot || !message.guild) return;

        const config = guildConfig.get(message.guild.id);
        if (!config || config.gameChannelId !== message.channel.id) return;

        const g = games.get(message.channel.id);
        if (!g?.active) return;

        // Bỏ qua tin nhắn mới nếu đang chờ Groq AI validate từ trước
        if (g.pendingValidation) return;

        const input = normalizeWord(message.content);

        // Validate ký tự hợp lệ
        if (!VALID_VIETNAMESE_REGEX.test(input)) return;
        const syls = input.split(' ');
        if (syls.length > 6 || syls.some(s => s.length === 0)) return;

        // ── CHECK 1: Nối đúng luật (sai → reject ngay, không cần AI) ──
        if (!isValidChain(g.currentWord, input)) {
            return message.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle('❌ Nối Sai!')
                    .setDescription(
                        `Từ tiếp theo phải bắt đầu bằng tiếng **"${getLastSyl(g.currentWord)}"**\n` +
                        `Bạn nhập **${input}** (bắt đầu bằng "${getFirstSyl(input)}")`
                    )],
            });
        }

        // ── CHECK 2: Từ đã dùng rồi ──
        if (g.usedWords.has(input)) {
            return message.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0xFEE75C)
                    .setTitle('⚠️ Từ Đã Dùng Rồi!')
                    .setDescription(`**${input}** đã xuất hiện trong game này, chọn từ khác nhé!`)],
            });
        }

        // ── CHECK 3: Từ điển → Groq AI fallback ──────────────────────
        const inDict = isInDictionary(input);

        if (!inDict) {
            if (!AI_ENABLED) {
                // Không có Groq AI → reject
                return message.reply({
                    embeds: [new EmbedBuilder()
                        .setColor(0xED4245)
                        .setTitle('❌ Từ Không Có Trong Từ Điển')
                        .setDescription(
                            `**${input}** không có trong từ điển.\n` +
                            `*(Set \`GROQ_API_KEY\` để bật AI kiểm tra từ ngoài từ điển)*`
                        )],
                });
            }

            // Pause timeout + đánh dấu đang chờ AI
            if (g.timeout) { clearTimeout(g.timeout); g.timeout = null; }
            g.pendingValidation = true;

            const checkingMsg = await message.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('🤖 Groq AI đang kiểm tra...')
                    .setDescription(
                        `**"${input}"** không có trong từ điển 74K từ.\n` +
                        `Groq AI đang xác minh đây có phải tiếng Việt hợp lệ không...`
                    )
                    .setFooter({ text: '⏸️ Timeout tạm dừng trong lúc kiểm tra' })],
            });

            let aiResult;
            try {
                aiResult = await checkWordWithAI(input);
            } catch (_) {
                aiResult = { valid: false, meaning: '' };
            } finally {
                g.pendingValidation = false;
            }

            // Groq AI: KHÔNG hợp lệ
            if (!aiResult.valid) {
                g.timeout = startTurnTimeout(message.channel.id, message.channel);
                await checkingMsg.edit({
                    embeds: [new EmbedBuilder()
                        .setColor(0xED4245)
                        .setTitle('❌ Groq AI: Từ Không Hợp Lệ')
                        .setDescription(
                            `**"${input}"** không được công nhận là từ tiếng Việt hợp lệ.\n` +
                            `Hãy thử từ khác!`
                        )
                        .setFooter({ text: '▶️ Timeout đã tiếp tục • Kiểm tra bởi Groq AI (Llama)' })],
                });
                return;
            }

            // Groq AI: HỢP LỆ → thêm vào WORD_SET để cache trong session
            WORD_SET.add(input);
            await checkingMsg.edit({
                embeds: [new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('✅ Groq AI xác nhận hợp lệ!')
                    .setDescription(
                        `**"${input}"**` +
                        (aiResult.meaning ? `\n📖 *${aiResult.meaning}*` : '') +
                        `\n\nTừ này không có trong từ điển nhưng được Groq AI (Llama) xác nhận!`
                    )
                    .setFooter({ text: 'Kiểm tra bởi Groq AI (Llama)' })],
            });
            // Tiếp tục xử lý bình thường bên dưới
        }

        // ✅ Từ hợp lệ (qua từ điển hoặc qua Groq AI) — cập nhật state
        g.usedWords.add(input);
        g.currentWord = input;
        g.scores[message.author.id] = (g.scores[message.author.id] ?? 0) + 1;
        g.streak = (g.streak ?? 0) + 1;
        g.lastActivity = Date.now();
        if (g.timeout) clearTimeout(g.timeout);
        g.timeout = null;

        // Bot suy nghĩ rồi nối từ
        const delay = BOT_DELAY_MIN + Math.random() * (BOT_DELAY_MAX - BOT_DELAY_MIN);
        setTimeout(async () => {
            const cur = games.get(message.channel.id);
            if (!cur?.active) return;

            const botWord = botChooseWord(cur.currentWord, cur.usedWords);

            // Bot bí → người chơi thắng
            if (!botWord) {
                cur.active = false;
                games.delete(message.channel.id);
                return message.channel.send({
                    embeds: [new EmbedBuilder()
                        .setColor(0xFEE75C)
                        .setTitle('🎉 BẠN ĐÃ THẮNG! Bot bí từ rồi!')
                        .setDescription(
                            `Bot không tìm được từ bắt đầu bằng **"${getLastSyl(cur.currentWord)}"**\n` +
                            `Chúc mừng tất cả người chơi! 🥳`
                        )
                        .addFields({ name: '🏆 Bảng Xếp Hạng', value: buildScoreText(cur.scores) })
                        .setFooter({ text: `Tổng cộng ${cur.usedWords.size} từ đã được dùng` })
                        .setTimestamp()],
                });
            }

            cur.usedWords.add(botWord);
            cur.currentWord = botWord;

            await message.channel.send({
                embeds: [new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('🤖 Bot đã nối!')
                    .setDescription(
                        `**Bạn:** ${input}  →  **${getLastSyl(input)}**\n` +
                        `**Bot:** **${botWord}**  →  **${getLastSyl(botWord)}**`
                    )
                    .addFields(
                        { name: '🎯 Tiếp theo', value: `Bắt đầu bằng **"${getLastSyl(botWord)}"**`, inline: true },
                        { name: '📊 Tổng từ', value: `${cur.usedWords.size}`, inline: true },
                        { name: '🔥 Chuỗi', value: `${cur.streak}`, inline: true },
                    )
                    .setFooter({ text: `Đến lượt bạn • ${TIMEOUT_MS / 1000} giây` })
                    .setTimestamp()],
            });

            cur.timeout = startTurnTimeout(message.channel.id, message.channel);
        }, delay);
    });

    // ══════════════════════════════════════════
    //  INTERACTION HANDLER — slash commands
    // ══════════════════════════════════════════
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand() || interaction.commandName !== 'wordchain') return;

        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;
        const channelId = interaction.channel.id;
        const isManager =
            interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
            interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);

        // ── SETUP ──
        if (sub === 'setup') {
            if (!isManager) return interaction.reply({ content: '❌ Chỉ quản lý mới dùng được!', ephemeral: true });
            guildConfig.set(guildId, { gameChannelId: channelId });
            saveConfig();
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0x00FFAA)
                    .setTitle('✅ Setup Thành Công')
                    .setDescription(
                        `Kênh **${interaction.channel.name}** đã được thiết lập.\n` +
                        `Dùng **/wordchain start** để bắt đầu!\n\n` +
                        (AI_ENABLED
                            ? '🤖 **Groq AI validator: BẬT** — từ ngoài từ điển sẽ được AI kiểm tra tự động'
                            : '⚠️ **Groq AI validator: TẮT** — thêm `GROQ_API_KEY` vào `.env` để bật')
                    )],
            });
        }

        // ── REMOVE ──
        if (sub === 'remove') {
            if (!isManager) return interaction.reply({ content: '❌ Chỉ quản lý!', ephemeral: true });
            const eg = games.get(channelId);
            if (eg) { if (eg.timeout) clearTimeout(eg.timeout); games.delete(channelId); }
            guildConfig.delete(guildId);
            saveConfig();
            return interaction.reply({ content: '✅ Đã xóa thiết lập kênh.', ephemeral: true });
        }

        // Guard: phải dùng trong kênh đã setup
        const config = guildConfig.get(guildId);
        if (!config || config.gameChannelId !== channelId) {
            return interaction.reply({
                content: '❌ Chỉ dùng được trong kênh đã setup! Dùng **/wordchain setup** trước.',
                ephemeral: true,
            });
        }

        // ── START ──
        if (sub === 'start') {
            if (games.has(channelId)) {
                return interaction.reply({ content: '⚠️ Game đang chạy rồi! Dùng **/wordchain stop** để dừng trước.', ephemeral: true });
            }

            const pool = WORD_BANK.filter(w => w.split(' ').length === 2);
            const startWord = pool.length
                ? pool[Math.floor(Math.random() * pool.length)]
                : WORD_BANK[Math.floor(Math.random() * WORD_BANK.length)];

            const gs = {
                active: true, currentWord: startWord,
                usedWords: new Set([startWord]),
                scores: {}, streak: 0,
                lastActivity: Date.now(),
                timeout: null, startedBy: interaction.user.id,
                pendingValidation: false,
            };
            games.set(channelId, gs);
            gs.timeout = startTurnTimeout(channelId, interaction.channel);

            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('🎮 GAME NỐI TỪ BẮT ĐẦU!')
                    .setDescription(
                        `**Từ khởi đầu:** **${startWord}**\n` +
                        `🎯 Nối từ bắt đầu bằng: **"${getLastSyl(startWord)}"**`
                    )
                    .addFields(
                        { name: '📖 Luật chơi', value: 'Nhắn từ/cụm từ tiếng Việt bắt đầu bằng tiếng cuối của từ trước', inline: false },
                        { name: '⏱️ Thời gian mỗi lượt', value: `${TIMEOUT_MS / 1000} giây`, inline: true },
                        { name: '🤖 Groq Validator', value: AI_ENABLED ? 'Bật ✅' : 'Tắt ❌', inline: true },
                    )
                    .setFooter({ text: `Game bởi ${interaction.user.username}` })
                    .setTimestamp()],
            });
        }

        const g = games.get(channelId);
        if (!g?.active) {
            return interaction.reply({ content: '❌ Chưa có game đang chạy!', ephemeral: true });
        }

        // ── STOP ──
        if (sub === 'stop') {
            if (!isManager && g.startedBy !== interaction.user.id) {
                return interaction.reply({ content: '❌ Chỉ người tạo hoặc quản lý!', ephemeral: true });
            }
            if (g.timeout) clearTimeout(g.timeout);
            games.delete(channelId);
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle('⏹️ Game Đã Dừng')
                    .setDescription(`Kết thúc sớm sau **${g.usedWords.size}** từ.`)
                    .addFields({ name: '🏆 Bảng Điểm Cuối', value: buildScoreText(g.scores) })
                    .setTimestamp()],
            });
        }

        // ── HINT ──
        if (sub === 'hint') {
            const target = getLastSyl(g.currentWord);
            const hints = WORD_BANK.filter(w => getFirstSyl(w) === target && !g.usedWords.has(w)).slice(0, 6);
            if (!hints.length) {
                return interaction.reply({ content: '😱 Không còn gợi ý nào! Thử /wordchain skip nhé.', ephemeral: true });
            }
            if ((g.scores[interaction.user.id] ?? 0) > 0) g.scores[interaction.user.id]--;
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0xFEE75C)
                    .setTitle(`💡 Gợi Ý — bắt đầu bằng "${target}"`)
                    .setDescription(hints.map(w => `• **${w}**`).join('\n'))
                    .setFooter({ text: 'Đã trừ 1 điểm (nếu có)' })],
                ephemeral: true,
            });
        }

        // ── SCORE ──
        if (sub === 'score') {
            const remaining = WORD_BANK.filter(w =>
                getFirstSyl(w) === getLastSyl(g.currentWord) && !g.usedWords.has(w)
            ).length;
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0xFEE75C)
                    .setTitle('🏆 Bảng Xếp Hạng')
                    .setDescription(buildScoreText(g.scores))
                    .addFields(
                        { name: '🔡 Từ hiện tại', value: `**${g.currentWord}**`, inline: true },
                        { name: '🎯 Cần nối bằng', value: `**"${getLastSyl(g.currentWord)}"**`, inline: true },
                        { name: '📊 Đã dùng', value: `${g.usedWords.size} từ`, inline: true },
                        { name: '🔢 Từ còn khả dụng', value: `~${remaining} từ`, inline: true },
                        { name: '🔥 Chuỗi', value: `${g.streak}`, inline: true },
                        { name: '🤖 Groq AI', value: AI_ENABLED ? 'Bật ✅' : 'Tắt ❌', inline: true },
                    )
                    .setTimestamp()],
            });
        }

        // ── SKIP ──
        if (sub === 'skip') {
            if ((g.scores[interaction.user.id] ?? 0) > 0) g.scores[interaction.user.id]--;
            const botWord = botChooseWord(g.currentWord, g.usedWords);
            if (!botWord) {
                return interaction.reply({
                    content: `😱 Cả bot cũng bí từ bắt đầu bằng **"${getLastSyl(g.currentWord)}"**! Bạn thắng rồi!`,
                });
            }
            if (g.timeout) clearTimeout(g.timeout);
            g.usedWords.add(botWord);
            g.currentWord = botWord;
            g.timeout = startTurnTimeout(channelId, interaction.channel);
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0xEB459E)
                    .setTitle('⏭️ Bot Nối Thay')
                    .setDescription(
                        `**Bot chọn:** **${botWord}**\n` +
                        `🎯 Tiếp theo bắt đầu bằng: **"${getLastSyl(botWord)}"**`
                    )
                    .setFooter({ text: 'Đã trừ 1 điểm (nếu có)' })
                    .setTimestamp()],
            });
        }
    });
};

module.exports.wordchainCommands = wordchainCommands;