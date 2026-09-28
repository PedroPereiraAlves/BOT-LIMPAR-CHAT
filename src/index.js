require('dotenv').config();

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');

const { recordClear } = require('./audit');
const { registerCommands } = require('./register-commands');
const { ClearError, canRecreate, clearMessages, discordCode, isForumLike, recreateChannel } = require('./purge');

const CONFIRM_MS = 60_000;
const PROGRESS_MS = 4_000;

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
  console.error('Preencha DISCORD_TOKEN e CLIENT_ID no arquivo .env.');
  console.error('Copie .env.example para .env e coloque os dados do bot.');
  process.exit(1);
}

const BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageThreads,
].reduce((total, bit) => total | bit, 0n);

const pending = new Map();
const busy = new Set();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Conectado como ${readyClient.user.tag}`);
  console.log(
    `Convite: https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${BOT_PERMISSIONS}&scope=bot%20applications.commands`,
  );

  try {
    await registerCommands({ token, clientId, guildId });
    if (guildId) {
      console.log(`Comando /limpar registrado no servidor ${guildId}.`);
    } else {
      console.warn('GUILD_ID não definido. O comando global pode levar até 1 hora para aparecer.');
    }
  } catch (error) {
    console.error('Falha ao registrar o comando /limpar:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'limpar') {
      await handleLimpar(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleButton(interaction);
    }
  } catch (error) {
    console.error(error);
    await respond(interaction, failureText(error));
  }
});

client.on(Events.Error, (error) => {
  console.error('Erro do cliente:', error);
});

async function handleLimpar(interaction) {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({
      content: 'Esse comando só funciona em um canal de servidor.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.options.getChannel('canal') ?? interaction.channel;
  const mode = interaction.options.getString('modo', true);

  if (!channel || channel.guildId !== interaction.guildId) {
    await interaction.reply({
      content: 'Não encontrei esse canal neste servidor.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const unsupported = unsupportedReason(channel, mode);
  if (unsupported) {
    await interaction.reply({ content: unsupported, flags: MessageFlags.Ephemeral });
    return;
  }

  const permissionError = await missingPermissions(interaction, channel, mode);
  if (permissionError) {
    await interaction.reply({ content: permissionError, flags: MessageFlags.Ephemeral });
    return;
  }

  const nonce = interaction.id;
  pending.set(nonce, {
    userId: interaction.user.id,
    channelId: channel.id,
    mode,
    expires: Date.now() + CONFIRM_MS,
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`limpar:confirm:${nonce}`).setLabel('Confirmar limpeza').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`limpar:cancel:${nonce}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({
    content: describeJob(channel, mode),
    components: [row],
    flags: MessageFlags.Ephemeral,
  });

  setTimeout(async () => {
    if (!pending.delete(nonce)) return;
    await interaction
      .editReply({
        content: 'A confirmação expirou. Use /limpar de novo se ainda quiser limpar o canal.',
        components: [],
      })
      .catch(() => {});
  }, CONFIRM_MS);
}

async function handleButton(interaction) {
  const match = /^limpar:(confirm|cancel):(\d+)$/.exec(interaction.customId ?? '');
  if (!match) return;

  const [, action, nonce] = match;
  const job = pending.get(nonce);

  if (!job || job.expires < Date.now()) {
    pending.delete(nonce);
    await interaction.reply({
      content: 'Essa confirmação não está mais ativa. Use /limpar de novo se ainda quiser limpar o canal.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.user.id !== job.userId) {
    await interaction.reply({
      content: 'Só quem usou o comando pode confirmar.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  pending.delete(nonce);

  if (action === 'cancel') {
    await interaction.update({ content: 'Limpeza cancelada.', components: [] });
    return;
  }

  const channel = await interaction.client.channels.fetch(job.channelId).catch(() => null);
  if (!channel || !('guild' in channel) || channel.guildId !== interaction.guildId) {
    await interaction.update({
      content: 'O canal não existe mais. Nada foi apagado.',
      components: [],
    });
    return;
  }

  const unsupported = unsupportedReason(channel, job.mode);
  if (unsupported) {
    await interaction.update({ content: unsupported, components: [] });
    return;
  }

  const permissionError = await missingPermissions(interaction, channel, job.mode);
  if (permissionError) {
    await interaction.update({ content: permissionError, components: [] });
    return;
  }

  if (busy.has(channel.id)) {
    await interaction.update({
      content: 'Já existe uma limpeza em andamento nesse canal.',
      components: [],
    });
    return;
  }

  busy.add(channel.id);
  const label = `${channel}`;
  const targetName = channel.name;
  const targetId = channel.id;
  const reason = `Limpeza de histórico solicitada por ${interaction.user.username} (${interaction.user.id})`;

  await interaction.update({ content: `Limpando ${label}...`, components: [] });

  try {
    if (job.mode === 'recriar') {
      const clone = await recreateChannel(channel, reason);
      const note = await saveAudit(interaction.guild, auditLines(
        interaction.user,
        job.mode,
        targetName,
        targetId,
        `Canal recriado: ${clone} (\`${clone.id}\`).`,
      ));
      await report(interaction, `Histórico apagado. O canal novo é ${clone}.${note}`);
      console.log(`[limpar] #${targetName} recriado como ${clone.id} por ${interaction.user.username}`);
      return;
    }

    const scope = channel.isThread() ? 'thread' : isForumLike(channel) ? 'forum' : 'channel';
    const reportProgress = createProgress(interaction, label, scope);
    const result = await clearMessages(channel, { onProgress: reportProgress });
    const note = await saveAudit(interaction.guild, auditLines(
      interaction.user,
      job.mode,
      targetName,
      targetId,
      outcomeText(result),
    ));
    await report(interaction, `${resultText(label, result)}${note}`);
    console.log(
      `[limpar] ${label}: ${result.messages} mensagens, ${result.threads} tópicos, ${result.skipped} ignorados. Por ${interaction.user.username}`,
    );
  } catch (error) {
    console.error(error);
    const message = failureText(error);
    const note = await saveAudit(interaction.guild, auditLines(
      interaction.user,
      job.mode,
      targetName,
      targetId,
      message,
    ));
    await report(interaction, `${message}${note}`);
  } finally {
    busy.delete(channel.id);
  }
}

function auditLines(user, mode, targetName, targetId, outcome) {
  const modeLabel = mode === 'recriar' ? 'Recriar canal' : 'Apagar mensagens';
  return [
    '**Limpeza executada**',
    `Usuário: ${user} (\`${user.id}\`)`,
    `Conta: ${user.username}`,
    `Modo: ${modeLabel}`,
    `Canal: #${targetName} (\`${targetId}\`)`,
    `Resultado: ${outcome}`,
  ];
}

function outcomeText(result) {
  if (result.messages === 0 && result.threads === 0 && result.skipped === 0) {
    return result.scope === 'forum' ? 'O canal já estava sem publicações.' : 'O canal já estava sem mensagens.';
  }

  if (result.scope === 'forum') {
    return `${result.threads} publicações apagadas.`;
  }

  const parts = [`${result.messages} mensagens apagadas`];
  if (result.threads > 0) parts.push(`${result.threads} tópicos apagados`);
  if (result.skipped > 0) parts.push(`${result.skipped} itens que o Discord não deixou apagar`);
  return `${parts.join(', ')}.`;
}

async function saveAudit(guild, lines) {
  try {
    await recordClear(guild, lines);
    return '';
  } catch (error) {
    console.error('Falha ao registrar auditoria:', error);
    return '\n\nNão consegui registrar no canal auditoria. O bot precisa poder criar canais e enviar mensagens.';
  }
}

function unsupportedReason(channel, mode) {
  if (mode === 'recriar' && !canRecreate(channel)) {
    if (channel.isThread()) {
      return 'Tópicos não podem ser recriados. Escolha o modo Apagar mensagens.';
    }
    return 'Só é possível recriar canais de texto, anúncio, fórum ou mídia. Para este canal, escolha Apagar mensagens.';
  }

  if (mode === 'mensagens' && !channel.isTextBased() && !isForumLike(channel)) {
    return 'Esse canal não tem histórico de mensagens.';
  }

  return null;
}

async function missingPermissions(interaction, channel, mode) {
  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
  const required = requiredPermissions(channel, mode);
  const userMissing = missingNames(permissionsFor(channel, interaction), required);
  const botMissing = missingNames(channel.permissionsFor(me), required);

  const lines = [];
  if (userMissing.length > 0) {
    lines.push(`Você precisa destas permissões neste canal: ${userMissing.join(', ')}.`);
  }
  if (botMissing.length > 0) {
    lines.push(`O bot precisa destas permissões neste canal: ${botMissing.join(', ')}.`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

function requiredPermissions(channel, mode) {
  if (mode === 'recriar') {
    return [
      [PermissionFlagsBits.ViewChannel, 'Ver canal'],
      [PermissionFlagsBits.ManageChannels, 'Gerenciar canais'],
    ];
  }

  if (isForumLike(channel)) {
    return [
      [PermissionFlagsBits.ViewChannel, 'Ver canal'],
      [PermissionFlagsBits.ReadMessageHistory, 'Ver histórico de mensagens'],
      [PermissionFlagsBits.ManageThreads, 'Gerenciar tópicos'],
    ];
  }

  const required = [
    [PermissionFlagsBits.ViewChannel, 'Ver canal'],
    [PermissionFlagsBits.ReadMessageHistory, 'Ver histórico de mensagens'],
    [PermissionFlagsBits.ManageMessages, 'Gerenciar mensagens'],
  ];

  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
    required.push([PermissionFlagsBits.ManageThreads, 'Gerenciar tópicos']);
  }

  return required;
}

function permissionsFor(channel, interaction) {
  return channel.permissionsFor(interaction.member)
    ?? (interaction.channelId === channel.id ? interaction.memberPermissions : null);
}

function missingNames(perms, required) {
  if (!perms) return required.map(([, name]) => name);
  return required.filter(([flag]) => !perms.has(flag)).map(([, name]) => name);
}

function describeJob(channel, mode) {
  if (mode === 'recriar') {
    return [
      `Isso vai apagar **todo** o histórico de ${channel}.`,
      'O bot cria um canal novo com o mesmo nome, categoria, permissões e posição, e em seguida apaga o canal atual.',
      'O histórico some na hora. O canal passa a ter outro ID: webhooks e integrações ligadas ao ID antigo param de funcionar.',
      'Confirme só se tiver certeza.',
    ].join('\n');
  }

  if (channel.isThread()) {
    return [
      `Isso vai apagar **todas** as mensagens de ${channel}.`,
      'O tópico continua existindo.',
      'Mensagens com mais de 14 dias são apagadas uma por uma. Um histórico grande pode levar bastante tempo, e o bot precisa continuar ligado.',
      'Confirme só se tiver certeza.',
    ].join('\n');
  }

  if (isForumLike(channel)) {
    return [
      `Isso vai apagar **todas** as publicações de ${channel}.`,
      'O fórum e o ID dele continuam os mesmos.',
      'Confirme só se tiver certeza.',
    ].join('\n');
  }

  return [
    `Isso vai apagar **todas** as mensagens e tópicos de ${channel}.`,
    'O canal e o ID dele continuam os mesmos.',
    'Mensagens com mais de 14 dias são apagadas uma por uma. Um histórico grande pode levar bastante tempo, e o bot precisa continuar ligado.',
    'Confirme só se tiver certeza.',
  ].join('\n');
}

function resultText(label, result) {
  if (result.messages === 0 && result.threads === 0 && result.skipped === 0) {
    const empty = result.scope === 'forum'
      ? `${label} já estava sem publicações.`
      : `${label} já estava sem mensagens.`;
    return result.warning ? `${empty}\n${result.warning}` : empty;
  }

  const parts = [`Limpeza de ${label} concluída.`];
  if (result.scope === 'forum') {
    parts.push(`Publicações apagadas: **${result.threads}**.`);
  } else {
    parts.push(`Mensagens apagadas: **${result.messages}**.`);
    if (result.threads > 0) parts.push(`Tópicos apagados: **${result.threads}**.`);
  }
  if (result.skipped > 0) {
    parts.push(`O Discord não deixou apagar **${result.skipped}** item(ns), em geral mensagens de sistema.`);
  }
  if (result.warning) parts.push(result.warning);
  return parts.join('\n');
}

function createProgress(interaction, label, scope) {
  let last = 0;
  return async ({ messages, threads }) => {
    const now = Date.now();
    if (now - last < PROGRESS_MS) return;
    last = now;

    const lines = [`Limpando ${label}...`];
    if (scope === 'forum') {
      lines.push(`Publicações apagadas: **${threads}**.`);
    } else {
      lines.push(`Mensagens apagadas: **${messages}**.`);
      if (threads > 0) lines.push(`Tópicos apagados: **${threads}**.`);
    }

    console.log(`[limpar] ${label} em andamento: ${messages} mensagens, ${threads} tópicos.`);
    await interaction.editReply({ content: lines.join('\n') }).catch(() => {});
  };
}

async function report(interaction, content) {
  try {
    await interaction.editReply({ content, components: [] });
  } catch {
    await interaction.user.send(content).catch(() => {
      console.log(content);
    });
  }
}

async function respond(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => report(interaction, content));
    return;
  }
  await interaction.reply(payload).catch(() => {});
}

function failureText(error) {
  if (error instanceof ClearError) return error.message;

  const code = discordCode(error);
  if (code === 50013) return 'O bot não tem permissão para fazer isso nesse canal.';
  if (code === 50001) return 'O bot não consegue acessar esse canal.';
  if (code === 10003) return 'Esse canal não existe mais.';
  return 'Não foi possível limpar o canal. O detalhe ficou no terminal do bot.';
}

client.login(token);
