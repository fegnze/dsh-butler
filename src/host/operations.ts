import type { ButlerIconView } from './catalog.ts';
import type { ServiceManager, ServiceStatus } from './service-manager.ts';
import type { Supervisor, ToolHealth, ToolStatus } from './supervisor.ts';

/** Public capability catalogue. Commands, cwd, URLs and environment are never exposed here. */
export interface OperationTool {
  id: string;
  name: string;
  description?: string;
  icon?: ButlerIconView;
  kind: 'tool';
  capabilityId: string;
  version: number;
  running: boolean;
  health: ToolHealth;
  actions: Array<{ index: number; label: string; mode: 'panel' | 'post' | 'external' }>;
}

export interface OperationService {
  id: string;
  name: string;
  description?: string;
  icon?: ButlerIconView;
  kind: 'service';
  capabilityId: string;
  version: number;
  state: ServiceStatus['state'];
  port?: number;
  openUrl?: string;
  /** The service declares a local directory to reveal (path itself stays private). */
  hasOpenPath: boolean;
  actions: Array<'start' | 'stop' | 'restart' | 'log'>;
}

export interface OperationsSnapshot {
  tools: OperationTool[];
  services: OperationService[];
  checkedAt: string;
}

export async function readOperations(supervisor: Supervisor, serviceManager: ServiceManager): Promise<OperationsSnapshot> {
  const tools = await Promise.all(supervisor.ids().map(async (id) => {
    const status = supervisor.statusOf(id);
    const health = await supervisor.healthOf(id);
    return toTool(status, health);
  }));
  const services = (await serviceManager.listStatus()).map(toService);
  // No workflow catalogue: multi-step work is observed as SDK runner events
  // (/runs, /runs/stream), not listed as hard-coded things to click.
  return { tools, services, checkedAt: new Date().toISOString() };
}

function toTool(status: ToolStatus, health: ToolHealth): OperationTool {
  return {
    id: status.id,
    name: status.name,
    description: status.description,
    ...(status.icon ? { icon: status.icon } : {}),
    kind: 'tool',
    capabilityId: `tool:${status.id}`,
    version: 1,
    running: status.running,
    health,
    actions: (status.actions ?? []).map((action, index) => ({
      index,
      label: action.label,
      mode: action.method === 'POST' ? 'post' : action.target === 'external' ? 'external' : 'panel',
    })),
  };
}

function toService(status: ServiceStatus): OperationService {
  return {
    id: status.id,
    name: status.name,
    ...(status.description ? { description: status.description } : {}),
    ...(status.icon ? { icon: status.icon } : {}),
    kind: 'service',
    capabilityId: `service:${status.id}`,
    version: 1,
    state: status.state,
    port: status.port,
    openUrl: status.openUrl,
    hasOpenPath: Boolean(status.openPath),
    actions: ['start', 'stop', 'restart', 'log'],
  };
}
