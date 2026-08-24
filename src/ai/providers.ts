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
  /** Display label (Spanish UI). */
  label: string;
  /** 'anthropic' uses the official SDK; 'openai' uses the generic adapter. */
  kind: 'anthropic' | 'openai';
  baseUrl: string;
  defaultModel: string;
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
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    vision: true,
    needsKey: true,
    keyHint: 'platform.moonshot.ai',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    vision: false,
    needsKey: true,
    keyHint: 'platform.deepseek.com',
  },
  {
    id: 'qwen',
    label: 'Qwen (Alibaba)',
    kind: 'openai',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-vl-max',
    vision: true,
    needsKey: true,
    keyHint: 'dashscope.console.aliyun.com',
  },
  {
    id: 'glm',
    label: 'GLM (Zhipu)',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.6',
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
