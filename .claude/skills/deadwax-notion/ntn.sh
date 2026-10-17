#!/usr/bin/env bash
# Runs ntn against Will's personal Notion workspace ("Will"), never the default (Stora).
#
#   ntn.sh <ntn args>                   any ntn command: `pages get <id>`, `api v1/comments ...`
#   ntn.sh --stdin <ntn args>           the same, reading a body from stdin (`pages create`, `pages update`, `api`)
#   ntn.sh <source> query [args]        `datasources query` on a named data source (--filter, --sort, --limit, --json)
#   ntn.sh <source> create -d '<json>'  create a row: `parent` is set to the data source for you
#   ntn.sh <source> id                  print the data source ID
#
# Sources: tickets projects rfcs research scratchpad glossary decisions process-log
#
# Stdin is closed unless --stdin comes first: run without a terminal, ntn waits on an open stdin forever.
set -eo pipefail
export NOTION_WORKSPACE_ID=d8d40a79-fb78-4b66-8ee4-025778b2ba2e

source_id() {
  case "$1" in
    rfcs) echo 93cb6f72-f918-40e9-a2af-459922d72e2e ;;
    projects) echo 99b8eaab-5615-4455-8059-6c5978ab3428 ;;
    tickets) echo 9e7544cf-6e73-4b63-9fcc-e66d81686a49 ;;
    research) echo da65c53c-cde2-46de-829d-bdb05b768b76 ;;
    scratchpad) echo 1627a8d0-8dc6-4c6a-b586-45e10837bd91 ;;
    glossary) echo fa3612c1-5604-46d9-8450-58bc48664b5f ;;
    decisions) echo e6361027-70b2-424b-bbe3-055ac1eba063 ;;
    process-log) echo a6ae2ef0-a37d-4a41-a0c6-7bcb016e125c ;;
    *) return 1 ;;
  esac
}

if [[ "$1" == --stdin ]]; then
  shift
  exec ntn "$@"
fi

if [[ $# -gt 0 ]] && ds=$(source_id "$1"); then
  name=$1
  shift
  case "$1" in
    query)
      shift
      exec ntn datasources query "$ds" "$@" </dev/null
      ;;
    create)
      if [[ $# -ne 3 || ("$2" != -d && "$2" != --data) ]]; then
        echo "usage: ntn.sh $name create -d '<json>'" >&2
        exit 2
      fi
      body=$(jq -c --arg ds "$ds" '.parent = {data_source_id: $ds}' <<<"$3")
      exec ntn api v1/pages -d "$body" </dev/null
      ;;
    id)
      echo "$ds"
      ;;
    *)
      echo "usage: ntn.sh $name query [args] | create -d '<json>' | id" >&2
      exit 2
      ;;
  esac
  exit 0
fi

exec ntn "$@" </dev/null
