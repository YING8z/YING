const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

const CATEGORY_LABELS = {
  music: '🎵 Phát nhạc',
  download: '⬇️ Tải về',
  scheduler: '📅 Lên lịch',
  moderation: '🛡 Quản lý',
  welcome: '👋 Chào mừng',
  utility: '🧰 Tiện ích',
  lookup: '🔎 Tra cứu',
  game: '🎮 Trò chơi',
  stream: '📺 Stream video',
  other: '📦 Khác',
};

const COMMAND_CATEGORY = {
  play: 'music',
  pause: 'music',
  resume: 'music',
  stop: 'music',
  skip: 'music',
  'download-setup': 'download',
  youtube: 'download',
  tiktok: 'download',
  douyin: 'download',
  'convert-setup': 'download',
  convert: 'download',
  schedule: 'scheduler',
  purge: 'moderation',
  welcome: 'welcome',
  ping: 'utility',
  contact: 'utility',
  lookup: 'lookup',
  setlookup: 'lookup',
  badword: 'moderation',
  wordchain: 'game',
  help: 'utility',
  botoff: 'moderation',
  stream: 'stream',
  streamstop: 'stream',
  streamskip: 'stream',
  streamqueue: 'stream',
  streamclear: 'stream',
  streaminfo: 'stream',
  streamsync: 'stream',
};

const MANAGER_ONLY_COMMANDS = new Set([
  'schedule',
  'purge',
  'welcome',
  'setlookup',
  'badword',
  'download-setup',
  'convert-setup',
  'botoff',
]);

const MANAGER_ONLY_SUBCOMMANDS = {
  wordchain: new Set(['setup', 'remove', 'stop']),
  badword: new Set([
    'add', 'remove', 'list',
    'review', 'approve', 'ignore',
    'exempt-channel-add', 'exempt-channel-remove',
    'exempt-member-add', 'exempt-member-remove',
    'exempt-list',
  ]),
};

const SUBCOMMAND_DESCRIPTIONS = {
  badword: {
    'add': 'Thêm từ cấm',
    'remove': 'Xóa từ cấm',
    'list': 'Xem danh sách từ cấm',
    'review': 'Xem từ AI đề xuất đang chờ duyệt',
    'approve': 'Duyệt từ pending vào danh sách cấm',
    'ignore': 'Bỏ qua từ pending',
    'exempt-channel-add': 'Miễn channel khỏi kiểm duyệt',
    'exempt-channel-remove': 'Xóa channel khỏi danh sách miễn',
    'exempt-member-add': 'Miễn thành viên khỏi kiểm duyệt',
    'exempt-member-remove': 'Xóa thành viên khỏi danh sách miễn',
    'exempt-list': 'Xem danh sách channel/thành viên được miễn',
  },
};

const MANAGER_TAG = ' (quản lý viên)';

const HELP_COMMANDS = [
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('📚 Xem toàn bộ lệnh bot theo từng mục')
    .toJSON(),
];

function getSubcommands(command) {
  const options = Array.isArray(command.options) ? command.options : [];
  return options
    .filter((opt) => opt.type === 1 && opt.name)
    .map((opt) => opt.name);
}

function commandRequiresManager(command) {
  if (!command?.name) return false;
  if (MANAGER_ONLY_COMMANDS.has(command.name)) return true;

  const permRaw = command.default_member_permissions;
  if (permRaw === undefined || permRaw === null) return false;
  const permNum = Number(permRaw);
  return Number.isFinite(permNum) && permNum > 0;
}

function buildGroupedCommands(allCommands = []) {
  const grouped = new Map();

  for (const category of Object.keys(CATEGORY_LABELS)) {
    grouped.set(category, []);
  }

  for (const cmd of allCommands) {
    if (!cmd?.name) continue;
    const category = COMMAND_CATEGORY[cmd.name] || 'other';
    const subcommands = getSubcommands(cmd);
    grouped.get(category).push({
      name: cmd.name,
      description: cmd.description || 'Không có mô tả',
      subcommands,
      managerOnly: commandRequiresManager(cmd),
    });
  }

  for (const [, list] of grouped) {
    list.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  }

  return grouped;
}

function toFieldValue(commandItems) {
  return commandItems.map((cmd) => {
    const managerLabel = cmd.managerOnly ? MANAGER_TAG : '';
    const base = `• \`/${cmd.name}\`${managerLabel} — ${cmd.description}`;
    if (!cmd.subcommands.length) return base;

    const managerSubcommands = MANAGER_ONLY_SUBCOMMANDS[cmd.name] || new Set();
    const descMap = SUBCOMMAND_DESCRIPTIONS[cmd.name] || {};

    const subList = cmd.subcommands.map((sub) => {
      const subLabel = managerSubcommands.has(sub) ? MANAGER_TAG : '';
      const subDesc = descMap[sub] ? ` — ${descMap[sub]}` : '';
      return `\`/${cmd.name} ${sub}\`${subLabel}${subDesc}`;
    }).join('\n    ');

    return `${base}\n    ↳ ${subList}`;
  }).join('\n');
}

const helpHandler = (client, getCommands = () => []) => {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'help') return;

    const grouped = buildGroupedCommands(getCommands());
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📚 Danh sách lệnh hiện có')
      .setDescription('Bot đang hỗ trợ các lệnh sau, đã chia theo từng mục:')
      .setFooter({
        text: `Tổng cộng ${getCommands().length} lệnh`,
      })
      .setTimestamp();

    for (const [categoryKey, label] of Object.entries(CATEGORY_LABELS)) {
      const items = grouped.get(categoryKey) || [];
      if (!items.length) continue;
      embed.addFields({
        name: `${label} (${items.length})`,
        value: toFieldValue(items),
      });
    }

    await interaction.reply({ embeds: [embed] });
    setTimeout(async () => {
      try {
        await interaction.deleteReply();
      } catch {
        // Tin nhắn có thể đã bị xóa thủ công hoặc bot thiếu quyền
      }
    }, 2 * 60 * 1000);
  });
};

module.exports = helpHandler;
module.exports.helpCommands = HELP_COMMANDS;