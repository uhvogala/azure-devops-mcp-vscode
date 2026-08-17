#!/usr/bin/env bash

set -euo pipefail

if ! command -v security >/dev/null 2>&1; then
	exec "$@"
fi

ca_bundle=$(mktemp)
trap 'rm -f "$ca_bundle"' EXIT

security find-certificate -a -p /Library/Keychains/System.keychain > "$ca_bundle" 2>/dev/null || true

if [[ ! -s "$ca_bundle" ]]; then
	exec "$@"
fi

NODE_EXTRA_CA_CERTS="$ca_bundle" "$@"