import type { Message } from '@/types';

function getVersionGroupKey(version: Message): string {
  if (version.model_id) {
    return `${version.provider_id ?? '__provider__'}:${version.model_id}`;
  }
  if (version.provider_id) {
    return `${version.provider_id}:${version.id}`;
  }
  return `__message__:${version.id}`;
}

export function getLatestVersionsByModel(versions: Message[]): Message[] {
  const modelMap = new Map<string, Message>();
  for (const version of versions) {
    const key = getVersionGroupKey(version);
    const existing = modelMap.get(key);
    if (!existing || version.version_index > existing.version_index) {
      modelMap.set(key, version);
    }
  }
  return Array.from(modelMap.values());
}

export function hasMultipleModelVersions(versions: Message[]): boolean {
  return getLatestVersionsByModel(versions).length > 1;
}

function compareVersionDesc(left: Message, right: Message): number {
  return right.version_index - left.version_index
    || right.created_at - left.created_at
    || right.id.localeCompare(left.id);
}

export function selectNextAssistantVersion(
  versions: Message[],
  deletedMessageId: string,
): Message | null {
  const deletedVersion = versions.find((version) => version.id === deletedMessageId);
  if (!deletedVersion) {
    return null;
  }

  const remainingVersions = versions.filter((version) => version.id !== deletedMessageId);
  if (remainingVersions.length === 0) {
    return null;
  }

  const sameModelVersions = deletedVersion.model_id
    ? remainingVersions.filter((version) => version.model_id === deletedVersion.model_id)
    : [];
  const candidates = sameModelVersions.length > 0 ? sameModelVersions : remainingVersions;

  return [...candidates].sort(compareVersionDesc)[0] ?? null;
}

export function shouldRenderStandaloneAssistantError(
  status: Message['status'] | null | undefined,
  isNonTabsMultiModel: boolean,
): boolean {
  return status === 'error' && !isNonTabsMultiModel;
}

export function insertModelVersionPlaceholder(
  messages: Message[],
  parentMessageId: string,
  placeholder: Message,
): Message[] {
  let inserted = false;
  const updated: Message[] = [];

  for (const message of messages) {
    updated.push(message);
    if (!inserted && message.parent_message_id === parentMessageId && message.role === 'assistant' && message.is_active) {
      updated.push(placeholder);
      inserted = true;
    }
  }

  if (!inserted) {
    updated.push(placeholder);
  }

  return updated;
}

export function mergeAssistantVersionsAfterSwitch(
  messages: Message[],
  parentMessageId: string,
  versions: Message[],
  activeMessageId: string,
): Message[] {
  const versionMap = new Map(versions.map((version) => [version.id, version]));
  const existingVersionIds = new Set(
    messages
      .filter((message) => message.parent_message_id === parentMessageId && message.role === 'assistant')
      .map((message) => message.id),
  );

  const updatedMessages = messages
    .filter((message) => {
      if (message.parent_message_id !== parentMessageId || message.role !== 'assistant') {
        return true;
      }
      return message.id.startsWith('temp-') || versionMap.has(message.id);
    })
    .map((message) => {
      if (message.parent_message_id !== parentMessageId || message.role !== 'assistant') {
        return message;
      }
      const dbVersion = versionMap.get(message.id);
      return dbVersion
        ? { ...dbVersion, is_active: dbVersion.id === activeMessageId }
        : { ...message, is_active: message.id === activeMessageId };
    });

  for (const version of versions) {
    if (!existingVersionIds.has(version.id)) {
      updatedMessages.push({ ...version, is_active: version.id === activeMessageId });
    }
  }

  return updatedMessages;
}
