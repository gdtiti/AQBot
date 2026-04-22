import { describe, expect, it } from 'vitest';

import type { Message } from '@/types';
import {
  getLatestVersionsByModel,
  hasMultipleModelVersions,
  insertModelVersionPlaceholder,
  mergeAssistantVersionsAfterSwitch,
  selectNextAssistantVersion,
  shouldRenderStandaloneAssistantError,
} from '../chatMultiModel';

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'assistant',
    content: '',
    provider_id: 'provider-1',
    model_id: 'model-1',
    token_count: null,
    attachments: [],
    thinking: null,
    tool_calls_json: null,
    tool_call_id: null,
    created_at: 1,
    parent_message_id: 'user-1',
    version_index: 0,
    is_active: true,
    status: 'complete',
    ...overrides,
  };
}

describe('chatMultiModel helpers', () => {
  it('does not downgrade non-tabs multi-model errors into standalone alerts', () => {
    expect(shouldRenderStandaloneAssistantError('error', true)).toBe(false);
    expect(shouldRenderStandaloneAssistantError('error', false)).toBe(true);
  });

  it('keeps distinct error versions even when model metadata is missing', () => {
    const latest = getLatestVersionsByModel([
      makeMessage({ id: 'error-1', model_id: null, provider_id: null, status: 'error', created_at: 1 }),
      makeMessage({ id: 'error-2', model_id: null, provider_id: null, status: 'error', created_at: 2 }),
      makeMessage({ id: 'model-2', model_id: 'model-2', created_at: 3 }),
    ]);

    expect(latest.map((message) => message.id)).toEqual(['error-1', 'error-2', 'model-2']);
  });

  it('keeps the current active answer visible while adding a new model response', () => {
    const current = makeMessage({ id: 'active', model_id: 'model-a', is_active: true, content: 'ready' });
    const placeholder = makeMessage({
      id: 'temp-assistant-2',
      model_id: 'model-b',
      provider_id: 'provider-2',
      is_active: false,
      status: 'partial',
    });

    const next = insertModelVersionPlaceholder([current], current.parent_message_id!, placeholder);

    expect(next).toHaveLength(2);
    expect(next.find((message) => message.id === 'active')?.is_active).toBe(true);
    expect(next.find((message) => message.id === 'temp-assistant-2')?.is_active).toBe(false);
  });

  it('removes deleted local versions when backend returns the remaining version set', () => {
    const deleted = makeMessage({ id: 'error-version', model_id: null, provider_id: null, status: 'error', is_active: false });
    const remaining = makeMessage({ id: 'good-version', model_id: 'model-b', is_active: true, content: 'ok' });
    const unrelated = makeMessage({ id: 'other-parent', parent_message_id: 'user-2', content: 'keep me' });

    const next = mergeAssistantVersionsAfterSwitch(
      [deleted, remaining, unrelated],
      deleted.parent_message_id!,
      [remaining],
      remaining.id,
    );

    expect(next.map((message) => message.id)).toEqual(['good-version', 'other-parent']);
    expect(next.find((message) => message.id === 'good-version')?.is_active).toBe(true);
  });

  it('detects when cached versions are no longer multi-model', () => {
    expect(hasMultipleModelVersions([
      makeMessage({ id: 'model-a', model_id: 'model-a' }),
      makeMessage({ id: 'model-b', model_id: 'model-b' }),
    ])).toBe(true);

    expect(hasMultipleModelVersions([
      makeMessage({ id: 'single', model_id: 'model-a' }),
    ])).toBe(false);
  });

  it('picks a remaining fallback version after deleting the active one', () => {
    const fallback = makeMessage({ id: 'fallback', model_id: 'model-b', version_index: 0, created_at: 1 });
    const deleted = makeMessage({ id: 'deleted', model_id: 'model-a', version_index: 1, created_at: 2, status: 'error' });

    expect(selectNextAssistantVersion([fallback, deleted], deleted.id)?.id).toBe('fallback');
  });
});
