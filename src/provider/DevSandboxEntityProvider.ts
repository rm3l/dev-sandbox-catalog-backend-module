import type {
  LoggerService,
  SchedulerService,
  SchedulerServiceTaskRunner,
} from '@backstage/backend-plugin-api';

import {
  ANNOTATION_LOCATION,
  ANNOTATION_ORIGIN_LOCATION,
} from '@backstage/catalog-model';
import type { GroupEntity, UserEntity } from '@backstage/catalog-model';
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

const SANDBOX_USERS_GROUP = 'sandbox-users';
const KUBESAW_API_GROUP = 'toolchain.dev.openshift.com';
const KUBESAW_API_VERSION = 'v1alpha1';
const USERACCOUNT_PLURAL = 'useraccounts';
const WATCH_PATH = `/apis/${KUBESAW_API_GROUP}/${KUBESAW_API_VERSION}`;

interface UserAccountResource {
  metadata: {
    name: string;
    namespace: string;
    uid: string;
    creationTimestamp: string;
    resourceVersion?: string;
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
  metadata: {
    resourceVersion: string;
  };
  items: UserAccountResource[];
}

export class DevSandboxEntityProvider implements EntityProvider {
  private connection?: EntityProviderConnection;
  private scheduleFn?: () => Promise<void>;
  private userAccounts = new Map<string, UserAccountResource>();
  private kc: k8s.KubeConfig;

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
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromCluster();
    this.schedule(options.taskRunner);
  }

  getProviderName(): string {
    return `DevSandboxEntityProvider:${this.options.id}`;
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;

    // Initial full sync, then start watching
    await this.fullSync();
    this.startWatch();

    // Periodic full sync as safety net (via scheduler)
    await this.scheduleFn?.();
  }

  private async fullSync() {
    if (!this.connection) {
      throw new NotFoundError('Not initialized');
    }

    const logger = this.options.logger;
    const { namespace } = this.options.provider;

    logger.info(
      `Full sync: listing UserAccount CRs from namespace ${namespace}`,
    );

    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    const response = await customApi.listNamespacedCustomObject(
      KUBESAW_API_GROUP,
      KUBESAW_API_VERSION,
      namespace,
      USERACCOUNT_PLURAL,
    );

    const userAccountList = response.body as unknown as UserAccountList;

    this.userAccounts.clear();
    for (const ua of userAccountList.items) {
      if (!ua.spec.disabled) {
        this.userAccounts.set(ua.metadata.name, ua);
      }
    }

    await this.applyFullMutation();

    logger.info(
      `Full sync complete: ${this.userAccounts.size} active UserAccounts`,
    );
  }

  private startWatch() {
    const logger = this.options.logger;
    const { namespace } = this.options.provider;
    const watchPath = `${WATCH_PATH}/namespaces/${namespace}/${USERACCOUNT_PLURAL}`;

    const watch = new k8s.Watch(this.kc);

    logger.info(`Starting watch on ${watchPath}`);

    watch.watch(
      watchPath,
      {},
      async (type: string, obj: UserAccountResource) => {
        const name = obj.metadata.name;

        switch (type) {
          case 'ADDED':
          case 'MODIFIED':
            if (obj.spec.disabled) {
              if (this.userAccounts.has(name)) {
                this.userAccounts.delete(name);
                await this.applyDeltaMutation([], [name]);
                logger.info(`User ${name} disabled, removed from catalog`);
              }
            } else {
              const isNew = !this.userAccounts.has(name);
              this.userAccounts.set(name, obj);
              if (isNew) {
                await this.applyDeltaMutation([obj], []);
                logger.info(`User ${name} added to catalog`);
              } else {
                await this.applyDeltaMutation([obj], []);
                logger.info(`User ${name} updated in catalog`);
              }
            }
            break;

          case 'DELETED':
            if (this.userAccounts.has(name)) {
              this.userAccounts.delete(name);
              await this.applyDeltaMutation([], [name]);
              logger.info(`User ${name} deleted, removed from catalog`);
            }
            break;

          default:
            break;
        }
      },
      (err?: unknown) => {
        if (err) {
          logger.error('Watch connection lost, will re-sync', {
            message: (err as Error)?.message,
          });
        }
        // Reconnect after a short delay
        setTimeout(() => {
          this.fullSync()
            .then(() => this.startWatch())
            .catch(e =>
              logger.error('Failed to re-sync after watch error', {
                message: (e as Error).message,
              }),
            );
        }, 5000);
      },
    );
  }

  private async applyFullMutation() {
    if (!this.connection) return;

    const users = Array.from(this.userAccounts.values()).map(ua =>
      this.toUserEntity(ua),
    );
    const group = this.toGroupEntity(users);
    const locationKey = `dev-sandbox-provider:${this.options.id}`;

    await this.connection.applyMutation({
      type: 'full',
      entities: [...users, group].map(entity => ({
        locationKey,
        entity,
      })),
    });
  }

  private async applyDeltaMutation(
    added: UserAccountResource[],
    removedNames: string[],
  ) {
    if (!this.connection) return;

    const locationKey = `dev-sandbox-provider:${this.options.id}`;
    const addedUsers = added.map(ua => this.toUserEntity(ua));

    // Always re-emit the group with updated membership
    const allUsers = Array.from(this.userAccounts.values()).map(ua =>
      this.toUserEntity(ua),
    );
    const group = this.toGroupEntity(allUsers);

    const addedEntities = [...addedUsers, group].map(entity => ({
      locationKey,
      entity,
    }));

    const removedEntities = removedNames.map(name => ({
      locationKey,
      entity: this.toUserEntity({
        metadata: { name, namespace: '', uid: '' } as UserAccountResource['metadata'],
        spec: {},
      }),
    }));

    await this.connection.applyMutation({
      type: 'delta',
      added: addedEntities,
      removed: removedEntities,
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
          ...(ua.spec.propagatedClaims?.sub
            ? { 'keycloak.org/id': ua.spec.propagatedClaims.sub }
            : {}),
        },
      },
      spec: {
        profile: {
          email: ua.spec.propagatedClaims?.email,
        },
        memberOf: [SANDBOX_USERS_GROUP],
      },
    };
  }

  private toGroupEntity(users: UserEntity[]): GroupEntity {
    const location = `dev-sandbox:group/${SANDBOX_USERS_GROUP}`;
    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Group',
      metadata: {
        name: SANDBOX_USERS_GROUP,
        description: 'All users provisioned in Dev Sandbox on this cluster',
        annotations: {
          [ANNOTATION_LOCATION]: location,
          [ANNOTATION_ORIGIN_LOCATION]: location,
        },
      },
      spec: {
        type: 'team',
        children: [],
        members: users.map(u => u.metadata.name),
      },
    };
  }

  // Periodic full sync as safety net — catches anything the watch might miss
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
            await this.fullSync();
          } catch (error) {
            logger.error('Error during periodic full sync', {
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
