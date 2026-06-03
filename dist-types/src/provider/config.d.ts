import type { SchedulerServiceTaskScheduleDefinition } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
export type DevSandboxProviderConfig = {
    id: string;
    namespace: string;
    schedule?: SchedulerServiceTaskScheduleDefinition;
};
export declare const readProviderConfigs: (config: Config) => DevSandboxProviderConfig[];
