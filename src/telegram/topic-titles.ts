import path from "node:path";
import { STATE_DIR } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";

const TOPIC_TITLES_FILE = path.join(STATE_DIR, "telegram", "topic-titles.json");
const TOPIC_TITLES_VERSION = 1;

type TopicKey = string; // `${chatId}:${threadId}`

export type TelegramTopicTitleEntry = {
  title: string;
  updatedAt: string;
};

type TopicTitlesState = {
  version: number;
  topics: Record<TopicKey, TelegramTopicTitleEntry>;
};

function makeKey(chatId: number | string, threadId: number | string): TopicKey {
  return `${String(chatId)}:${String(threadId)}`;
}

function loadState(): TopicTitlesState {
  const raw = loadJsonFile(TOPIC_TITLES_FILE);
  if (!raw || typeof raw !== "object") {
    return { version: TOPIC_TITLES_VERSION, topics: {} };
  }
  const state = raw as TopicTitlesState;
  if (state.version !== TOPIC_TITLES_VERSION || !state.topics || typeof state.topics !== "object") {
    return { version: TOPIC_TITLES_VERSION, topics: {} };
  }
  return state;
}

function saveState(state: TopicTitlesState) {
  saveJsonFile(TOPIC_TITLES_FILE, state);
}

export function upsertTelegramForumTopicTitle(params: {
  chatId: number;
  threadId: number;
  title: string;
  updatedAt?: string;
}) {
  const title = params.title.trim();
  if (!title) {
    return;
  }
  const state = loadState();
  state.topics[makeKey(params.chatId, params.threadId)] = {
    title,
    updatedAt: params.updatedAt ?? new Date().toISOString(),
  };
  saveState(state);
}

export function resolveTelegramForumTopicTitle(chatId: number, threadId: number): string | null {
  const state = loadState();
  const entry = state.topics[makeKey(chatId, threadId)];
  return entry?.title?.trim() ? entry.title.trim() : null;
}

export function listTelegramForumTopicTitles(chatId: number): Array<{ threadId: number; title: string }> {
  const state = loadState();
  const prefix = `${String(chatId)}:`;
  const results: Array<{ threadId: number; title: string }> = [];
  for (const [key, entry] of Object.entries(state.topics)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const threadIdRaw = key.slice(prefix.length);
    const threadId = Number.parseInt(threadIdRaw, 10);
    if (!Number.isFinite(threadId)) {
      continue;
    }
    const title = entry?.title?.trim();
    if (!title) {
      continue;
    }
    results.push({ threadId, title });
  }
  return results.toSorted((a, b) => a.threadId - b.threadId);
}

/**
 * Extract and persist forum topic titles from incoming Telegram messages.
 *
 * Telegram service messages for topics include:
 * - forum_topic_created: { name }
 * - forum_topic_edited: { name }
 */
export function recordTelegramForumTopicTitleFromMessage(msg: unknown) {
  const m = msg as {
    chat?: { id?: number };
    message_thread_id?: number;
    forum_topic_created?: { name?: string };
    forum_topic_edited?: { name?: string };
  };
  const chatId = m.chat?.id;
  const threadId = m.message_thread_id;
  if (typeof chatId !== "number" || typeof threadId !== "number") {
    return;
  }
  const title =
    m.forum_topic_created?.name?.trim() ??
    m.forum_topic_edited?.name?.trim() ??
    "";
  if (!title) {
    return;
  }
  upsertTelegramForumTopicTitle({ chatId, threadId, title });
}

export function buildTelegramForumThreadLabel(params: {
  chatId: number;
  threadId: number;
  chatTitle?: string;
}): string {
  const cached = resolveTelegramForumTopicTitle(params.chatId, params.threadId);
  if (cached) {
    return `Telegram topic: ${cached}`;
  }
  const base = params.chatTitle?.trim() ? `Telegram topic in ${params.chatTitle.trim()}` : "Telegram topic";
  return `${base} (#${params.threadId})`;
}
