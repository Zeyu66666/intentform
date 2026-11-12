#!/bin/sh
# 数据目录可能是新建的 named volume（root 所有），也可能绑定到宿主目录。
# 以 root 启动、只修这一处归属，然后立刻用 gosu 降权到 node —— 应用进程本身
# 不持有 root 权限。
set -eu

data_dir="$(dirname "${DATABASE_PATH:-/app/data/intentform.db}")"
mkdir -p "$data_dir"
chown -R node:node "$data_dir"

exec gosu node "$@"
