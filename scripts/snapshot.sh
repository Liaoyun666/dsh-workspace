#!/usr/bin/env bash
# 项目快照 / 回滚 / 收尾清理约定脚本
#
#   bash scripts/snapshot.sh begin <任务名>    开工前留一份可回滚快照
#   bash scripts/snapshot.sh list              看现有快照
#   bash scripts/snapshot.sh rollback <任务名>  用快照覆盖回当前工作区
#   bash scripts/snapshot.sh end <任务名>       任务验收通过后删除该快照
#   bash scripts/snapshot.sh prune             删掉超过 3 天的残留快照（可用 SNAPSHOT_KEEP_DAYS 覆盖）
#
# 约定：快照只存代码/文档/配置，不打包 vendor、.venv、node_modules 等体积目录。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAP_DIR="$ROOT/.snapshots"
mkdir -p "$SNAP_DIR"

EXCLUDES=(
  --exclude=.git --exclude=.snapshots
  --exclude=vendor --exclude=.venv --exclude=node_modules --exclude=__pycache__
  --exclude='*.blend1' --exclude='*.pyc'
  --exclude='90-归档'          # 归档区不是源码，回滚时不需要
  --exclude='blender-mcp/screenshots' --exclude='blender-mcp/logs'
)

usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

cmd="${1:-}"; name="${2:-}"

case "$cmd" in
  begin)
    [ -n "$name" ] || { echo "用法: snapshot.sh begin <任务名>" >&2; exit 2; }
    tar_gz="$SNAP_DIR/$name.tar.gz"
    tar_log="$SNAP_DIR/$name.tar.log"
    [ -f "$tar_gz" ] && mv "$tar_gz" "$tar_gz.bak-$(date +%H%M%S)"
    # tar 的 stderr 以前被丢进 /dev/null，失败了只剩一句「快照创建失败」，
    # 分不清是真坏还是「打包期间有文件被改动」（GNU tar 用 exit 1 表示）。现在留日志：
    #   exit 0   干净成功
    #   exit 1   只有 changed-as-read 告警 —— 归档本身完整可用（工作区有活日志时常见）
    #   exit >=2 真失败 —— 删掉半成品，免得它冒充一个可回滚的快照
    tar -czf "$tar_gz" "${EXCLUDES[@]}" -C "$ROOT" . 2>"$tar_log"
    tar_status=$?
    if [ "$tar_status" -ge 2 ] || { [ "$tar_status" -eq 1 ] && ! grep -qi "file changed as we read it" "$tar_log"; }; then
      rm -f "$tar_gz"
      echo "快照创建失败 (tar exit $tar_status)，已删半成品: $tar_gz；详见 $tar_log" >&2
      exit 1
    fi
    {
      echo "task:   $name"
      echo "time:   $(date '+%Y-%m-%d %H:%M:%S')"
      echo "branch: $(git -C "$ROOT" branch --show-current 2>/dev/null || echo '-')"
      echo "commit: $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo 'no-commit')"
      echo "size:   $(du -h "$tar_gz" | cut -f1)"
      echo "warn:   $(grep -ci "file changed as we read it" "$tar_log" 2>/dev/null || true) 处打包期间文件被改动（归档仍完整）"
    } > "$SNAP_DIR/$name.meta.txt"
    echo "已创建快照: $tar_gz ($(du -h "$tar_gz" | cut -f1))"
    ;;

  list)
    if ! ls "$SNAP_DIR"/*.tar.gz >/dev/null 2>&1; then echo "暂无快照"; exit 0; fi
    for f in "$SNAP_DIR"/*.tar.gz; do
      n="$(basename "$f" .tar.gz)"
      printf '%-30s %s\n' "$n" "$(du -h "$f" | cut -f1)"
    done
    ;;

  rollback)
    [ -n "$name" ] || { echo "用法: snapshot.sh rollback <任务名>" >&2; exit 2; }
    tar_gz="$SNAP_DIR/$name.tar.gz"
    [ -f "$tar_gz" ] || { echo "找不到快照: $tar_gz" >&2; exit 1; }
    read -r -p "将用 $name 覆盖回 $ROOT，确认？[y/N] " ans
    [ "$ans" = "y" ] || { echo "已取消"; exit 1; }
    tar -xzf "$tar_gz" -C "$ROOT" && echo "已回滚到快照: $name"
    ;;

  end)
    [ -n "$name" ] || { echo "用法: snapshot.sh end <任务名>" >&2; exit 2; }
    rm -f "$SNAP_DIR/$name.tar.gz" "$SNAP_DIR/$name.meta.txt" "$SNAP_DIR/$name.tar.log"
    rm -f "$SNAP_DIR/$name.tar.gz.bak-"*
    echo "已删除快照: $name"
    ;;

  prune)
    # 保留天数：默认 3 天，可用环境变量 SNAPSHOT_KEEP_DAYS 临时覆盖
    days="${SNAPSHOT_KEEP_DAYS:-3}"
    # 用分钟而不是 -mtime +N：后者按“整天数向下取整 > N”判断，
    # 实际要 4 天才命中（+3 等于清 4 天前的），与“超过 3 天”不符
    mins=$(( days * 24 * 60 ))
    find "$SNAP_DIR" -name '*.tar.gz'      -mmin +"$mins" -print -delete
    find "$SNAP_DIR" -name '*.meta.txt'    -mmin +"$mins" -print -delete
    # begin 重名时把旧快照改名的 .bak-* 残留也一并清，否则永远不会被回收
    find "$SNAP_DIR" -name '*.tar.gz.bak-*' -mmin +"$mins" -print -delete
    find "$SNAP_DIR" -name '*.tar.log'    -mmin +"$mins" -print -delete
    echo "已清理超过 $days 天的快照"
    ;;

  *)
    usage; exit 1 ;;
esac
