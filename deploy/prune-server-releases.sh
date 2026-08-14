#!/usr/bin/env bash
set -euo pipefail

KEEP_COUNT="${KEEP_COUNT:-3}"

remove_nested_homepage_backups() {
  local release_root="/var/www/mikeywa-site/releases"
  local backup_path
  while IFS= read -r -d '' backup_path; do
    case "$backup_path" in
      "$release_root"/*/massage.previous*|"$release_root"/*/massage.rollback*)
        rm -rf -- "$backup_path"
        ;;
      *)
        echo "Refusing unsafe nested backup path: $backup_path" >&2
        return 1
        ;;
    esac
  done < <(
    find "$release_root" -mindepth 2 -maxdepth 2 -type d \
      \( -name 'massage.previous*' -o -name 'massage.rollback*' \) -print0
  )
}

prune_release_root() {
  local release_root="$1"
  local current_link="$2"
  local current_path
  current_path="$(readlink -f "$current_link")"

  case "$current_path" in
    "$release_root"/*) ;;
    *) echo "Refusing unsafe current path: $current_path" >&2; return 1 ;;
  esac

  mapfile -t newest_paths < <(
    find "$release_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
      | sort -nr \
      | awk -v limit="$KEEP_COUNT" 'NR <= limit {sub(/^[^ ]+ /, ""); print}'
  )

  declare -A keep_paths=(["$current_path"]=1)
  local path
  for path in "${newest_paths[@]}"; do keep_paths["$path"]=1; done

  while IFS= read -r -d '' path; do
    [[ -n "${keep_paths[$path]+x}" ]] && continue
    case "$path" in
      "$release_root"/*) rm -rf -- "$path" ;;
      *) echo "Refusing unsafe release path: $path" >&2; return 1 ;;
    esac
  done < <(find "$release_root" -mindepth 1 -maxdepth 1 -type d -print0)
}

remove_nested_homepage_backups
prune_release_root /var/www/mikeywa-site/releases /var/www/mikeywa-site/current
prune_release_root /opt/massage-app/releases /opt/massage-app/current

find /tmp -maxdepth 1 -type f \
  \( -name 'mikeywa*.tar' -o -name 'mikeywa*.tar.gz' \
     -o -name 'massage*.tar' -o -name 'massage*.tar.gz' \
     -o -name 'rive-viewer*.tar' -o -name 'rive-viewer*.tar.gz' \) \
  -mtime +1 -delete
