import { Menu, theme } from 'antd';
import { Cloud, Settings, Palette, Globe, Zap, Database, Info, Search, Plug, CloudUpload, Bot, HardDrive } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '@/stores';
import type { SettingsSection } from '@/types';

const MENU_ICONS: Record<SettingsSection, React.ReactNode> = {
  providers: <Cloud size={16} />,
  defaultModel: <Bot size={16} />,
  general: <Settings size={16} />,
  display: <Palette size={16} />,
  proxy: <Globe size={16} />,
  shortcuts: <Zap size={16} />,
  data: <Database size={16} />,
  storage: <HardDrive size={16} />,
  about: <Info size={16} />,
  searchProviders: <Search size={16} />,
  mcpServers: <Plug size={16} />,
  backup: <CloudUpload size={16} />,
};

const SECTION_KEYS: SettingsSection[] = [
  'general',
  'display',
  'providers',
  'defaultModel',
  'searchProviders',
  'mcpServers',
  'proxy',
  'shortcuts',
  'data',
  'storage',
  'backup',
  'about',
];

export function SettingsSidebar() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const settingsSection = useUIStore((s) => s.settingsSection);
  const setSettingsSection = useUIStore((s) => s.setSettingsSection);

  const items = SECTION_KEYS.map((key) => ({
    key,
    icon: MENU_ICONS[key],
    label: t([`settings.${key}.title`, `settings.${key}`]),
  }));

  return (
    <div className="h-full pt-1" data-os-scrollbar style={{ backgroundColor: token.colorBgContainer, overflowY: 'auto' }}>
      <Menu
        mode="inline"
        selectedKeys={[settingsSection]}
        items={items}
        style={{ borderInlineEnd: 'none' }}
        onClick={({ key }) => setSettingsSection(key as SettingsSection)}
      />
    </div>
  );
}
