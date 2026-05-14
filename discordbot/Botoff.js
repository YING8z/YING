/**
 * botoff.js — Lệnh /botoff để tắt bot từ xa
 *
 * Chỉ Owner của server (guild owner) mới dùng được.
 * Bot sẽ gửi thông báo xác nhận rồi tắt sau 3 giây.
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    MessageFlags,
} = require('discord.js');

const botoffCommands = [
    new SlashCommandBuilder()
        .setName('botoff')
        .setDescription('🔴 Tắt bot (chỉ owner server)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .toJSON(),
];

module.exports = (client) => {
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== 'botoff') return;

        // Chỉ guild owner mới được dùng
        if (interaction.user.id !== interaction.guild.ownerId) {
            return interaction.reply({
                content: '❌ Chỉ **owner server** mới được dùng lệnh này.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('🔴 Bot đang tắt...')
            .setDescription('Bot sẽ offline sau **3 giây**.\nĐể bật lại, vui lòng khởi động thủ công trên máy chủ.')
            .addFields({ name: '👤 Thực hiện bởi', value: `${interaction.user}`, inline: true })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });

        console.log(`[BOTOFF] Lệnh tắt bot được thực hiện bởi ${interaction.user.tag} (${interaction.user.id}) trong server ${interaction.guild.name} (${interaction.guild.id})`);

        setTimeout(() => {
            console.log('[BOTOFF] Bot đang tắt theo lệnh /botoff...');
            client.destroy();
            process.exit(0);
        }, 3000);
    });
};

module.exports.botoffCommands = botoffCommands;