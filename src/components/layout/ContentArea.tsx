import type { PageKey } from '@/types';
import { ChatPage } from '@/pages/ChatPage';
import { KnowledgePage } from '@/pages/KnowledgePage';
import { MemoryPage } from '@/pages/MemoryPage';
import { GatewayPage } from '@/pages/GatewayPage';
import { FilesPage } from '@/pages/FilesPage';
import { SettingsPage } from '@/pages/SettingsPage';

interface ContentAreaProps {
  activePage: PageKey;
}

export function ContentArea({ activePage }: ContentAreaProps) {
  switch (activePage) {
    case 'chat':
      return <ChatPage />;
    case 'knowledge':
      return <KnowledgePage />;
    case 'memory':
      return <MemoryPage />;
    case 'gateway':
      return <GatewayPage />;
    case 'files':
      return <FilesPage />;
    case 'settings':
      return <SettingsPage />;
    default: {
      const _exhaustive: never = activePage;
      throw new Error(`Unhandled page key: ${_exhaustive}`);
    }
  }
}
