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

import { BackendHttpError, httpDelete, httpGet, httpPost, httpPut } from '@/common/adapter/httpBridge';

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
  const [gate, setGate] = useState<GateState>('loading');
  const [currentUser, setCurrentUser] = useState<{ id: string; username: string } | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [draft, setDraft] = useState<ProviderDraft>(null);
  const [saving, setSaving] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

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
      else setPageError('加载用户列表失败，请稍后重试。');
      return false;
    }
  }, []);

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
        else setPageError('加载模型服务失败。');
      })
      .finally(() => {
        if (!cancelled) setProvidersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gate, selectedUserId]);

  const selectedUser = useMemo(() => users.find((user) => user.id === selectedUserId) ?? null, [users, selectedUserId]);

  const saveProvider = useCallback(
    async (values: ProviderFormValues) => {
      if (!draft) return;
      setSaving(true);
      try {
        if (draft.mode === 'create') {
          await httpPost<Provider, ProviderFormValues>(
            `/api/admin/users/${encodeURIComponent(draft.userId)}/providers`
          ).invoke(values);
          Message.success('已为该用户创建模型服务');
        } else {
          await httpPut<Provider, ProviderFormValues>(
            `/api/admin/users/${encodeURIComponent(draft.userId)}/providers/${encodeURIComponent(draft.provider.id)}`
          ).invoke(values);
          Message.success('模型服务已更新');
        }
        setDraft(null);
        const list = await httpGet<Provider[]>(
          `/api/admin/users/${encodeURIComponent(draft.userId)}/providers`
        ).invoke();
        setProviders(list ?? []);
      } catch (error) {
        const status = statusOf(error);
        if (status === 401) setGate('anonymous');
        else if (status === 403) Message.error('需要管理员权限');
        else Message.error('保存失败，请检查填写内容。');
      } finally {
        setSaving(false);
      }
    },
    [draft]
  );

  const removeProvider = useCallback(
    (provider: Provider) => {
      if (!selectedUserId) return;
      Modal.confirm({
        title: '删除模型服务',
        content: `确定删除「${provider.name}」吗？该用户的此配置将立即失效。`,
        okText: '删除',
        cancelText: '取消',
        okButtonProps: { status: 'danger' },
        onOk: async () => {
          try {
            await httpDelete<void>(
              `/api/admin/users/${encodeURIComponent(selectedUserId)}/providers/${encodeURIComponent(provider.id)}`
            ).invoke();
            Message.success('已删除');
            setProviders((current) => current.filter((item) => item.id !== provider.id));
          } catch (error) {
            const status = statusOf(error);
            if (status === 401) setGate('anonymous');
            else if (status === 403) Message.error('需要管理员权限');
            else Message.error('删除失败');
          }
        },
      });
    },
    [selectedUserId]
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
    return <Centered notice='正在加载管理控制台…' />;
  }

  if (gate === 'anonymous') {
    return (
      <Centered
        notice='需要先登录才能访问管理控制台。'
        action={
          <Button type='primary' onClick={() => window.location.assign('/')}>
            前往登录
          </Button>
        }
      />
    );
  }

  if (gate === 'forbidden') {
    return (
      <Centered
        notice='当前账号不是管理员，无法访问管理控制台。'
        action={
          <Button type='primary' onClick={() => window.location.assign('/')}>
            返回应用
          </Button>
        }
      />
    );
  }

  const userColumns = [
    {
      title: '账号',
      dataIndex: 'username',
      render: (value: string, record: AdminUser) => (
        <Space size={4}>
          <span>{value || '（未命名）'}</span>
          {record.is_primary && <Tag color='arcoblue'>管理员</Tag>}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (value: string) => (
        <Tag color={value === 'active' ? 'green' : 'gray'}>{value === 'active' ? '启用' : '停用'}</Tag>
      ),
    },
    {
      title: '最近登录',
      dataIndex: 'last_login',
      render: (value: number | null) => formatTime(value),
    },
  ];

  const providerColumns = [
    { title: '名称', dataIndex: 'name' },
    { title: '平台', dataIndex: 'platform', width: 110 },
    {
      title: 'Base URL',
      dataIndex: 'base_url',
      ellipsis: true,
    },
    {
      title: 'API Key',
      dataIndex: 'api_key',
      width: 200,
      render: (value: string) => <code className='admin-key'>{value}</code>,
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (value: boolean) => <Tag color={value ? 'green' : 'gray'}>{value ? '是' : '否'}</Tag>,
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
            编辑
          </Button>
          <Button size='mini' status='danger' onClick={() => removeProvider(provider)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className='admin-shell'>
      <header className='admin-topbar'>
        <div className='admin-brand'>
          <span className='admin-brand-mark'>AionUi</span>
          <span className='admin-brand-sub'>管理控制台</span>
        </div>
        <Space size={12}>
          <span className='admin-me'>{currentUser?.username ?? '管理员'}</span>
          <Button size='small' onClick={() => window.location.assign('/')}>
            返回应用
          </Button>
          <Button size='small' status='warning' onClick={() => void logout()}>
            退出登录
          </Button>
        </Space>
      </header>

      {pageError && (
        <Alert type='error' content={pageError} closable className='admin-alert' onClose={() => setPageError(null)} />
      )}

      <main className='admin-body'>
        <Card
          className='admin-users'
          title='用户'
          bordered={false}
          extra={
            <Button
              size='mini'
              onClick={() => {
                void loadUsers();
              }}
            >
              刷新
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
            noDataElement='暂无用户'
          />
        </Card>

        <Card
          className='admin-providers'
          title={selectedUser ? `模型服务 · ${selectedUser.username || selectedUser.id}` : '模型服务'}
          bordered={false}
          extra={
            <Space size={8}>
              <Button
                size='mini'
                disabled={!selectedUserId}
                onClick={() => selectedUserId && setDraft({ mode: 'create', userId: selectedUserId })}
              >
                新建
              </Button>
              <Button
                size='mini'
                disabled={!selectedUserId}
                onClick={() => {
                  if (!selectedUserId) return;
                  setProvidersLoading(true);
                  void httpGet<Provider[]>(`/api/admin/users/${encodeURIComponent(selectedUserId)}/providers`)
                    .invoke()
                    .then((list) => setProviders(list ?? []))
                    .catch(() => setPageError('刷新模型服务失败。'))
                    .finally(() => setProvidersLoading(false));
                }}
              >
                刷新
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
            noDataElement={selectedUserId ? '该用户还没有配置模型服务' : '请先在左侧选择用户'}
          />
        </Card>
      </main>

      <ProviderModal
        draft={draft}
        saving={saving}
        onCancel={() => setDraft(null)}
        onSubmit={saveProvider}
        ownerLabel={selectedUser?.username ?? ''}
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
      title={draft.mode === 'create' ? '为用户新建模型服务' : '编辑模型服务'}
      okText={draft.mode === 'create' ? '创建' : '保存'}
      cancelText='取消'
      confirmLoading={saving}
      onCancel={onCancel}
      onOk={() => {
        void form.validate().then((values) => onSubmit(values));
      }}
      autoFocus={false}
      focusLock
    >
      <Typography.Paragraph type='secondary' className='admin-modal-hint'>
        服务归属：{ownerLabel || draft.userId}
      </Typography.Paragraph>
      <Form form={form} layout='vertical'>
        <Form.Item label='平台' field='platform' rules={[{ required: true, message: '请选择平台' }]}>
          <Select options={PLATFORM_OPTIONS} allowCreate placeholder='openai' />
        </Form.Item>
        <Form.Item label='名称' field='name' rules={[{ required: true, message: '请输入名称' }]}>
          <Input placeholder='OpenAI' />
        </Form.Item>
        <Form.Item label='Base URL' field='base_url' rules={[{ required: true, message: '请输入 Base URL' }]}>
          <Input placeholder='https://api.openai.com/v1' />
        </Form.Item>
        <Form.Item
          label='API Key'
          field='api_key'
          rules={[{ required: true, message: '请输入 API Key' }]}
          extra='仅管理员可见；普通用户只会看到掩码。'
        >
          <Input.Password placeholder='sk-…' />
        </Form.Item>
        <Form.Item label='启用' field='enabled' triggerPropName='checked'>
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function Centered(props: { notice: string; action?: ReactNode }) {
  return (
    <div className='admin-centered'>
      <Card bordered={false} className='admin-centered-card'>
        <Typography.Title heading={5}>AionUi 管理控制台</Typography.Title>
        <Typography.Paragraph type='secondary'>{props.notice}</Typography.Paragraph>
        {props.action}
      </Card>
    </div>
  );
}
