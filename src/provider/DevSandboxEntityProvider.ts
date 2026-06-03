import type {
  LoggerService,
  SchedulerService,
  SchedulerServiceTaskRunner,
} from '@backstage/backend-plugin-api';

import {
  ANNOTATION_LOCATION,
  ANNOTATION_ORIGIN_LOCATION,
} from '@backstage/catalog-model';
import type { UserEntity } from '@backstage/catalog-model';
import type { Config } from '@backstage/config';
import { InputError, NotFoundError } from '@backstage/errors';
import type {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import * as k8s from '@kubernetes/client-node';

import {
  readProviderConfigs,
  type DevSandboxProviderConfig,
} from './config';

const KUBESAW_API_GROUP = 'toolchain.dev.openshift.com';
const KUBESAW_API_VERSION = 'v1alpha1';
const USERACCOUNT_PLURAL = 'useraccounts';

interface UserAccountResource {
  metadata: {
    name: string;
    namespace: string;
    uid: string;
    creationTimestamp: string;
    labels?: Record<string, string>;
  };
  spec: {
    disabled?: boolean;
    propagatedClaims?: {
      email?: string;
      sub?: string;
      userID?: string;
      accountID?: string;
      originalSub?: string;
    };
  };
  status?: {
    conditions?: Array<{
      type: string;
      status: string;
      reason: string;
    }>;
  };
}

interface UserAccountList {
  items: UserAccountResource[];
}

export class DevSandboxEntityProvider implements EntityProvider {
  private connection?: EntityProviderConnection;
  private scheduleFn?: () => Promise<void>;

  static fromConfig(
    deps: { config: Config; logger: LoggerService },
    options: { scheduler: SchedulerService },
  ): DevSandboxEntityProvider[] {
    return readProviderConfigs(deps.config).map(providerConfig => {
      if (!providerConfig.schedule) {
        throw new InputError(
          `No schedule provided in config for DevSandboxEntityProvider:${providerConfig.id}. ` +
            `Set catalog.providers.devSandbox.${providerConfig.id}.schedule in app-config.`,
        );
      }

      const taskRunner = options.scheduler.createScheduledTaskRunner(
        providerConfig.schedule,
      );

      return new DevSandboxEntityProvider({
        id: providerConfig.id,
        provider: providerConfig,
        logger: deps.logger,
        taskRunner,
      });
    });
  }

  constructor(
    private options: {
      id: string;
      provider: DevSandboxProviderConfig;
      logger: LoggerService;
      taskRunner: SchedulerServiceTaskRunner;
    },
  ) {
    this.schedule(options.taskRunner);
  }

  getProviderName(): string {
    return `DevSandboxEntityProvider:${this.options.id}`;
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;
    await this.scheduleFn?.();
  }

  async read(options?: { logger?: LoggerService }) {
    if (!this.connection) {
      throw new NotFoundError('Not initialized');
    }

    const logger = options?.logger ?? this.options.logger;
    const { namespace } = this.options.provider;

    logger.info(
      `Reading UserAccount CRs from namespace ${namespace}`,
    );

    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

    const response = await customApi.listNamespacedCustomObject(
      KUBESAW_API_GROUP,
      KUBESAW_API_VERSION,
      namespace,
      USERACCOUNT_PLURAL,
    );

    const userAccountList = response.body as unknown as UserAccountList;
    const userAccounts = userAccountList.items.filter(
      ua => !ua.spec.disabled,
    );

    const users = userAccounts.map(ua => this.toUserEntity(ua));

    logger.info(
      `Read ${users.length} active UserAccounts from namespace ${namespace}`,
    );

    await this.connection.applyMutation({
      type: 'full',
      entities: users.map(entity => ({
        locationKey: `dev-sandbox-provider:${this.options.id}`,
        entity,
      })),
    });
  }

  private toUserEntity(ua: UserAccountResource): UserEntity {
    const name = ua.metadata.name;
    const location = `dev-sandbox:${ua.metadata.namespace}/${name}`;

    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'User',
      metadata: {
        name,
        annotations: {
          [ANNOTATION_LOCATION]: location,
          [ANNOTATION_ORIGIN_LOCATION]: location,
          'dev-sandbox.redhat.com/user-account-name': name,
          'dev-sandbox.redhat.com/user-account-uid': ua.metadata.uid,
        },
      },
      spec: {
        profile: {
          email: ua.spec.propagatedClaims?.email,
        },
        memberOf: [],
      },
    };
  }

  private schedule(taskRunner: SchedulerServiceTaskRunner) {
    this.scheduleFn = async () => {
      const id = `${this.getProviderName()}:refresh`;
      await taskRunner.run({
        id,
        fn: async () => {
          const logger = this.options.logger.child({
            class: DevSandboxEntityProvider.prototype.constructor.name,
            taskId: id,
          });
          try {
            await this.read({ logger });
          } catch (error) {
            logger.error('Error syncing Dev Sandbox users', {
              name: (error as Error).name,
              message: (error as Error).message,
              stack: (error as Error).stack,
            });
          }
        },
      });
    };
  }
}
