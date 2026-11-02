#!/bin/bash
exec /opt/homebrew/bin/node "$(dirname "$0")/host.mjs" "$@"
