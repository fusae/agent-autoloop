#!/bin/sh
# Install root-owned, outside all directories writable by the SSH account.
exec /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/timeout --kill-after=2 45 /opt/agent-company/runtime/node_modules/.bin/node --disable-warning=ExperimentalWarning /opt/agent-company/app/cli/company-readonly.ts "$@"
