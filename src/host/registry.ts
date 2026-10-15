/**
 * Supervisor 认的 tool 形状。由 `catalog.ts` 从 `butler.json` 翻译而来；
 * 守护不再持有可写的工具注册表文件——清单目录就是注册表。
 */
export interface ToolAction {
  /** Button text on the tool row. */
  label: string;
  /** Modal header title; falls back to label when omitted. */
  title?: string;
  url: string;
  /** POST executes immediately from the row instead of opening a panel. */
  method?: 'POST';
  /** `external` opens `url` in a new browser tab. */
  target?: 'external';
}

export interface ToolManifest {
  id: string;
  name: string;
  description?: string;
  icon?: import('./catalog.ts').ButlerIconView;
  /** command[0] === 'bun' is resolved to the configured host interpreter at spawn time. */
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  healthUrl?: string;
  panelUrl?: string;
  panelSize?: { width?: number; height?: number };
  actions?: ToolAction[];
  /** Low-frequency tools render inside the collapsed utility section. */
  frequency?: 'low';
  autoStart: boolean;
}
