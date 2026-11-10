# Prevent SQL side effects and path races even when the company workspace is writable.
import json
import os
import re
import sqlite3
import stat
import sys
import time
from urllib.parse import quote

LIMIT = 200 * 1024
DATABASES = {name: name + '.db' for name in ['operations', 'company', 'model-runs', 'business']}
DATABASES['hub'] = 'hub/hub.db'
SECRET = re.compile(r'env|key|token|credential|feishu|cookie|secret|password|passwd|\.ssh|\.db(?:-|$)|\.sqlite|\.pem|\.p12', re.I)


def open_path(root, path):
    if not isinstance(path, str) or path.startswith('/') or '\\' in path or '\x00' in path:
        raise ValueError()
    parts = path.split('/') if path not in ['', '.'] else []
    if any(p in ['', '.', '..'] or SECRET.search(p) for p in parts):
        raise ValueError()
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for i, part in enumerate(parts):
            new = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK |
                          (os.O_DIRECTORY if i < len(parts) - 1 else 0), dir_fd=fd)
            os.close(fd)
            fd = new
        return fd
    except BaseException:
        os.close(fd)
        raise


def query(root, name, sql):
    if name not in DATABASES or len(sql) > 20000 or not re.match(r'^\s*(SELECT|WITH)\b', sql, re.I):
        raise ValueError()
    path = os.path.join(os.path.realpath(root), DATABASES[name])
    if os.path.realpath(path) != os.path.abspath(path):
        raise ValueError()
    db = sqlite3.connect('file:' + quote(path) + '?mode=ro', uri=True, timeout=2)
    try:
        db.execute('PRAGMA query_only=ON')
        db.execute('PRAGMA trusted_schema=OFF')
        # Python before 3.11 lacks setlimit; production uses 3.11 or later.
        if hasattr(db, 'setlimit'):
            db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, LIMIT)
            db.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 20000)
        deadline = time.monotonic() + 5
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_RECURSIVE}
        def authorize(action, first, second, *_):
            if action == sqlite3.SQLITE_FUNCTION:
                return sqlite3.SQLITE_DENY if second.lower() in ['load_extension', 'writefile', 'readfile', 'edit', 'randomblob', 'zeroblob'] else sqlite3.SQLITE_OK
            return sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY
        db.set_authorizer(authorize)
        cursor = db.execute(sql)
        rows = cursor.fetchmany(201)
        columns = [c[0] for c in cursor.description]
        return {'columns': columns, 'rows': [dict(zip(columns, row)) for row in rows[:200]], 'truncated': len(rows) > 200}
    finally:
        db.close()


def main(root, command, args):
    if command == 'sql' and len(args) == 2:
        return query(root, *args)
    if command not in ['read', 'ls'] or len(args) != 1:
        raise ValueError()
    fd = open_path(root, args[0])
    try:
        mode = os.fstat(fd).st_mode
        if command == 'ls' and stat.S_ISDIR(mode):
            return sorted(p for p in os.listdir(fd) if not SECRET.search(p))[:1000]
        if command == 'read' and stat.S_ISREG(mode):
            if os.fstat(fd).st_size > LIMIT:
                raise ValueError()
            value = os.read(fd, LIMIT + 1)
            if len(value) > LIMIT or b'\x00' in value:
                raise ValueError()
            return value.decode('utf-8')
        raise ValueError()
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        result = json.dumps(main(sys.argv[1], sys.argv[2], sys.argv[3:]), ensure_ascii=False)
        if len(result.encode()) > LIMIT * 2:
            raise ValueError()
        print(result)
    except Exception:
        print('拒绝查询：参数、路径、语句或读取范围不符合只读限制', file=sys.stderr)
        sys.exit(1)
