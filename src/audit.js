const { ChannelType, PermissionFlagsBits } = require('discord.js');

const AUDIT_CHANNEL_NAME = 'auditoria';

async function ensureAuditChannel(guild) {
  await guild.channels.fetch();

  const existing = guild.channels.cache.find(
    (channel) => channel.name === AUDIT_CHANNEL_NAME && channel.isTextBased() && !channel.isThread(),
  );
  if (existing) return existing;

  return guild.channels.create({
    name: AUDIT_CHANNEL_NAME,
    type: ChannelType.GuildText,
    topic: 'Registro de quem executou o comando /limpar.',
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: guild.client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ],
    reason: 'Canal de auditoria do comando /limpar',
  });
}

async function recordClear(guild, lines) {
  const channel = await ensureAuditChannel(guild);
  await channel.send({ content: lines.join('\n') });
}

module.exports = { recordClear };
