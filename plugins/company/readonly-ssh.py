#!/usr/bin/python3
# The authorized_keys forced command is the only SSH entry; never evaluate a shell string.
import os
import shlex
import sys
try:
    args = shlex.split(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    if args[:3] != ['sudo', '-n', '/usr/local/libexec/company-ro'] or len(args) < 4 or len(args) > 7:
        raise ValueError()
    os.execv('/usr/bin/sudo', ['/usr/bin/sudo', '-n', '/usr/local/libexec/company-ro', *args[3:]])
except Exception:
    print('拒绝：仅允许公司只读入口', file=sys.stderr)
    sys.exit(1)
