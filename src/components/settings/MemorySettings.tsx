import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Tag,
  Typography,
  Popconfirm,
  Empty,
  Divider,
  theme,
  message,
  Spin,
  Tooltip,
} from 'antd';
import { Plus, Trash2, Brain, RefreshCw, Trash, Pencil, Search, RotateCw } from 'lucide-react';
import { invoke } from '@/lib/invoke';
import { useTranslation } from 'react-i18next';
import { useMemoryStore } from '@/stores';
import { EmbeddingModelSelect } from '@/components/shared/EmbeddingModelSelect';
import { listen } from '@tauri-apps/api/event';
import type { MemorySource, MemoryNamespace, MemoryItem } from '@/types';

interface VectorSearchResult {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  score: number;
}

const SOURCE_TAG_COLOR: Record<MemorySource, string> = {
  manual: 'blue',
  auto_extract: 'green',
};

const INDEX_STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  pending: { color: 'default', label: '待索引' },
  indexing: { color: 'processing', label: '索引中' },
  ready: { color: 'success', label: '已索引' },
  failed: { color: 'error', label: '索引失败' },
  skipped: { color: 'warning', label: '未配置' },
};

// ── Left Sidebar: Namespace List ──────────────────────────

function NamespaceList({
  namespaces,
  selectedId,
  onSelect,
  onAdd,
}: {
  namespaces: MemoryNamespace[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        {namespaces.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('settings.memory.empty', '暂无命名空间')} />
          </div>
        ) : (
          namespaces.map((ns) => {
            const isSelected = selectedId === ns.id;
            return (
              <div
                key={ns.id}
                className="flex items-center cursor-pointer px-3 py-2.5 transition-colors"
                style={{
                  borderRadius: token.borderRadius,
                  backgroundColor: isSelected ? token.colorPrimaryBg : undefined,
                }}
                onClick={() => onSelect(ns.id)}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = token.colorFillQuaternary;
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = '';
                }}
              >
                <Brain size={16} style={{ marginRight: 8, flexShrink: 0, color: token.colorTextSecondary }} />
                <div className="min-w-0 flex-1">
                  <span style={{ color: isSelected ? token.colorPrimary : undefined }}>{ns.name}</span>
                </div>
                <Tag
                  color={ns.embeddingProvider ? 'green' : 'default'}
                  style={{ marginRight: 4, fontSize: 11 }}
                >
                  {ns.embeddingProvider ? t('settings.memory.vectorReady', '就绪') : t('settings.memory.vectorNotConfigured', '未配置')}
                </Tag>
                <Popconfirm
                  title={t('settings.memory.deleteConfirm')}
                  onConfirm={(e) => {
                    e?.stopPropagation();
                    useMemoryStore.getState().deleteNamespace(ns.id);
                  }}
                  okButtonProps={{ danger: true }}
                >
                  <Button
                    type="text"
                    danger
                    size="small"
                    icon={<Trash2 size={14} />}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Popconfirm>
              </div>
            );
          })
        )}
      </div>
      <div className="shrink-0 p-2 pt-0">
        <Button
          type="dashed"
          block
          icon={<Plus size={14} />}
          onClick={onAdd}
        >
          {t('settings.memory.addNamespace')}
        </Button>
      </div>
    </div>
  );
}

// ── Right Panel: Memory Items ─────────────────────────────

function MemoryItemsPanel({
  namespace,
}: {
  namespace: MemoryNamespace;
}) {
  const { t } = useTranslation();
  const { items, loading, loadItems, addItem, deleteItem, updateItem, updateNamespace } = useMemoryStore();
  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<MemoryItem | null>(null);
  const [itemForm] = Form.useForm();
  const [messageApi, contextHolder] = message.useMessage();

  // Pending embedding provider change (for confirmation)
  const [pendingProvider, setPendingProvider] = useState<string | undefined>(undefined);
  const [providerConfirmOpen, setProviderConfirmOpen] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<VectorSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Index status
  const [rebuildingIndex, setRebuildingIndex] = useState(false);
  const rebuildingRef = useRef(false);

  useEffect(() => {
    loadItems(namespace.id);
  }, [namespace.id, loadItems]);

  // Listen for indexing events
  useEffect(() => {
    const unlistenIndexed = listen<{ itemId: string; success: boolean; status?: string; error?: string; isRebuild?: boolean }>(
      'memory-item-indexed',
      (event) => {
        loadItems(namespace.id);
        // Suppress per-item toasts during rebuild
        if (!event.payload.isRebuild) {
          if (event.payload.success) {
            messageApi.success(t('settings.memory.indexSuccess', '索引完成'));
          } else {
            messageApi.error(t('settings.memory.indexFailed', '索引失败') + ': ' + (event.payload.error || ''));
          }
        }
      },
    );
    const unlistenRebuild = listen<{ namespaceId: string }>(
      'memory-rebuild-complete',
      (event) => {
        if (event.payload.namespaceId === namespace.id) {
          setRebuildingIndex(false);
          rebuildingRef.current = false;
          loadItems(namespace.id);
          messageApi.success(t('settings.memory.rebuildSuccess', '索引重建完成'));
        }
      },
    );
    return () => {
      unlistenIndexed.then((fn) => fn());
      unlistenRebuild.then((fn) => fn());
    };
  }, [namespace.id, messageApi, t, loadItems]);

  const handleAddItem = async () => {
    try {
      const values = await itemForm.validateFields();
      const content: string = values.content;
      await addItem(namespace.id, content.slice(0, 50), content);
      setItemModalOpen(false);
      itemForm.resetFields();
    } catch {
      // validation error
    }
  };

  const handleEditItem = async () => {
    if (!editingItem) return;
    try {
      const values = await itemForm.validateFields();
      await updateItem(namespace.id, editingItem.id, {
        content: values.content,
        title: values.content.slice(0, 50),
      });
      setEditingItem(null);
      itemForm.resetFields();
      messageApi.success(t('settings.memory.updateSuccess', '更新成功'));
    } catch {
      // validation error
    }
  };

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim() || !namespace.embeddingProvider) return;
    setSearching(true);
    try {
      const results = await invoke<VectorSearchResult[]>('search_memory', {
        namespaceId: namespace.id,
        query: searchQuery,
        topK: 5,
      });
      setSearchResults(results);
    } catch (e) {
      messageApi.error(String(e));
    } finally {
      setSearching(false);
    }
  }, [searchQuery, namespace.id, namespace.embeddingProvider, messageApi]);

  const itemColumns = [
    {
      title: t('settings.memory.itemContent'),
      dataIndex: 'content',
      key: 'content',
      render: (content: string) => (
        <Typography.Text ellipsis style={{ maxWidth: 360 }}>{content}</Typography.Text>
      ),
    },
    {
      title: t('settings.memory.indexStatusLabel', '索引状态'),
      dataIndex: 'indexStatus',
      key: 'indexStatus',
      width: 100,
      render: (status: string, record: MemoryItem) => {
        const cfg = INDEX_STATUS_CONFIG[status] || INDEX_STATUS_CONFIG.pending;
        const tag = (
          <Tag color={cfg.color} style={{ fontSize: 11 }}>
            {status === 'indexing' && <Spin size="small" style={{ marginRight: 4 }} />}
            {t(`settings.memory.indexStatus.${status}`, cfg.label)}
          </Tag>
        );
        if (status === 'failed' && record.indexError) {
          return <Tooltip title={record.indexError}>{tag}</Tooltip>;
        }
        return tag;
      },
    },
    {
      title: t('settings.memory.source'),
      dataIndex: 'source',
      key: 'source',
      width: 90,
      render: (source: MemorySource) => (
        <Tag color={SOURCE_TAG_COLOR[source]}>
          {t(`settings.memory.${source === 'auto_extract' ? 'autoExtract' : 'manual'}`)}
        </Tag>
      ),
    },
    {
      key: 'actions',
      width: 120,
      render: (_: unknown, record: MemoryItem) => (
        <div className="flex gap-1">
          <Tooltip title={t('settings.memory.reindexItem', '重新索引')}>
            <Button
              size="small"
              type="text"
              icon={<RotateCw size={14} />}
              loading={record.indexStatus === 'indexing'}
              disabled={!namespace.embeddingProvider}
              onClick={() => {
                invoke('reindex_memory_item', { namespaceId: namespace.id, itemId: record.id }).catch((e) => {
                  messageApi.error(String(e));
                });
                loadItems(namespace.id);
              }}
            />
          </Tooltip>
          <Tooltip title={t('settings.memory.editItem', '编辑')}>
            <Button
              size="small"
              type="text"
              icon={<Pencil size={14} />}
              onClick={() => {
                setEditingItem(record);
                itemForm.setFieldsValue({ content: record.content });
              }}
            />
          </Tooltip>
          <Popconfirm
            title={t('settings.memory.deleteConfirm')}
            onConfirm={() => deleteItem(namespace.id, record.id)}
          >
            <Button size="small" danger type="text" icon={<Trash2 size={14} />} />
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <div className="p-6 pb-12 overflow-y-auto h-full">
      {contextHolder}
      <div className="flex items-center justify-between mb-4">
        <span style={{ fontWeight: 600, fontSize: 16 }}>{namespace.name}</span>
        <Tag
          color={namespace.embeddingProvider ? 'green' : 'default'}
          style={{ fontSize: 12 }}
        >
          {namespace.embeddingProvider ? t('settings.memory.vectorReady', '就绪') : t('settings.memory.vectorNotConfigured', '未配置')}
        </Tag>
      </div>

      {/* Name (editable) */}
      <div style={{ padding: '4px 0' }} className="flex items-center justify-between">
        <span>{t('settings.memory.namespaceName')}</span>
        <Input
          value={namespace.name}
          onChange={(e) => updateNamespace(namespace.id, { name: e.target.value })}
          style={{ width: 280 }}
        />
      </div>
      <Divider style={{ margin: '4px 0' }} />

      {/* Embedding model selector */}
      <div style={{ padding: '4px 0' }} className="flex items-center justify-between">
        <span>{t('settings.memory.embeddingModel', '向量模型')}</span>
        <EmbeddingModelSelect
          value={namespace.embeddingProvider ?? undefined}
          onChange={(val) => {
            if (namespace.embeddingProvider && val !== namespace.embeddingProvider) {
              setPendingProvider(val || undefined);
              setProviderConfirmOpen(true);
            } else {
              updateNamespace(namespace.id, {
                embeddingProvider: val || undefined,
                updateEmbeddingProvider: true,
              });
            }
          }}
          placeholder={t('settings.memory.embeddingModelPlaceholder', '选择向量模型')}
          style={{ width: 280 }}
        />
      </div>
      <Modal
        title={t('settings.memory.changeEmbeddingTitle', '更换向量模型')}
        open={providerConfirmOpen}
        onOk={async () => {
          await updateNamespace(namespace.id, {
            embeddingProvider: pendingProvider,
            updateEmbeddingProvider: true,
          });
          setProviderConfirmOpen(false);
          setPendingProvider(undefined);
          // Trigger rebuild
          if (pendingProvider) {
            setRebuildingIndex(true);
            invoke('rebuild_memory_index', { namespaceId: namespace.id }).catch((e) => {
              setRebuildingIndex(false);
              messageApi.error(String(e));
            });
          }
        }}
        onCancel={() => { setProviderConfirmOpen(false); setPendingProvider(undefined); }}
        okButtonProps={{ danger: true }}
        mask={{ enabled: true, blur: true }}
      >
        <p>{t('settings.memory.changeEmbeddingWarning', '更换向量模型后，该命名空间下所有记忆条目将自动重新进行向量索引。此操作不可撤销，是否继续？')}</p>
      </Modal>
      <Divider style={{ margin: '4px 0' }} />

      {/* Toolbar: vector ops + add on left, search on right */}
      <div className="flex items-center justify-between mb-3 mt-2 gap-3">
        <div className="flex items-center gap-2">
          <Tooltip title={t('settings.memory.rebuildIndex', '重建索引')}>
            <Button
              icon={<RefreshCw size={14} />}
              loading={rebuildingIndex}
              disabled={!namespace.embeddingProvider}
              onClick={() => {
                setRebuildingIndex(true);
                rebuildingRef.current = true;
                loadItems(namespace.id);
                invoke('rebuild_memory_index', { namespaceId: namespace.id }).catch((e) => {
                  setRebuildingIndex(false);
                  rebuildingRef.current = false;
                  messageApi.error(String(e));
                });
              }}
            />
          </Tooltip>
          <Tooltip title={t('settings.memory.clearIndex', '清空索引')}>
            <Button
              danger
              icon={<Trash size={14} />}
              disabled={!namespace.embeddingProvider}
              onClick={() => {
                invoke('clear_memory_index', { namespaceId: namespace.id })
                  .then(() => messageApi.success(t('settings.memory.clearSuccess', '索引已清空')))
                  .catch((e) => messageApi.error(String(e)));
              }}
            />
          </Tooltip>
          <Tooltip title={t('settings.memory.addItem', '添加')}>
            <Button icon={<Plus size={14} />} onClick={() => {
              setEditingItem(null);
              itemForm.resetFields();
              setItemModalOpen(true);
            }} />
          </Tooltip>
        </div>
        {namespace.embeddingProvider && (
          <div className="flex items-center gap-2">
            <Input
              placeholder={t('settings.memory.searchPlaceholder', '搜索记忆...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onPressEnter={handleSearch}
              style={{ width: 200 }}
              allowClear
              onClear={() => setSearchResults(null)}
            />
            <Tooltip title={t('settings.memory.search', '搜索')}>
              <Button
                icon={<Search size={14} />}
                loading={searching}
                onClick={handleSearch}
                disabled={!searchQuery.trim()}
              />
            </Tooltip>
          </div>
        )}
      </div>

      {/* Search results */}
      {searchResults && (
        <div className="mb-4">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('settings.memory.searchResults', '搜索结果')}: {searchResults.length} {t('settings.memory.items', '条')}
          </Typography.Text>
          {searchResults.length > 0 ? (
            <div className="mt-2 flex flex-col gap-2">
              {searchResults.map((r, i) => (
                <div
                  key={i}
                  className="p-2 rounded"
                  style={{ background: 'var(--fill-quaternary)', border: '1px solid var(--border-color)' }}
                >
                  <Typography.Text ellipsis style={{ maxWidth: '100%' }}>
                    {r.content}
                  </Typography.Text>
                  <div className="mt-1">
                    <Tag style={{ fontSize: 11 }}>
                      {t('settings.memory.distance', '距离')}: {r.score.toFixed(4)}
                    </Tag>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('settings.memory.noResults', '无匹配结果')} />
          )}
          <Divider />
        </div>
      )}

      <Table
        dataSource={items}
        columns={itemColumns}
        rowKey="id"
        pagination={false}
        loading={loading}
        size="small"
        bordered
      />

      {/* Add / Edit Modal */}
      <Modal
        title={editingItem ? t('settings.memory.editItem', '编辑记忆') : t('settings.memory.addItem')}
        open={itemModalOpen || !!editingItem}
        onOk={editingItem ? handleEditItem : handleAddItem}
        onCancel={() => { setItemModalOpen(false); setEditingItem(null); itemForm.resetFields(); }}
        mask={{ enabled: true, blur: true }}
      >
        <Form form={itemForm} layout="vertical">
          <Form.Item name="content" label={t('settings.memory.itemContent')} rules={[{ required: true }]}>
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────

export default function MemorySettings() {
  const { t } = useTranslation();
  const { namespaces, loadNamespaces, createNamespace, setSelectedNamespaceId } = useMemoryStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nsModalOpen, setNsModalOpen] = useState(false);
  const [nsForm] = Form.useForm();

  useEffect(() => {
    loadNamespaces();
  }, [loadNamespaces]);

  useEffect(() => {
    if (!selectedId && namespaces.length > 0) {
      setSelectedId(namespaces[0].id);
    }
  }, [namespaces, selectedId]);

  useEffect(() => {
    if (selectedId) {
      setSelectedNamespaceId(selectedId);
    }
  }, [selectedId, setSelectedNamespaceId]);

  const selectedNamespace = namespaces.find((ns) => ns.id === selectedId) ?? null;

  const handleAdd = () => {
    nsForm.resetFields();
    setNsModalOpen(true);
  };

  const handleCreate = async () => {
    try {
      const values = await nsForm.validateFields();
      await createNamespace(values.name, 'global', values.embeddingProvider);
      setNsModalOpen(false);
      nsForm.resetFields();
    } catch {
      // validation error
    }
  };

  return (
    <div className="flex h-full">
      <div className="w-64 shrink-0 pt-2" style={{ borderRight: '1px solid var(--border-color)' }}>
        <NamespaceList
          namespaces={namespaces}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAdd={handleAdd}
        />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selectedNamespace ? (
          <MemoryItemsPanel
            key={selectedNamespace.id}
            namespace={selectedNamespace}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('settings.memory.selectOrAdd', '请选择或添加命名空间')}
            />
          </div>
        )}
      </div>

      <Modal
        title={t('settings.memory.addNamespace')}
        open={nsModalOpen}
        onOk={handleCreate}
        onCancel={() => { setNsModalOpen(false); nsForm.resetFields(); }}
        mask={{ enabled: true, blur: true }}
      >
        <Form form={nsForm} layout="vertical">
          <Form.Item name="name" label={t('settings.memory.namespaceName')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="embeddingProvider"
            label={t('settings.memory.embeddingModel', '向量模型')}
            rules={[{ required: true, message: t('settings.memory.embeddingModelPlaceholder', '选择向量模型') }]}
          >
            <EmbeddingModelSelect
              value={nsForm.getFieldValue('embeddingProvider')}
              onChange={(val) => nsForm.setFieldValue('embeddingProvider', val)}
              placeholder={t('settings.memory.embeddingModelPlaceholder', '选择向量模型')}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
