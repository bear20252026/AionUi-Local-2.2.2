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
import zhCN from '@arco-design/web-react/es/locale/zh-CN';

// Shared theme tokens so the console follows the app's light/dark palette.
import './styles/arco-override.css';
import './styles/themes/index.css';

import { AdminApp } from './pages/admin/AdminApp';
import './pages/admin/admin.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Admin root container missing');
}

createRoot(container).render(
  <ConfigProvider locale={zhCN}>
    <AdminApp />
  </ConfigProvider>
);
