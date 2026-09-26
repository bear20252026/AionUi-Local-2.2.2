/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Privacy regression (multi-user WebUI): the conversation list lives in a
 * module-level renderer store that outlives logout. Switching accounts must
 * wipe the previous account's rows before the next identity loads — one
 * account's sidebar titles must never render for another.
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  user: { id: 'user-a', username: 'alice' } as { id: string; username: string } | null,
  status: 'authenticated',
}));

vi.mock('@/renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user, status: authState.status }),
}));

vi.mock('@/renderer/utils/emitter', () => ({ addEventListener: vi.fn() }));

vi.mock('@/common', () => {
  let calls = 0;
  return {
    ipcBridge: {
      database: {
        getUserConversations: {
          invoke: vi.fn(() => {
            calls += 1;
            if (calls === 1) {
              // First load (as user-a): one "secret" conversation.
              return Promise.resolve({
                items: [{ id: 'conv-secret', name: 'secret title', extra: {} }],
              });
            }
            // Any later load (user-b): empty.
            return Promise.resolve({ items: [] });
          }),
        },
      },
      conversation: {
        listChanged: { on: () => () => {} },
        responseStream: { on: () => () => {} },
        turnCompleted: { on: () => () => {} },
        confirmation: { remove: { on: () => () => {} } },
      },
      application: {
        writeRendererLog: { invoke: () => Promise.resolve(undefined) },
      },
    },
  };
});

import { useConversationListSync } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';

describe('useConversationListSync identity switch', () => {
  it('wipes the previous account rows and unread flags when the user id changes', async () => {
    const { result, rerender } = renderHook(() => useConversationListSync());

    // user-a's list loads.
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));
    expect(result.current.conversations[0]?.name).toBe('secret title');

    // Simulate an unread flag left behind for the secret conversation.
    localStorage.setItem('conversation-manual-unread-ids', JSON.stringify(['conv-secret']));

    // Switch identity to user-b (login page also resets synchronously; this
    // covers every other entry path).
    act(() => {
      authState.user = { id: 'user-b', username: 'bob' };
    });
    rerender();

    await waitFor(() => expect(result.current.conversations).toHaveLength(0));
    expect(JSON.parse(localStorage.getItem('conversation-manual-unread-ids') ?? '[]')).toEqual([]);
  });
});
