/**
 * ServiceManager 认的 service 形状。由 `catalog.ts` 从 `butler.json` 翻译而来；
 * 守护不再持有可写的服务注册表文件——清单目录就是注册表。
 */
export interface ServiceManifest {
  id: string;
  name: string;
  /** Optional one-line description shown on the card; omitted when empty. */
  description?: string;
  /** Optional card icon (resolved view); omitted when unset. */
  icon?: import('./catalog.ts').ButlerIconView;
  /** Shell command string, run via /bin/sh -c */
  command: string;
  cwd?: string;
  port?: number;
  /** Explicit browser open URL; if omitted and port is set, defaults to http://127.0.0.1:{port} */
  url?: string;
  /** Optional fixed local path opened by the service row's open button. */
  openPath?: string;
  env?: Record<string, string>;
  group?: string;
  /** Low-frequency services render inside the collapsed More section. */
  frequency?: 'low';
  autoStart: boolean;
}
