/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshSession } from '@/common/adapter/sessionRefresh';

type WindowWithPort = { __backendPort?: number };

const CSRF_COOKIE = 'aionui-csrf-token';

/** Calls to the refresh endpoint only — cookie-warming GETs are filtered out. */
function refreshCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter(([url]) => url === '/api/auth/refresh');
}

describe('refreshSession (WebUI session refresh)', () => {
  beforeEach(() => {
    // Browser mode: real DOM (jsdom) with no Electron preload port.
    delete (window as WindowWithPort).__backendPort;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as WindowWithPort).__backendPort;
    // Drop the CSRF cookie so each test starts from a cold state.
    document.cookie = `${CSRF_COOKIE}=; max-age=0; path=/`;
  });

  it('POSTs /api/auth/refresh (cookie-borne, no body) and resolves true on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshSession()).resolves.toBe(true);

    const calls = refreshCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe('/api/auth/refresh');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    // No body — the browser attaches the HttpOnly refresh cookie.
    expect(init.body).toBeUndefined();
  });

  it('sends no x-csrf-token header when the CSRF cookie is absent (token resolves to empty)', async () => {
    // ensureCsrfCookie() may issue a warming GET, but the mocked fetch never
    // sets a cookie, so resolveCoreCsrfToken() stays '' and no header is sent.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshSession()).resolves.toBe(true);

    const calls = refreshCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const [, init] = calls[0];
    expect(init.headers ?? {}).not.toHaveProperty('x-csrf-token');
  });

  it('attaches x-csrf-token matching the aionui-csrf-token cookie when present', async () => {
    document.cookie = `${CSRF_COOKIE}=abc123; path=/`;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshSession()).resolves.toBe(true);

    // Cookie already present → no warming GET needed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/refresh');
    expect(init.headers).toMatchObject({ 'x-csrf-token': 'abc123' });
  });

  it('resolves false when the refresh token is also expired (non-ok response)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(refreshSession()).resolves.toBe(false);
  });

  it('resolves false (never throws) on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(refreshSession()).resolves.toBe(false);
  });

  it('single-flights concurrent callers into one POST, then refreshes anew afterwards', async () => {
    let resolveFetch: (value: { ok: boolean }) => void = () => {};
    const pending = new Promise<{ ok: boolean }>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const first = refreshSession();
    const second = refreshSession();
    // Both callers share the same in-flight request — at most one fetch issued.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);

    resolveFetch({ ok: true });
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(refreshCalls(fetchMock)).toHaveLength(1);

    // In-flight promise cleared after settling — a later call refreshes again.
    await expect(refreshSession()).resolves.toBe(true);
    expect(refreshCalls(fetchMock)).toHaveLength(2);
  });

  it('is a no-op (no fetch) outside WebUI browser mode', async () => {
    (window as WindowWithPort).__backendPort = 13400;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshSession()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
