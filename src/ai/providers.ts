/**
 * Named provider presets for the Ajustes UI. Base URL and default model are
 * prefills — model names on these platforms change every few months, so every
 * field stays editable and nothing here is load-bearing beyond first setup.
 *
 * All non-Anthropic presets speak the OpenAI Chat Completions dialect
 * (POST {baseUrl}/chat/completions), which every major Chinese lab exposes.
 */

export interface ProviderPreset {
  id: string;
  /** Display label. */
  label: string;
  /** 'anthropic' uses the official SDK; 'openai' uses the generic adapter. */
  kind: 'anthropic' | 'openai';
  /**
   * Default endpoint. These are the MAINLAND-CHINA endpoints, because that is
   * where the app is deployed — the international ones are separate hosts with
   * separate accounts and, from the office, worse latency. `baseUrlAlt` carries
   * the international host so Ajustes can offer it to anyone running elsewhere.
   */
  baseUrl: string;
  /** International endpoint, when the provider runs a separate one. */
  baseUrlAlt?: string;
  defaultModel: string;
  /**
   * Cheaper model for BULK work (extraction over thousands of messages,
   * classification, translation) as opposed to the interactive chat agent.
   * Empty = use defaultModel for both.
   */
  defaultBulkModel?: string;
  /** Whether the default model accepts image input (user-overridable). */
  vision: boolean;
  /** Whether an API key is required ('' allowed for local servers). */
  needsKey: boolean;
  /** Where to get a key, shown as a hint in Ajustes. */
  keyHint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    baseUrl: '',
    defaultModel: '', // falls back to config.model (claude-haiku-4-5)
    vision: true,
    needsKey: true,
    keyHint: 'console.anthropic.com',
  },
  {
    id: 'qwen',
    label: 'Qwen (Alibaba / DashScope)',
    kind: 'openai',
    // DashScope runs on Alibaba Cloud inside mainland China, so AI traffic does
    // not have to ride the same VPN the WhatsApp mirror needs.
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrlAlt: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-max',
    defaultBulkModel: 'qwen-plus',
    vision: true,
    needsKey: true,
    keyHint: 'dashscope.console.aliyun.com',
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    baseUrlAlt: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2-0711-preview',
    vision: true,
    needsKey: true,
    keyHint: 'platform.moonshot.cn',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    // No vision at all: product photos and scanned PDFs stop producing tasks.
    vision: false,
    needsKey: true,
    keyHint: 'platform.deepseek.com',
  },
  {
    id: 'glm',
    label: 'GLM (Zhipu)',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.6',
    // GLM-4V is the vision-capable sibling; set it as the model if you need images.
    vision: false,
    needsKey: true,
    keyHint: 'open.bigmodel.cn',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: '',
    vision: false,
    needsKey: false,
  },
  {
    id: 'custom',
    label: 'Otro (compatible con OpenAI)',
    kind: 'openai',
    baseUrl: '',
    defaultModel: '',
    vision: false,
    needsKey: false,
  },
];

export function presetById(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[0]!;
}
