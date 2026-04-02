import { getMarkdown, parseMarkdownToStructure, type BaseNode } from 'stream-markdown-parser';

export type ChatMarkdownNode = BaseNode;

export const CHAT_CUSTOM_HTML_TAGS = ['thinking', 'web-search', 'knowledge-retrieval', 'memory-retrieval'] as const;

/**
 * Strip all aqbot-injected custom tags (with `data-aqbot="1"` attribute) and
 * MCP tool call fenced blocks (`:::mcp ... :::`) from content.
 * Used when copying message text so display-only tags don't pollute the clipboard.
 */
export function stripAqbotTags(content: string): string {
  return content
    .replace(/<knowledge-retrieval [^>]*data-aqbot="1"[^>]*>[\s\S]*?<\/knowledge-retrieval>\s*/g, '')
    .replace(/<memory-retrieval [^>]*data-aqbot="1"[^>]*>[\s\S]*?<\/memory-retrieval>\s*/g, '')
    .replace(/<web-search [^>]*data-aqbot="1"[^>]*>[\s\S]*?<\/web-search>\s*/g, '')
    .replace(/\n*:::mcp [^\n]*\n[\s\S]*?:::\n*/g, '\n')
    .trim();
}

const chatMarkdown = getMarkdown('aqbot-chat', {
  customHtmlTags: CHAT_CUSTOM_HTML_TAGS,
});

export function parseChatMarkdown(content: string): ChatMarkdownNode[] {
  return parseMarkdownToStructure(content, chatMarkdown, {
    customHtmlTags: [...CHAT_CUSTOM_HTML_TAGS],
  });
}
