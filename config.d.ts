import type { SchedulerServiceTaskScheduleDefinitionConfig } from '@backstage/backend-plugin-api';

export interface Config {
  catalog?: {
    providers?: {
      devSandbox?: {
        [key: string]: {
          /**
           * Namespace where UserAccount CRs are managed by the KubeSaw member-operator.
           * @default 'toolchain-member-operator'
           */
          namespace?: string;

          schedule?: SchedulerServiceTaskScheduleDefinitionConfig;
        };
      };
    };
  };
}
