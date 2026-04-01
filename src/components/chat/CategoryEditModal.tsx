import { useState, useEffect, useRef } from 'react';
import { Modal, Input, Avatar, Dropdown, theme } from 'antd';
import type { MenuProps } from 'antd';
import { Smile, X, FileImage, Link, FolderOpen } from 'lucide-react';
import { EmojiPicker } from '@/components/shared/EmojiPicker';
import { AvatarEditBadge } from '@/components/shared/AvatarEditBadge';
import { useResolvedAvatarSrc } from '@/hooks/useResolvedAvatarSrc';
import { invoke, isTauri } from '@/lib/invoke';
import { useTranslation } from 'react-i18next';
import type { AvatarType } from '@/stores/userProfileStore';

interface CategoryEditModalProps {
  open: boolean;
  onClose: () => void;
  onOk: (data: { name: string; icon_type: string | null; icon_value: string | null }) => void;
  initialName?: string;
  initialIconType?: string | null;
  initialIconValue?: string | null;
  title?: string;
}

export function CategoryEditModal({
  open,
  onClose,
  onOk,
  initialName = '',
  initialIconType = null,
  initialIconValue = null,
  title,
}: CategoryEditModalProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [name, setName] = useState(initialName);
  const [iconType, setIconType] = useState<string | null>(initialIconType);
  const [iconValue, setIconValue] = useState<string | null>(initialIconValue);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resolvedFileSrc = useResolvedAvatarSrc(
    (iconType as AvatarType) ?? 'icon',
    iconValue ?? '',
  );

  useEffect(() => {
    if (open) {
      setName(initialName);
      setIconType(initialIconType ?? null);
      setIconValue(initialIconValue ?? null);
      setShowEmojiPicker(false);
      setShowUrlInput(false);
      setUrlInput('');
    }
  }, [open, initialName, initialIconType, initialIconValue]);

  const handleOk = () => {
    if (!name.trim()) return;
    onOk({ name: name.trim(), icon_type: iconType, icon_value: iconValue });
    onClose();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUri = reader.result as string;
      const match = dataUri.match(/^data:([^;]+);base64,(.+)$/s);
      if (!match) return;
      const [, mimeType, data] = match;
      if (isTauri()) {
        try {
          const relativePath = await invoke<string>('save_avatar_file', { data, mimeType });
          setIconType('file');
          setIconValue(relativePath);
        } catch {
          setIconType('file');
          setIconValue(dataUri);
        }
      } else {
        setIconType('file');
        setIconValue(dataUri);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleUrlConfirm = () => {
    if (urlInput.trim()) {
      setIconType('url');
      setIconValue(urlInput.trim());
      setShowUrlInput(false);
    }
  };

  const iconMenuItems: MenuProps['items'] = [
    {
      key: 'emoji',
      icon: <Smile size={14} />,
      label: t('userProfile.emoji'),
      onClick: () => { setShowEmojiPicker(true); setShowUrlInput(false); },
    },
    {
      key: 'url',
      icon: <Link size={14} />,
      label: t('userProfile.imageUrl'),
      onClick: () => { setShowUrlInput(true); setShowEmojiPicker(false); },
    },
    {
      key: 'file',
      icon: <FileImage size={14} />,
      label: t('userProfile.selectImage'),
      onClick: () => fileInputRef.current?.click(),
    },
  ];

  const renderIcon = () => {
    const size = 40;
    if (iconType === 'emoji' && iconValue) {
      return (
        <div style={{
          width: size, height: size, borderRadius: '50%',
          backgroundColor: token.colorFillSecondary,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 20, cursor: 'pointer',
        }}>
          {iconValue}
        </div>
      );
    }
    if (iconType === 'url' && iconValue) {
      return <Avatar size={size} src={iconValue} style={{ cursor: 'pointer' }} />;
    }
    if (iconType === 'file' && iconValue) {
      const src = resolvedFileSrc ?? iconValue;
      return <Avatar size={size} src={src} style={{ cursor: 'pointer' }} />;
    }
    return (
      <Avatar
        size={size}
        icon={<FolderOpen size={18} />}
        style={{ cursor: 'pointer', backgroundColor: token.colorFillSecondary, color: token.colorTextSecondary }}
      />
    );
  };

  return (
    <>
      <Modal
        title={title ?? t('chat.createCategory')}
        open={open}
        onCancel={onClose}
        onOk={handleOk}
        okButtonProps={{ disabled: !name.trim() }}
        destroyOnClose
        width={380}
        mask={{ enabled: true, blur: true }}
      >
        <div className="flex flex-col items-center gap-3 py-3">
          <div style={{ position: 'relative' }}>
            <AvatarEditBadge size={40}>
              <Dropdown menu={{ items: iconMenuItems }} trigger={['click']} placement="bottom">
                {renderIcon()}
              </Dropdown>
            </AvatarEditBadge>
            {iconType && iconValue && (
              <button
                type="button"
                onClick={() => { setIconType(null); setIconValue(null); }}
                style={{
                  position: 'absolute', top: -4, right: -4,
                  width: 16, height: 16, padding: 0, border: 'none',
                  borderRadius: '50%', cursor: 'pointer',
                  background: token.colorBgElevated, boxShadow: token.boxShadowTertiary,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <X size={10} />
              </button>
            )}
          </div>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />

          {/* URL input */}
          {showUrlInput && (
            <Input
              placeholder={t('userProfile.urlPlaceholder')}
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onPressEnter={handleUrlConfirm}
              addonAfter={<span style={{ cursor: 'pointer' }} onClick={handleUrlConfirm}>OK</span>}
              size="small"
              style={{ maxWidth: 280 }}
              autoFocus
            />
          )}

          <Input
            placeholder={t('chat.categoryNamePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onPressEnter={handleOk}
            autoFocus={!showUrlInput}
            style={{ maxWidth: 280 }}
          />
        </div>
      </Modal>
      <EmojiPicker
        open={showEmojiPicker}
        onClose={() => setShowEmojiPicker(false)}
        onEmojiSelect={(emoji) => {
          setIconType('emoji');
          setIconValue(emoji);
          setShowEmojiPicker(false);
        }}
      />
    </>
  );
}
