# Dev Sandbox Catalog Backend Module

A [Backstage](https://backstage.io/) catalog backend module that syncs
[KubeSaw](https://github.com/codeready-toolchain) `UserAccount` custom resources
into the [Red Hat Developer Hub](https://developers.redhat.com/rhdh) (RHDH) catalog.

## Why

RHDH instances deployed on Dev Sandbox member clusters need to know which users
are provisioned on the cluster. In production, the SSO realm may contain
thousands of Red Hat accounts, so the Keycloak catalog provider cannot be used
to scope users to just Sandbox users.

This plugin solves the problem by watching the `UserAccount` CRs that the
KubeSaw member-operator creates when a user is provisioned on a member cluster.
Each `UserAccount` is mapped to a Backstage `User` entity, and all users are
grouped under a `sandbox-users` group entity.

## How it works

1. On startup, the provider performs a **full sync**: it lists all `UserAccount`
   CRs in the configured namespace (default: `toolchain-member-operator`) and
   emits them as Backstage `User` entities via a `type: 'full'` mutation.

2. It then opens a **Kubernetes watch** on the same namespace. When a
   `UserAccount` is created, modified, or deleted, the provider applies a
   `type: 'delta'` mutation to add or remove the corresponding entity in
   real time.

3. A **periodic full sync** runs on a configurable schedule as a safety net, in
   case the watch silently drops events.

4. **Deprovisioning** is automatic: if a `UserAccount` CR is deleted or its
   `spec.disabled` field is set to `true`, the corresponding user entity is
   removed from the catalog.

### Entity mapping

| UserAccount field | Backstage User entity field |
|---|---|
| `metadata.name` | `metadata.name` |
| `metadata.uid` | `metadata.annotations['dev-sandbox.redhat.com/user-account-uid']` |
| `spec.propagatedClaims.email` | `spec.profile.email` |
| _(all users)_ | `spec.memberOf: ['sandbox-users']` |

A `Group` entity named `sandbox-users` is also emitted, with all provisioned
users listed as members. This group can be used in RBAC policies to grant
permissions to all Dev Sandbox users.

## Configuration

### App-config

Add the following to your RHDH `app-config`:

```yaml
catalog:
  providers:
    devSandbox:
      default:
        # Namespace where UserAccount CRs live (KubeSaw member-operator namespace)
        namespace: toolchain-member-operator
        # Periodic full-sync schedule (safety net — the watch handles real-time sync)
        schedule:
          frequency:
            minutes: 30
          initialDelay:
            minutes: 5
          timeout:
            minutes: 3
```

Multiple provider instances can be configured by replacing `default` with
different keys, each pointing to a different namespace.

### Dynamic plugins

To load this plugin in RHDH as a dynamic plugin, add it to the dynamic plugins
configuration:

```yaml
plugins:
  - package: oci://quay.io/asoro/dev-sandbox-catalog-backend-module:0.3.0
    disabled: false
```

### RBAC for the RHDH ServiceAccount

The plugin uses in-cluster authentication (`KubeConfig.loadFromCluster()`),
so the RHDH ServiceAccount needs permission to list and watch `UserAccount` CRs:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: developer-hub
automountServiceAccountToken: false

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: rhdh-useraccount-reader
rules:
  - apiGroups: ["toolchain.dev.openshift.com"]
    resources: ["useraccounts"]
    verbs: ["get", "list", "watch"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: rhdh-useraccount-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: rhdh-useraccount-reader
subjects:
  - kind: ServiceAccount
    name: developer-hub
    namespace: rhdh-operator
```

If you are deploying RHDH using the [Operator](https://github.com/redhat-developer/rhdh-operator), the `Backstage` CR must be patched to use this ServiceAccount and mount a projected volume for the ServiceAccount token (since `automountServiceAccountToken` is `false` by default for security purposes):

```yaml
apiVersion: rhdh.redhat.com/v1alpha5
kind: Backstage
metadata:
  name: developer-hub
spec:
  deployment:
    patch:
      spec:
        template:
          spec:
            serviceAccountName: developer-hub
            volumes:
              - name: kube-api-access
                projected:
                  sources:
                    - serviceAccountToken:
                        path: token
                        expirationSeconds: 3600
                    - configMap:
                        name: kube-root-ca.crt
                        items:
                          - key: ca.crt
                            path: ca.crt
                    - downwardAPI:
                        items:
                          - path: namespace
                            fieldRef:
                              fieldPath: metadata.namespace
            containers:
              - name: backstage-backend
                volumeMounts:
                  - name: kube-api-access
                    mountPath: /var/run/secrets/kubernetes.io/serviceaccount
                    readOnly: true
```

## Building

```bash
yarn install
yarn tsc && yarn build
```

To package the dynamic plugin:

```bash
export QUAY_USER=$USER
export PLUGIN_NAME=dev-sandbox-catalog-backend-module
export VERSION=$(cat package.json | jq .version -r)
npx @red-hat-developer-hub/cli@latest plugin package --tag quay.io/$QUAY_USER/$PLUGIN_NAME:$VERSION
```

To push to the OCI registry:

```bash
podman push quay.io/$QUAY_USER/$PLUGIN_NAME:$VERSION
```

## License

Apache-2.0
