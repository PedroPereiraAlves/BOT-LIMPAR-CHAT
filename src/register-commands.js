require('dotenv').config();

const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  InteractionContextType,
} = require('discord.js');

const command = new SlashCommandBuilder()
  .setName('limpar')
  .setDescription('Apaga todo o histórico de mensagens de um canal.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .setContexts(InteractionContextType.Guild)
  .addStringOption((option) =>
    option
      .setName('modo')
      .setDescription('Como o histórico será apagado.')
      .setRequired(true)
      .addChoices(
        { name: 'Recriar canal (apaga tudo na hora)', value: 'recriar' },
        { name: 'Apagar mensagens (mantém o canal)', value: 'mensagens' },
      ),
  )
  .addChannelOption((option) =>
    option
      .setName('canal')
      .setDescription('Canal que será limpo. Se omitido, usa o canal atual.')
      .setRequired(false)
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.GuildForum,
        ChannelType.GuildMedia,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
        ChannelType.GuildVoice,
        ChannelType.GuildStageVoice,
      ),
  );

async function registerCommands({ token, clientId, guildId }) {
  const rest = new REST({ version: '10' }).setToken(token);
  const body = [command.toJSON()];
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, { body });
}

if (require.main === module) {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId) {
    console.error('Preencha DISCORD_TOKEN e CLIENT_ID no arquivo .env.');
    process.exit(1);
  }

  registerCommands({ token, clientId, guildId })
    .then(() => {
      console.log(guildId ? `Comando /limpar registrado no servidor ${guildId}.` : 'Comando /limpar registrado globalmente.');
    })
    .catch((error) => {
      console.error('Falha ao registrar o comando:', error);
      process.exit(1);
    });
}

module.exports = { registerCommands };
