#!/usr/bin/python3
"""Add aggregate-only daily product metrics to the existing trusted readers."""
import datetime
import gzip
import pathlib
import re
import sqlite3
from collections import Counter
from urllib.parse import urlsplit

TZ = datetime.timezone(datetime.timedelta(hours=8))


def daily_counts(path, table, expression, now=None):
    if (table, expression) not in [
        ('devices', "date(created_at,'+8 hours')"),
        ('users', "date(created/1000.0,'unixepoch','+8 hours')"),
    ]:
        raise ValueError('unsupported metric')
    today = (now or datetime.datetime.now(TZ)).astimezone(TZ).date()
    days = [(today - datetime.timedelta(days=n)).isoformat() for n in range(21, 0, -1)]
    with sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        rows = dict(db.execute('SELECT ' + expression + ',COUNT(*) FROM ' + table + ' WHERE ' + expression + '>=? AND ' + expression + '<? GROUP BY 1', (days[0], today.isoformat())))
    return {'columns': ['day', 'count'], 'rows': [[day, rows.get(day, 0)] for day in days], 'truncated': False}


def download_counts(folder, now=None, prefix="/downloads/", since=None):
    today = (now or datetime.datetime.now(TZ)).astimezone(TZ).date()
    started = datetime.datetime.fromisoformat(since).astimezone(TZ) if since else None
    counts = Counter()
    earliest = None
    latest = None
    pattern = re.compile(r'\[([^\]]+)\] "([A-Z]+) ([^ ]+) HTTP/[^\"]+" (\d{3}) \S+ "[^\"]*" "([^\"]*)"')
    for path in pathlib.Path(folder).glob('access.log*'):
        if not re.fullmatch(r'access\.log(?:\.\d+(?:\.gz)?)?', path.name):
            continue
        opener = gzip.open if path.suffix == '.gz' else open
        with opener(path, 'rt', errors='replace') as lines:
            for line in lines:
                match = pattern.search(line)
                if not match:
                    continue
                stamp, method, uri, status, agent = match.groups()
                at = datetime.datetime.strptime(stamp, '%d/%b/%Y:%H:%M:%S %z').astimezone(TZ)
                if started and at < started:
                    continue
                earliest = min(earliest, at) if earliest else at
                latest = max(latest, at) if latest else at
                if method != 'GET' or status not in ('200', '206') or re.search(r'bot|spider|crawler|curl|wget|python|headless|scrapy', agent, re.I):
                    continue
                if re.fullmatch(re.escape(prefix) + r'[^/]+\.apk', urlsplit(uri).path, re.I):
                    counts[at.date().isoformat()] += 1
    days = [(today - datetime.timedelta(days=n)) for n in range(21, 0, -1)]
    # The first retained day may be partial. Missing retention is unknown, never zero.
    rows = [[day.isoformat(), counts[day.isoformat()]] for day in days if earliest and latest and max(started or earliest, earliest).date() < day <= latest.date()]
    return {'daily': {'columns': ['day', 'count'], 'rows': rows, 'truncated': False}, 'current': {'day': today.isoformat(), 'count': counts[today.isoformat()] if started or earliest else None, 'since': since, 'partial': True}, 'note': '下载点击，不等于安装；nginx安装包GET成功请求数（200/206），去掉明显爬虫；分段或重复请求可能重复计数；不含vivo应用商店。日志覆盖以保留区间为限。'}


def augment(out, business):
    if business == 'jizhu':
        out['usage']['devices_daily'] = daily_counts('/opt/jizhu-api/data/jizhu.sqlite', 'devices', "date(created_at,'+8 hours')")
        out['downloads'] = download_counts('/var/log/nginx')
    elif business == 'jinzhao':
        out['accounts']['registrations_daily'] = daily_counts('/var/lib/between/accounts.db', 'users', "date(created/1000.0,'unixepoch','+8 hours')")
        marker = pathlib.Path('/var/lib/agent-company/jinzhao-downloads-started-at')
        out['downloads'] = download_counts('/var/log/nginx', prefix='/jinzhao/downloads/', since=marker.read_text().strip()) if marker.exists() else {'note': '今朝下载统计尚未接通，历史下载未知。'}
    else:
        raise ValueError('unsupported product')
    return out
