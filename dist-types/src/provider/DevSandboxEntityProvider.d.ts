import type { LoggerService, SchedulerService, SchedulerServiceTaskRunner } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import type { EntityProvider, EntityProviderConnection } from '@backstage/plugin-catalog-node';
import { type DevSandboxProviderConfig } from './config';
export declare class DevSandboxEntityProvider implements EntityProvider {
    private options;
    private connection?;
    private scheduleFn?;
    private userAccounts;
    private kc;
    static fromConfig(deps: {
        config: Config;
        logger: LoggerService;
    }, options: {
        scheduler: SchedulerService;
    }): DevSandboxEntityProvider[];
    constructor(options: {
        id: string;
        provider: DevSandboxProviderConfig;
        logger: LoggerService;
        taskRunner: SchedulerServiceTaskRunner;
    });
    getProviderName(): string;
    connect(connection: EntityProviderConnection): Promise<void>;
    private fullSync;
    private startWatch;
    private applyFullMutation;
    private applyDeltaMutation;
    private toUserEntity;
    private toGroupEntity;
    private trimUserAccount;
    private schedule;
}
