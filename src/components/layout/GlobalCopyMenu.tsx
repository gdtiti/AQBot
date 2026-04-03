import { useState, useEffect, useCallback, useRef } from 'react';
import { Copy, TextCursorInput, Bug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { theme, message } from 'antd';
import { invoke } from '@tauri-apps/api/core';
import { useConversationStore } from '@/stores';

/**
 * Global right-click context menu.
 * - Text selected → Copy + (Fill to Input in chat) + (DevTools in dev)
 * - No text, dev mode → DevTools only
 * - No text, prod mode → suppress native menu
 * - Skips when a component-specific context menu already handled the event.
 */
export function GlobalCopyMenu() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [inChatMessages, setInChatMessages] = useState(false);
  const selectedTextRef = useRef('');
  const menuRef = useRef<HTMLDivElement>(null);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const isDev = import.meta.env.DEV;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      e.preventDefault();

      const sel = window.getSelection()?.toString().trim() || '';
      selectedTextRef.current = sel;

      // "Fill to input" only when right-clicking inside chat message area
      const inMessageArea = !!(e.target as HTMLElement).closest?.('[data-message-area]');
      setInChatMessages(inMessageArea);

      if (sel) {
        setHasSelection(true);
        setMenuPos({ x: e.clientX, y: e.clientY });
      } else if (isDev) {
        setHasSelection(false);
        setMenuPos({ x: e.clientX, y: e.clientY });
      } else {
        setMenuPos(null);
      }
    };

    const dismissHandler = () => setMenuPos(null);

    document.addEventListener('contextmenu', handler);
    document.addEventListener('click', dismissHandler);
    document.addEventListener('scroll', dismissHandler, true);
    return () => {
      document.removeEventListener('contextmenu', handler);
      document.removeEventListener('click', dismissHandler);
      document.removeEventListener('scroll', dismissHandler, true);
    };
  }, [isDev]);

  const handleCopy = useCallback(() => {
    const text = selectedTextRef.current;
    if (text) {
      void navigator.clipboard.writeText(text);
      message.success(t('common.copySuccess'));
    }
    setMenuPos(null);
  }, [t]);

  const handleFillInput = useCallback(() => {
    const text = selectedTextRef.current;
    if (text) {
      window.dispatchEvent(new CustomEvent('aqbot:fill-input', { detail: text }));
    }
    setMenuPos(null);
  }, []);

  const handleOpenDevtools = useCallback(() => {
    void invoke('open_devtools');
    setMenuPos(null);
  }, []);

  if (!menuPos) return null;

  interface MenuItem {
    key: string;
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
  }

  const items: MenuItem[] = [];

  if (hasSelection) {
    items.push(
      { key: 'copy', icon: <Copy size={14} />, label: t('common.copy'), onClick: handleCopy },
    );
    if (activeConversationId && inChatMessages) {
      items.push({
        key: 'fill',
        icon: <TextCursorInput size={14} />,
        label: t('common.fillToInput'),
        onClick: handleFillInput,
      });
    }
  }

  if (isDev) {
    items.push({
      key: 'devtools',
      icon: <Bug size={14} />,
      label: t('common.openDevtools'),
      onClick: handleOpenDevtools,
    });
  }

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: menuPos.x,
        top: menuPos.y,
        zIndex: 9999,
        backgroundColor: token.colorBgElevated,
        borderRadius: 8,
        boxShadow: token.boxShadowSecondary,
        padding: '4px',
        minWidth: 120,
      }}
    >
      {items.map((item) => (
        <div
          key={item.key}
          className="flex items-center gap-2 cursor-pointer"
          style={{
            padding: '6px 12px',
            borderRadius: 4,
            fontSize: 13,
            color: token.colorText,
            transition: 'background-color 0.15s',
          }}
          onClick={item.onClick}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = token.colorFillSecondary; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; }}
        >
          {item.icon}
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}
