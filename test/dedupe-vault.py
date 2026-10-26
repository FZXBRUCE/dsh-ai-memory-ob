"""一次性维护脚本:把库内同会话同标题的重复条目合并成一份。

用法(在插件目录):
    python test/dedupe-vault.py <vault 根目录>
只删除重复的那份,保留标题与内容最完整的一条;不改动其他文件。
"""

import os
import re
import sys


def read_frontmatter(text):
    if not text.startswith('---\n'):
        return {}, text
    end = text.find('\n---', 4)
    if end < 0:
        return {}, text
    header = text[4:end]
    body = text[text.find('\n', end + 4) + 1:]
    fields = {}
    for line in header.split('\n'):
        colon = line.find(':')
        if colon <= 0:
            continue
        key = line[:colon].strip()
        raw = line[colon + 1:].strip()
        if raw.startswith('"') and raw.endswith('"'):
            raw = raw[1:-1]
        fields[key] = raw
    return fields, body


def main():
    if len(sys.argv) < 2:
        print('usage: python test/dedupe-vault.py <vault-root>')
        return 1
    root = sys.argv[1]
    memories = os.path.join(root, 'memories')
    if not os.path.isdir(memories):
        print('no memories dir:', memories)
        return 1

    groups = {}
    for name in sorted(os.listdir(memories)):
        if not name.endswith('.md'):
            continue
        path = os.path.join(memories, name)
        with open(path, encoding='utf-8') as handle:
            text = handle.read()
        fields, body = read_frontmatter(text)
        title = fields.get('title', '')
        session = fields.get('session', '')
        if session.startswith('session-'):
            session = session[len('session-'):]
        key = (session, title)
        groups.setdefault(key, []).append((len(body), path))

    removed = 0
    for key, items in groups.items():
        if len(items) < 2:
            continue
        # 保留正文最长的那份(内容最全),其余删除。
        items.sort(reverse=True)
        keep = items[0][1]
        for _, path in items[1:]:
            os.remove(path)
            removed += 1
            print('removed:', os.path.basename(path), '-> keep', os.path.basename(keep))
    print('total removed:', removed)
    return 0


if __name__ == '__main__':
    sys.exit(main())
