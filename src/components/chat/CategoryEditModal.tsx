import { useState, useEffect } from 'react';
import { Modal, Input, Avatar, theme } from 'antd';
import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IconEditor } from '@/components/shared/IconEditor';

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

  useEffect(() => {
    if (open) {
      setName(initialName);
      setIconType(initialIconType ?? null);
      setIconValue(initialIconValue ?? null);
    }
  }, [open, initialName, initialIconType, initialIconValue]);

  const handleOk = () => {
    if (!name.trim()) return;
    onOk({ name: name.trim(), icon_type: iconType, icon_value: iconValue });
    onClose();
  };

  return (
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
        <IconEditor
          iconType={iconType}
          iconValue={iconValue}
          onChange={(type, value) => { setIconType(type); setIconValue(value); }}
          size={40}
          defaultIcon={
            <Avatar
              size={40}
              icon={<FolderOpen size={18} />}
              style={{ cursor: 'pointer', backgroundColor: token.colorFillSecondary, color: token.colorTextSecondary }}
            />
          }
        />

        <Input
          placeholder={t('chat.categoryNamePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={handleOk}
          autoFocus
          style={{ maxWidth: 280 }}
        />
      </div>
    </Modal>
  );
}
