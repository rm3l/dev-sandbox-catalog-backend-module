import { readSchedulerServiceTaskScheduleDefinitionFromConfig } from '@backstage/backend-plugin-api';
import type { SchedulerServiceTaskScheduleDefinition } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';

export type DevSandboxProviderConfig = {
  id: string;
  namespace: string;
  schedule?: SchedulerServiceTaskScheduleDefinition;
};

const readProviderConfig = (
  id: string,
  providerConfigInstance: Config,
): DevSandboxProviderConfig => {
  const namespace =
    providerConfigInstance.getOptionalString('namespace') ??
    'toolchain-member-operator';

  const schedule = providerConfigInstance.has('schedule')
    ? readSchedulerServiceTaskScheduleDefinitionFromConfig(
        providerConfigInstance.getConfig('schedule'),
      )
    : undefined;

  return { id, namespace, schedule };
};

export const readProviderConfigs = (
  config: Config,
): DevSandboxProviderConfig[] => {
  const providersConfig = config.getOptionalConfig(
    'catalog.providers.devSandbox',
  );
  if (!providersConfig) {
    return [];
  }
  return providersConfig
    .keys()
    .map(id => readProviderConfig(id, providersConfig.getConfig(id)));
};
