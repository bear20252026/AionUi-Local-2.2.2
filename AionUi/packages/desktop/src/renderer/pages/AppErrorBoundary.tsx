/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

import { Button, Space, Typography } from '@arco-design/web-react';
import i18next from 'i18next';

type AppErrorBoundaryProps = {
  children: React.ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
  componentStack: string | null;
  copied: boolean;
};

/**
 * Root-level error boundary.
 *
 * Without it, any render-time exception unmounts the whole React tree: the user
 * gets a white screen with no message and no way out. This turns that into an
 * actionable card — one-click reload plus the raw stack, printed and copyable,
 * so a report does not even need F12.
 *
 * Inline styles only (no UnoCSS/Arco theme dependencies): the boundary has to
 * render even when the rest of the app failed to initialize.
 */
export default class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  public state: AppErrorBoundaryState = { error: null, componentStack: null, copied: false };

  public static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
    return { error };
  }

  public componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Primary diagnostic channel for the next "why is it white" report.
    console.error('[AppErrorBoundary] unhandled render error:', error, info.componentStack ?? '');
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  private readonly handleCopy = async (): Promise<void> => {
    const detail = this.formatDetail();
    try {
      await navigator.clipboard.writeText(detail);
      // No toast here: the toast host lives inside the tree that just crashed.
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    } catch {
      console.error('[AppErrorBoundary] error details:\n' + detail);
    }
  };

  private formatDetail(): string {
    const { error, componentStack } = this.state;
    const head = error ? error.stack || error.message : 'Unknown error';
    return componentStack ? `${head}\n\nComponent stack:${componentStack}` : head;
  }

  public render() {
    const { children } = this.props;
    const { error } = this.state;
    if (!error) return children;

    const t = (key: string) => i18next.t(`common.errorBoundary.${key}`);
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          minHeight: '100vh',
          padding: 24,
          background: 'var(--bg-1, #f7f8fa)',
          fontFamily: 'inherit',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 640,
            padding: 24,
            borderRadius: 12,
            background: 'var(--bg-base, #ffffff)',
            border: '1px solid var(--border-base, #e5e6eb)',
          }}
        >
          <Typography.Title heading={4} style={{ marginTop: 0, marginBottom: 8 }}>
            {t('title')}
          </Typography.Title>
          <Typography.Paragraph type='secondary' style={{ marginBottom: 16 }}>
            {t('description')}
          </Typography.Paragraph>
          <Space size={12} style={{ marginBottom: 16 }}>
            <Button type='primary' onClick={this.handleReload}>
              {t('reload')}
            </Button>
            <Button onClick={() => void this.handleCopy()}>{this.state.copied ? t('copied') : t('copy')}</Button>
          </Space>
          <div style={{ fontSize: 12, color: 'var(--text-secondary, #4e5969)', marginBottom: 4 }}>{t('details')}</div>
          <pre
            style={{
              maxHeight: 240,
              overflow: 'auto',
              margin: 0,
              padding: 12,
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.5,
              background: 'var(--bg-1, #f2f3f5)',
              color: 'var(--text-secondary, #4e5969)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {this.formatDetail()}
          </pre>
        </div>
      </div>
    );
  }
}
