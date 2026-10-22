#!/usr/bin/env bash
# P6 discovery (READ ONLY), cell hosts C and D: U1 evidence E4 (is a cell running here, at which commit and scope,
# does it serve traffic) and the env file's variable NAMES. Run as root. Changes nothing: no start, stop, reload or
# file write (git runs as the checkout's owner with --no-optional-locks, so it never rewrites .git/index).
# Prints NAME=SET/UNSET and names only, never a value; database and Redis addresses as host[:port][/db] only.
#   bash discover-cell.sh 2>&1 | tee discover-cell-$(hostname)-$(date -u +%Y%m%dT%H%M%SZ).txt
set -u
E=${COWABISTA_ETC:-/etc/cowabista}   # override only to test the script against a copy
echo "== host $(hostname)  node $(/usr/bin/node --version 2>/dev/null || echo none)  nginx $(nginx -v 2>&1 | sed 's/.*\///' || echo none)"
echo "== E4 cell units =="
systemctl list-units --all --no-pager --plain --no-legend 'campaign-cell@*' 2>/dev/null || echo "systemctl: no campaign-cell units"
for u in $(systemctl list-units --all --no-pager --plain --no-legend 'campaign-cell@*' 2>/dev/null | awk '{print $1}'); do
  printf '%s enabled=%s active=%s since=%s\n' "$u" "$(systemctl is-enabled "$u" 2>/dev/null)" "$(systemctl is-active "$u" 2>/dev/null)" "$(systemctl show -p ActiveEnterTimestamp --value "$u" 2>/dev/null)"
  # last guard line with its time (compare with since=); commit is 12 hex characters or "unknown"; db= and redis= never printed
  journalctl -u "$u" --no-pager -o short-iso 2>/dev/null | sed -nE 's/^([^ ]+) .*(campaign-cell\[[^]]*\] OK host=[^ ]* scope=[^ ]* phones=[^ ]* shards=[^ ]* port=[^ ]* node=[^ ]* commit=[^ ]*).*/guard: \1 \2/p' | tail -1
  journalctl -u "$u" --since '-24h' --no-pager -o cat 2>/dev/null | grep -c '"req":' | sed 's/^/http requests logged in the last 24 h: /'
done
echo "== checkout /opt/cowabista =="
if [ -d /opt/cowabista ]; then
  o=$(stat -c %U /opt/cowabista)
  g() { runuser -u "$o" -- git --no-optional-locks -C /opt/cowabista "$@" 2>/dev/null; }
  if h=$(g rev-parse HEAD) && s=$(g status --porcelain --untracked-files=normal); then d=$(printf '%s' "$s" | grep -c .); else h='(git failed)'; d=unknown; fi
  printf 'owner=%s head=%s dirty_files=%s\n' "$o" "$h" "$d"
  ls -1 /opt/cowabista/artifacts/api-server/dist/ 2>/dev/null | grep -E '^(index|auth-admin)\.mjs$' | sed 's/^/dist: /'
else echo "no /opt/cowabista"; fi
ls -1d /opt/cowabista.* 2>/dev/null | sed 's/^/other tree: /'
echo "== listening TCP ports (process names only) =="
ss -ltnpH 2>/dev/null | awk '{print $4, $6}' | sed -E 's/pid=[0-9]+,fd=[0-9]+//g' | sort -u
echo "== /etc/cowabista (names only) =="
ls -l "$E" 2>/dev/null | awk 'NR>1 {print $1, $3, $4, $NF}'
for F in "$E"/cell-*.env "$E"/*.env.next; do
  [ -f "$F" ] || continue; echo "-- $F"
  for v in NODE_ENV PORT CAMPAIGN_TRANSPORT_PHONE_IDS DATABASE_URL CAMPAIGN_REDIS_URL REDIS_URL BETTER_AUTH_SECRET BETTER_AUTH_URL AUTH_PUBLIC_SIGN_UP TRUST_PROXY CORS_ALLOWED_ORIGINS \
           CLERK_SECRET_KEY CLERK_PUBLISHABLE_KEY META_APP_SECRET WHATSAPP_WEBHOOK_VERIFY_TOKEN WHATSAPP_CREDENTIAL_ENCRYPTION_KEY WHATSAPP_APP_ID \
           CAMPAIGN_MEDIA_STORAGE CAMPAIGN_MEDIA_S3_ENDPOINT CAMPAIGN_MEDIA_S3_REGION CAMPAIGN_MEDIA_S3_BUCKET CAMPAIGN_MEDIA_S3_ACCESS_KEY_ID CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY CAMPAIGN_MEDIA_S3_FORCE_PATH_STYLE CAMPAIGN_CELL_REQUIRED_ENV; do
    grep -qE "^$v=[\"']?[^\"'[:space:]]" "$F" && echo "$v=SET" || echo "$v=UNSET"
  done
  # every name in the file, with flags only (never a value): duplicates and empty assignments are both forbidden
  awk '/^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=/ { n=$0; sub(/^[[:space:]]*(export[[:space:]]+)?/, "", n); n=substr(n, 1, index(n, "=")-1)
       v=substr($0, index($0, "=")+1); c[n]++; if (v=="" || v=="\"\"" || v=="'\'''\''") e[n]=1 }
       END { for (k in c) print "name present: " k (c[k]>1 ? " (DUPLICATE)" : "") (e[k] ? " (EMPTY VALUE)" : "") }' "$F" | sort
  grep -oE '^(REPLIT|REPL)_[A-Z_]*=' "$F" | sed 's/=$/=SET (Replit variable present)/'
  # non-secret parts only, printed only when the whole value has the expected shape (optional quotes removed;
  # anything else prints a placeholder, never the value): scope, BETTER_AUTH_URL origin, database and Redis host
  val() { sed -n -E "s/^$1=[\"']?([^\"']*)[\"']?[[:space:]]*\$/\\1/p" "$F" | tail -1; }
  v=$(val CAMPAIGN_TRANSPORT_PHONE_IDS); [ -n "$v" ] && { [[ $v =~ ^[0-9,-]+$ ]] && echo "scope: $v" || echo "scope: (unexpected format)"; }
  v=$(val BETTER_AUTH_URL); [ -n "$v" ] && { [[ $v =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]] && echo "BETTER_AUTH_URL origin: $v" || echo "BETTER_AUTH_URL: (not a bare origin)"; }
  re='^postgres(ql)?://([^/?#]*@)?([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]+)?(/[A-Za-z0-9_-]*)?([?][^@#]*)?$'
  v=$(val DATABASE_URL); [ -n "$v" ] && { [[ $v =~ $re ]] && echo "database: ${BASH_REMATCH[3]}${BASH_REMATCH[4]}${BASH_REMATCH[5]}" || echo "database: (unexpected format)"; }
  rr='^(rediss?)://([^/?#]*@)?([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]+)?(/[0-9]*)?([?][^@#]*)?$'
  for r in CAMPAIGN_REDIS_URL REDIS_URL; do v=$(val $r); [ -n "$v" ] || continue
    [[ $v =~ $rr ]] && echo "$r: ${BASH_REMATCH[1]}://${BASH_REMATCH[3]}${BASH_REMATCH[4]}${BASH_REMATCH[5]}" || echo "$r: (unexpected format)"; done
done
echo "== manifest (cell, host, scope: not secret) =="
grep -vE '^[[:space:]]*(#|$)' "$E"/cells.manifest 2>/dev/null || echo "no manifest"
echo "DONE discover-cell"
