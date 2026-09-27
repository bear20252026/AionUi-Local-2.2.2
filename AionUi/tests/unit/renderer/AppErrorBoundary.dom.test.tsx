/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * White-screen regression: before this boundary existed, any render error
 * unmounted the whole React tree and left a blank page with no message and no
 * recovery. The boundary must render an actionable card (reload + raw error)
 * instead, and log the stack for F12 diagnosis.
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AppErrorBoundary from '@renderer/pages/AppErrorBoundary';

const Boom: React.FC = () => {
  throw new Error('boom-crash-marker');
};

describe('AppErrorBoundary', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders an error card with the stack and a reload action instead of white-screening', () => {
    // React logs render errors through console.error; keep test output clean.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>
    );

    // The failure must be surfaced, not swallowed: stack text is rendered.
    expect(screen.getByText(/boom-crash-marker/)).toBeInTheDocument();
    // Reload (and copy) must be offered as the recovery path.
    expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(1);

    expect(consoleError).toHaveBeenCalled();
  });

  it('renders children normally when nothing throws', () => {
    render(
      <AppErrorBoundary>
        <div>healthy-content</div>
      </AppErrorBoundary>
    );
    expect(screen.getByText('healthy-content')).toBeInTheDocument();
  });
});
