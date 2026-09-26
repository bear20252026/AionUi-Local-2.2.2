/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { createRoot } from 'react-dom/client';

// Arco Design — must be configured for React 19 before the first render.
import '@arco-design/web-react/es/_util/react-19-adapter';
import '@arco-design/web-react/dist/css/arco.css';
import { ConfigProvider } from '@arco-design/web-react';
import enUS from '@arco-design/web-react/es/locale/en-US';
import jaJP from '@arco-design/web-react/es/locale/ja-JP';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import zhTW from '@arco-design/web-react/es/locale/zh-TW';

// Shared theme tokens so the console follows the app's light/dark palette.
import './styles/arco-override.css';
import './styles/themes/index.css';

// Backend config is the source of truth for the interface language.
import { configService } from '@/common/config/configService';
configService.initialize().catch((err) => {
  console.error('Failed to initialize config:', err);
});

// i18next bootstrap (all admin copy is translated through it).
import './services/i18n';
import i18next from 'i18next';

import { AdminApp } from './pages/admin/AdminApp';

// Arco's own widget strings (date pickers, pagination) are locale-scoped; every
// visible string in the console itself comes from i18next, so anything outside
// this map safely falls back to English widget internals.
const ARCO_LOCALES: Record<string, typeof enUS> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
  'en-US': enUS,
};

const container = document.getElementById('root');
if (!container) {
  throw new Error('Admin root container missing');
}

createRoot(container).render(
  <ConfigProvider locale={ARCO_LOCALES[i18next.resolvedLanguage ?? ''] ?? enUS}>
    <AdminApp />
  </ConfigProvider>
);
