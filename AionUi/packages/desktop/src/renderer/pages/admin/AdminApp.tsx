/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Message,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';

import { BackendHttpError, httpDelete, httpGet, httpPost, httpPut } from '@/common/adapter/httpBridge';

import styles from './AdminApp.module.css';

// ---------------------------------------------------------------------------
// Types — mirror `AdminUserResponse` / `ProviderResponse` in aionui-api-types.
// ---------------------------------------------------------------------------

type AdminUser = {
  id: string;
  username: string;
  user_type: string;
  status: string;
  created_at: number;
  last_login: number | null;
  is_primary: boolean;
};

type Provider = {
  id: string;
  platform: string;
  name: string;
  base_url: string;
  api_key: string;
  enabled: boolean;
  created_at?: number;
  updated_at?: number;
};

type ProviderFormValues = {
  platform: string;
  name: string;
  base_url: string;
  api_key: string;
  enabled: boolean;
};

type GateState = 'loading' | 'anonymous' | 'forbidden' | 'ready';

type ProviderDraft = { mode: 'create'; userId: string } | { mode: 'edit'; userId: string; provider: Provider } | null;

const PLATFORM_OPTIONS = ['openai', 'anthropic', 'deepseek', 'gemini', 'moonshot', 'qwen', 'ollama', 'custom'].map(
  (value) => ({ value, label: value })
);

const statusOf = (error: unknown): number | undefined => (error instanceof BackendHttpError ? error.status : undefined);

const formatTime = (ms: number | null | undefined): string => {
  if (!ms) return '—';
  // Backend timestamps are milliseconds; tolerate seconds on older rows.
  const value = ms < 1e12 ? ms * 1000 : ms;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function AdminApp() {
  const { t } = useTranslation();
  const [gate, setGate] = useState<GateState>('loading');
  const [currentUser, setCurrentUser] = useState<{ id: string; username: string } | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [draft, setDraft] = useState<ProviderDraft>(null);
  const [saving, setSaving] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    document.title = `${t('admin.brand.mark')} · ${t('admin.brand.sub')}`;
  }, [t]);

  const loadUsers = useCallback(async () => {
    try {
      const list = await httpGet<AdminUser[]>('/api/admin/users').invoke();
      setUsers(list ?? []);
      setPageError(null);
      setSelectedUserId((current) => current ?? list?.[0]?.id ?? null);
      return true;
    } catch (error) {
      const status = statusOf(error);
      if (status === 401) setGate('anonymous');
      else if (status === 403) setGate('forbidden');
      else setPageError(t('admin.notice.usersLoad'));
      return false;
    }
  }, [t]);

  // Gate: who am I, and may I use the console at all?
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch('/api/auth/user');
        if (!resp.ok) {
          if (!cancelled) setGate('anonymous');
          return;
        }
        const body = (await resp.json()) as { user?: { id: string; username: string } };
        if (cancelled) return;
        if (body.user) setCurrentUser(body.user);
        const ok = await loadUsers();
        if (!cancelled && ok) setGate('ready');
      } catch {
        if (!cancelled) setGate('anonymous');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadUsers]);

  // Providers follow the selected account.
  useEffect(() => {
    if (gate !== 'ready' || !selectedUserId) {
      setProviders([]);
      return;
    }
    let cancelled = false;
    setProvidersLoading(true);
    void httpGet<Provider[]>(`/api/admin/users/${encodeURIComponent(selectedUserId)}/providers`)
      .invoke()
      .then((list) => {
        if (!cancelled) {
          setProviders(list ?? []);
          setPageError(null);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const status = statusOf(error);
        if (status === 401) setGate('anonymous');
        else if (status === 403) setGate('forbidden');
        else setPageError(t('admin.notice.providersLoad'));
      })
      .finally(() => {
        if (!cancelled) setProvidersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gate, selectedUserId, t]);

  const selectedUser = useMemo(() => users.find((user) => user.id === selectedUserId) ?? null, [users, selectedUserId]);

  const refreshProviders = useCallback(async () => {
    if (!selectedUserId) return;
    setProvidersLoading(true);
    try {
      const list = await httpGet<Provider[]>(
        `/api/admin/users/${encodeURIComponent(selectedUserId)}/providers`
      ).invoke();
      setProviders(list ?? []);
      setPageError(null);
    } catch {
      setPageError(t('admin.notice.providersLoad'));
    } finally {
      setProvidersLoading(false);
    }
  }, [selectedUserId, t]);

  const handleGateError = useCallback((error: unknown) => {
    const status = statusOf(error);
    if (status === 401) setGate('anonymous');
    else if (status === 403) setGate('forbidden');
  }, []);

  const saveProvider = useCallback(
    async (values: ProviderFormValues) => {
      if (!draft) return;
      setSaving(true);
      try {
        if (draft.mode === 'create') {
          await httpPost<Provider, ProviderFormValues>(
            `/api/admin/users/${encodeURIComponent(draft.userId)}/providers`
          ).invoke(values);
          Message.success(t('admin.message.created'));
        } else {
          await httpPut<Provider, ProviderFormValues>(
            `/api/admin/users/${encodeURIComponent(draft.userId)}/providers/${encodeURIComponent(draft.provider.id)}`
          ).invoke(values);
          Message.success(t('admin.message.updated'));
        }
        setDraft(null);
        await refreshProviders();
      } catch (error) {
        const status = statusOf(error);
        if (status === 401 || status === 403) {
          handleGateError(error);
          if (status === 403) Message.error(t('admin.notice.forbidden'));
        } else {
          Message.error(t('admin.notice.saveFailed'));
        }
      } finally {
        setSaving(false);
      }
    },
    [draft, handleGateError, refreshProviders, t]
  );

  const removeProvider = useCallback(
    (provider: Provider) => {
      if (!selectedUserId) return;
      Modal.confirm({
        title: t('admin.deleteDialog.title'),
        content: t('admin.deleteDialog.content', { name: provider.name }),
        okText: t('admin.deleteDialog.ok'),
        cancelText: t('admin.modal.cancel'),
        okButtonProps: { status: 'danger' },
        onOk: async () => {
          try {
            await httpDelete<void>(
              `/api/admin/users/${encodeURIComponent(selectedUserId)}/providers/${encodeURIComponent(provider.id)}`
            ).invoke();
            Message.success(t('admin.message.deleted'));
            setProviders((current) => current.filter((item) => item.id !== provider.id));
          } catch (error) {
            const status = statusOf(error);
            if (status === 401 || status === 403) handleGateError(error);
            else Message.error(t('admin.notice.deleteFailed'));
          }
        },
      });
    },
    [handleGateError, selectedUserId, t]
  );

  const logout = useCallback(async () => {
    try {
      const token = document.cookie.match(/(?:^|;\s*)aionui-csrf-token=([^;]*)/);
      await fetch('/logout', {
        method: 'POST',
        headers: token ? { 'x-csrf-token': decodeURIComponent(token[1]) } : undefined,
      });
    } finally {
      window.location.href = '/';
    }
  }, []);

  if (gate === 'loading') {
    return <Centered notice={t('admin.gate.loading')} />;
  }

  if (gate === 'anonymous') {
    return (
      <Centered
        notice={t('admin.gate.anonymous')}
        action={
          <Button type='primary' onClick={() => window.location.assign('/')}>
            {t('admin.gate.anonymousAction')}
          </Button>
        }
      />
    );
  }

  if (gate === 'forbidden') {
    return (
      <Centered
        notice={t('admin.gate.forbidden')}
        action={
          <Button type='primary' onClick={() => window.location.assign('/')}>
            {t('admin.gate.forbiddenAction')}
          </Button>
        }
      />
    );
  }

  const userColumns = [
    {
      title: t('admin.users.account'),
      dataIndex: 'username',
      render: (value: string, record: AdminUser) => (
        <Space size={4}>
          <span>{value || '—'}</span>
          {record.is_primary && <Tag color='arcoblue'>{t('admin.users.adminTag')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('admin.users.status'),
      dataIndex: 'status',
      render: (value: string) => (
        <Tag color={value === 'active' ? 'green' : 'gray'}>
          {value === 'active' ? t('admin.users.active') : t('admin.users.disabled')}
        </Tag>
      ),
    },
    {
      title: t('admin.users.lastLogin'),
      dataIndex: 'last_login',
      render: (value: number | null) => formatTime(value),
    },
  ];

  const providerColumns = [
    { title: t('admin.providers.name'), dataIndex: 'name' },
    { title: t('admin.providers.platform'), dataIndex: 'platform', width: 110 },
    { title: t('admin.providers.baseUrl'), dataIndex: 'base_url', ellipsis: true },
    {
      title: t('admin.providers.apiKey'),
      dataIndex: 'api_key',
      width: 200,
      render: (value: string) => <code className={styles.key}>{value}</code>,
    },
    {
      title: t('admin.providers.enabled'),
      dataIndex: 'enabled',
      width: 80,
      render: (value: boolean) => (
        <Tag color={value ? 'green' : 'gray'}>{value ? t('admin.providers.yes') : t('admin.providers.no')}</Tag>
      ),
    },
    {
      title: '',
      width: 140,
      render: (_: unknown, provider: Provider) => (
        <Space size={4}>
          <Button
            size='mini'
            onClick={() => selectedUserId && setDraft({ mode: 'edit', userId: selectedUserId, provider })}
          >
            {t('admin.providers.edit')}
          </Button>
          <Button size='mini' status='danger' onClick={() => removeProvider(provider)}>
            {t('admin.providers.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>{t('admin.brand.mark')}</span>
          <span className={styles.brandSub}>{t('admin.brand.sub')}</span>
        </div>
        <Space size={12}>
          <span className={styles.me}>{currentUser?.username ?? t('admin.topbar.defaultUser')}</span>
          <Button size='small' onClick={() => window.location.assign('/')}>
            {t('admin.topbar.backToApp')}
          </Button>
          <Button size='small' status='warning' onClick={() => void logout()}>
            {t('admin.topbar.logout')}
          </Button>
        </Space>
      </header>

      {pageError && (
        <Alert type='error' content={pageError} closable className={styles.alert} onClose={() => setPageError(null)} />
      )}

      <main className={styles.body}>
        <Card
          className={styles.users}
          title={t('admin.users.title')}
          bordered={false}
          extra={
            <Button size='mini' onClick={() => void loadUsers()}>
              {t('admin.users.refresh')}
            </Button>
          }
        >
          <Table
            rowKey='id'
            size='small'
            columns={userColumns}
            data={users}
            pagination={false}
            rowSelection={{
              type: 'radio',
              selectedRowKeys: selectedUserId ? [selectedUserId] : [],
              onChange: (keys) => setSelectedUserId(String(keys[0] ?? '') || null),
            }}
            onRow={(record) => ({
              onClick: () => setSelectedUserId(record.id),
            })}
            noDataElement={t('admin.users.empty')}
          />
        </Card>

        <Card
          className={styles.providers}
          title={
            selectedUser
              ? t('admin.providers.titleFor', { name: selectedUser.username || selectedUser.id })
              : t('admin.providers.title')
          }
          bordered={false}
          extra={
            <Space size={8}>
              <Button
                size='mini'
                disabled={!selectedUserId}
                onClick={() => selectedUserId && setDraft({ mode: 'create', userId: selectedUserId })}
              >
                {t('admin.providers.create')}
              </Button>
              <Button size='mini' disabled={!selectedUserId} onClick={() => void refreshProviders()}>
                {t('admin.providers.refresh')}
              </Button>
            </Space>
          }
        >
          <Table
            rowKey='id'
            size='small'
            columns={providerColumns}
            data={providers}
            loading={providersLoading}
            pagination={false}
            noDataElement={selectedUserId ? t('admin.providers.empty') : t('admin.providers.emptyNoUser')}
          />
        </Card>
      </main>

      <ProviderModal
        draft={draft}
        saving={saving}
        ownerLabel={selectedUser?.username ?? ''}
        onCancel={() => setDraft(null)}
        onSubmit={saveProvider}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit dialog
// ---------------------------------------------------------------------------

function ProviderModal(props: {
  draft: ProviderDraft;
  saving: boolean;
  ownerLabel: string;
  onCancel: () => void;
  onSubmit: (values: ProviderFormValues) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { draft, saving, ownerLabel, onCancel, onSubmit } = props;
  const [form] = Form.useForm<ProviderFormValues>();

  useEffect(() => {
    if (draft) {
      if (draft.mode === 'edit') {
        form.setFieldsValue({
          platform: draft.provider.platform,
          name: draft.provider.name,
          base_url: draft.provider.base_url,
          api_key: draft.provider.api_key,
          enabled: draft.provider.enabled,
        });
      } else {
        form.resetFields();
        form.setFieldsValue({ platform: 'openai', enabled: true });
      }
    }
  }, [draft, form]);

  if (!draft) return null;

  return (
    <Modal
      visible
      title={draft.mode === 'create' ? t('admin.modal.createTitle') : t('admin.modal.editTitle')}
      okText={draft.mode === 'create' ? t('admin.modal.okCreate') : t('admin.modal.okSave')}
      cancelText={t('admin.modal.cancel')}
      confirmLoading={saving}
      onCancel={onCancel}
      onOk={() => {
        void form.validate().then((values) => onSubmit(values));
      }}
      autoFocus={false}
      focusLock
    >
      <Typography.Paragraph type='secondary' className={styles.modalHint}>
        {t('admin.modal.owner', { name: ownerLabel || draft.userId })}
      </Typography.Paragraph>
      <Form form={form} layout='vertical'>
        <Form.Item
          label={t('admin.providers.platform')}
          field='platform'
          rules={[{ required: true, message: t('admin.modal.platformRequired') }]}
        >
          <Select options={PLATFORM_OPTIONS} allowCreate placeholder={t('admin.modal.platformPlaceholder')} />
        </Form.Item>
        <Form.Item
          label={t('admin.providers.name')}
          field='name'
          rules={[{ required: true, message: t('admin.modal.nameRequired') }]}
        >
          <Input placeholder={t('admin.modal.namePlaceholder')} />
        </Form.Item>
        <Form.Item
          label={t('admin.providers.baseUrl')}
          field='base_url'
          rules={[{ required: true, message: t('admin.modal.baseUrlRequired') }]}
        >
          <Input placeholder={t('admin.modal.baseUrlPlaceholder')} />
        </Form.Item>
        <Form.Item
          label={t('admin.providers.apiKey')}
          field='api_key'
          rules={[{ required: true, message: t('admin.modal.apiKeyRequired') }]}
          extra={t('admin.modal.apiKeyHint')}
        >
          <Input.Password placeholder={t('admin.modal.apiKeyPlaceholder')} />
        </Form.Item>
        <Form.Item label={t('admin.providers.enabled')} field='enabled' triggerPropName='checked'>
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function Centered(props: { notice: string; action?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className={styles.centered}>
      <Card bordered={false} className={styles.centeredCard}>
        <Typography.Title heading={5}>
          {t('admin.brand.mark')} · {t('admin.brand.sub')}
        </Typography.Title>
        <Typography.Paragraph type='secondary'>{props.notice}</Typography.Paragraph>
        {props.action}
      </Card>
    </div>
  );
}
