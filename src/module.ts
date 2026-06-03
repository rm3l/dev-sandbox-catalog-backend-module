import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node/alpha';

import { DevSandboxEntityProvider } from './provider';

export const catalogModuleDevSandboxEntityProvider = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'dev-sandbox-entity-provider',
  register(env) {
    env.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
      },
      async init({ catalog, config, logger, scheduler }) {
        catalog.addEntityProvider(
          DevSandboxEntityProvider.fromConfig(
            { config, logger },
            { scheduler },
          ),
        );
      },
    });
  },
});
