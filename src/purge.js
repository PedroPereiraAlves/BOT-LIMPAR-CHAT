const { ChannelType } = require('discord.js');

const BULK_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 - 60 * 1000;

const RECREATE_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

class ClearError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClearError';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function discordCode(error) {
  return error?.code ?? error?.rawError?.code;
}

function retryDelayMs(error) {
  const rateLimited = error?.name?.includes('RateLimit') || error?.status === 429 || error?.httpStatus === 429;
  if (!rateLimited) return null;

  if (error?.name?.includes('RateLimit') && Number.isFinite(error.retryAfter)) {
    return error.retryAfter + 250;
  }

  const seconds = Number(error.retryAfter ?? error.rawError?.retry_after ?? 1);
  if (!Number.isFinite(seconds)) return 1000;
  return Math.ceil(seconds * 1000) + 250;
}

function isForumLike(channel) {
  return channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia;
}

function canRecreate(channel) {
  return RECREATE_TYPES.has(channel.type) && !channel.isThread();
}

async function deleteSingle(message) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await message.delete();
      return true;
    } catch (error) {
      const code = discordCode(error);
      if (code === 10008 || code === 50021 || code === 50013 || code === 50001) return false;

      const wait = retryDelayMs(error);
      if (wait != null && attempt < 5) {
        await sleep(wait);
        continue;
      }

      console.error(`Não apaguei a mensagem ${message.id}:`, error.message);
      return false;
    }
  }

  return false;
}

async function purgeMessages(channel, { onProgress } = {}) {
  const skippedIds = new Set();
  let previousIds = '';
  let messages = 0;
  let skipped = 0;

  if (channel.isThread?.() && channel.archived) {
    await channel.setArchived(false).catch((error) => {
      console.warn(`Não desarquivei o tópico ${channel.id}: ${error.message}`);
    });
  }

  for (;;) {
    const fetched = await channel.messages.fetch({ limit: 100 });
    const batch = fetched.filter((message) => !skippedIds.has(message.id));
    if (batch.size === 0) break;

    const ids = [...batch.keys()].join(',');
    if (ids === previousIds) break;
    previousIds = ids;

    const cutoff = Date.now() - BULK_MAX_AGE_MS;
    const recent = batch.filter((message) => message.createdTimestamp >= cutoff);
    const old = batch.filter((message) => message.createdTimestamp < cutoff);
    let recentLeft = [...recent.values()];

    if (recentLeft.length >= 2) {
      try {
        const removed = await channel.bulkDelete(recent, true);
        messages += removed.size;
        recentLeft = recentLeft.filter((message) => !removed.has(message.id));
      } catch (error) {
        const wait = retryDelayMs(error);
        if (wait != null) await sleep(wait);
        if (discordCode(error) !== 50034 && wait == null) {
          console.error(`Falha no apagamento em lote de #${channel.name}:`, error.message);
        }
      }
    }

    for (const message of [...recentLeft, ...old.values()]) {
      const removed = await deleteSingle(message);
      if (removed) messages += 1;
      else {
        skipped += 1;
        skippedIds.add(message.id);
      }
      await onProgress?.({ messages, threads: 0 });
    }

    await onProgress?.({ messages, threads: 0 });
  }

  return { messages, threads: 0, skipped };
}

async function deleteThread(thread) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await thread.delete();
      return true;
    } catch (error) {
      const code = discordCode(error);
      if (code === 10003 || code === 10008 || code === 50013 || code === 50001) return false;

      const wait = retryDelayMs(error);
      if (wait != null && attempt < 5) {
        await sleep(wait);
        continue;
      }

      console.error(`Não apaguei o tópico ${thread.id}:`, error.message);
      return false;
    }
  }

  return false;
}

async function deleteThreadList(threads, stats, onProgress, processed) {
  for (const thread of threads) {
    if (processed.has(thread.id)) continue;
    processed.add(thread.id);

    const removed = await deleteThread(thread);
    if (removed) stats.threads += 1;
    else stats.skipped += 1;
    await onProgress?.({ messages: stats.messages, threads: stats.threads });
  }
}

async function deleteArchivedThreads(channel, type, stats, onProgress, processed) {
  let before;
  const seen = new Set();

  for (;;) {
    const archived = await channel.threads.fetchArchived({
      type,
      fetchAll: type === 'private',
      before,
      limit: 100,
    });
    const threads = [...archived.threads.values()];
    if (threads.length === 0) return;
    if (threads.every((thread) => seen.has(thread.id))) return;

    for (const thread of threads) seen.add(thread.id);
    await deleteThreadList(threads, stats, onProgress, processed);
    if (!archived.hasMore) return;

    const oldest = threads.reduce((current, thread) => {
      const time = thread.archivedAt?.getTime();
      if (time == null) return current;
      if (!current || time < current.time) return { time, date: thread.archivedAt };
      return current;
    }, null);

    if (!oldest?.date) return;
    before = oldest.date;
  }
}

async function deleteAllThreads(channel, { onProgress, messages = 0 } = {}) {
  const stats = { messages, threads: 0, skipped: 0, warning: undefined };
  const processed = new Set();
  const active = await channel.threads.fetchActive();
  await deleteThreadList([...active.threads.values()], stats, onProgress, processed);

  await deleteArchivedThreads(channel, 'public', stats, onProgress, processed);

  try {
    await deleteArchivedThreads(channel, 'private', stats, onProgress, processed);
  } catch (error) {
    stats.warning =
      'Não consegui listar os tópicos privados arquivados. Confira se o bot tem a permissão Gerenciar tópicos.';
    console.error(`Falha ao buscar tópicos privados de #${channel.name}:`, error.message);
  }

  return stats;
}

async function clearMessages(channel, { onProgress } = {}) {
  if (isForumLike(channel)) {
    const stats = await deleteAllThreads(channel, { onProgress });
    return {
      messages: 0,
      threads: stats.threads,
      skipped: stats.skipped,
      warning: stats.warning,
      scope: 'forum',
    };
  }

  if (channel.isThread()) {
    const stats = await purgeMessages(channel, { onProgress });
    return { ...stats, scope: 'thread' };
  }

  let threadStats = { messages: 0, threads: 0, skipped: 0, warning: undefined };
  if (typeof channel.threads?.fetchActive === 'function') {
    threadStats = await deleteAllThreads(channel, { onProgress });
  }

  const messageStats = await purgeMessages(channel, {
    onProgress: (progress) => onProgress?.({ messages: progress.messages, threads: threadStats.threads }),
  });

  return {
    messages: messageStats.messages,
    threads: threadStats.threads,
    skipped: messageStats.skipped + threadStats.skipped,
    warning: threadStats.warning,
    scope: 'channel',
  };
}

async function recreateChannel(channel, reason) {
  if (!canRecreate(channel)) {
    throw new ClearError('Esse tipo de canal não pode ser recriado. Use o modo Apagar mensagens.');
  }

  if (!channel.deletable) {
    throw new ClearError(
      'O Discord não permite apagar este canal. Canais de regras e de atualizações da comunidade ficam de fora. Use o modo Apagar mensagens.',
    );
  }

  const clone = await channel.clone({ reason });

  try {
    const extra = {};

    if (channel.defaultAutoArchiveDuration != null) {
      extra.defaultAutoArchiveDuration = channel.defaultAutoArchiveDuration;
    }
    if (channel.defaultThreadRateLimitPerUser != null) {
      extra.defaultThreadRateLimitPerUser = channel.defaultThreadRateLimitPerUser;
    }

    if (isForumLike(channel)) {
      if (channel.availableTags?.length) {
        extra.availableTags = channel.availableTags.map((tag) => ({
          name: tag.name,
          moderated: tag.moderated,
          emoji: tag.emoji,
        }));
      }
      if (channel.defaultReactionEmoji) {
        extra.defaultReactionEmoji = {
          id: channel.defaultReactionEmoji.id,
          name: channel.defaultReactionEmoji.name,
        };
      }
      if (channel.defaultSortOrder != null) extra.defaultSortOrder = channel.defaultSortOrder;
      if (channel.defaultForumLayout != null) extra.defaultForumLayout = channel.defaultForumLayout;
      if (channel.flags?.bitfield) extra.flags = channel.flags.bitfield;
    }

    if (Object.keys(extra).length > 0) {
      await clone.edit({ ...extra, reason });
    }
  } catch (error) {
    await clone.delete('Falha ao copiar as configurações; a limpeza foi cancelada.').catch(() => {});
    throw error;
  }

  try {
    if (clone.rawPosition !== channel.rawPosition) {
      await clone.setPosition(channel.rawPosition, { reason });
    }
  } catch (error) {
    console.warn(`Canal recriado, mas a posição original não foi restaurada: ${error.message}`);
  }

  try {
    await channel.delete(reason);
  } catch (error) {
    throw new ClearError(
      `Criei ${clone}, mas não consegui apagar o canal antigo. Apague o antigo manualmente se os dois estiverem visíveis.`,
    );
  }

  return clone;
}

module.exports = {
  ClearError,
  canRecreate,
  clearMessages,
  discordCode,
  isForumLike,
  recreateChannel,
};
