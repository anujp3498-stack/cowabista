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
  C=$(tr -d '\r' < "$F")   # systemd ignores a trailing CR; keep the content in memory only, never print it
  for v in NODE_ENV PORT CAMPAIGN_TRANSPORT_PHONE_IDS DATABASE_URL CAMPAIGN_REDIS_URL REDIS_URL BETTER_AUTH_SECRET BETTER_AUTH_URL AUTH_PUBLIC_SIGN_UP TRUST_PROXY CORS_ALLOWED_ORIGINS LOG_LEVEL \
           CLERK_SECRET_KEY CLERK_PUBLISHABLE_KEY META_APP_SECRET WHATSAPP_WEBHOOK_VERIFY_TOKEN WHATSAPP_CREDENTIAL_ENCRYPTION_KEY WHATSAPP_APP_ID \
           CAMPAIGN_MEDIA_STORAGE CAMPAIGN_MEDIA_S3_ENDPOINT CAMPAIGN_MEDIA_S3_REGION CAMPAIGN_MEDIA_S3_BUCKET CAMPAIGN_MEDIA_S3_ACCESS_KEY_ID CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY CAMPAIGN_MEDIA_S3_FORCE_PATH_STYLE CAMPAIGN_CELL_REQUIRED_ENV; do
    grep -qE "^[[:space:]]*(export[[:space:]]+)?$v[[:space:]]*=[[:space:]]*[\"']?[^\"'[:space:]]" <<<"$C" && echo "$v=SET" || echo "$v=UNSET"
  done
  # Every assignment name, with flags only; never a value. Values that continue over several lines (quotes or a
  # trailing backslash, which systemd allows) are skipped line by line, so no part of them is read as a name; a name
  # that is not an upper-case NAME of at most 40 characters and any line that is not an assignment are only counted, never shown.
  awk -v sq="'" '
    function mark(n, f) { if (index(fl[n], f) == 0) fl[n] = fl[n] f }
    {
      line = $0
      if (cont) {
        if (q != "") { t = line; while ((i = index(t, q)) > 0) { if (q == "\"" && i > 1 && substr(t, i - 1, 1) == "\\") { t = substr(t, i + 1); continue } cont = 0; break } }
        else if (line !~ /\\$/) cont = 0
        next
      }
      if (line ~ /^[[:space:]]*([#;].*)?$/) next
      if (match(line, /^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/)) {
        n = substr(line, 1, RLENGTH); sub(/^[[:space:]]*(export[[:space:]]+)?/, "", n); sub(/[[:space:]]*=$/, "", n)
        v = substr(line, RLENGTH + 1); sub(/^[[:space:]]+/, "", v); sub(/[[:space:]]+$/, "", v)
        f1 = substr(v, 1, 1); last = substr(v, length(v), 1); prev = substr(v, length(v) - 1, 1)
        multi = 0
        if ((f1 == "\"" || f1 == sq) && (length(v) == 1 || last != f1 || (f1 == "\"" && prev == "\\"))) { multi = 1; cont = 1; q = f1 }
        else if (v ~ /\\$/) { multi = 1; cont = 1; q = "" }
        if (n !~ /^[A-Z][A-Z0-9_]*$/ || length(n) > 40) { other++; next }
        c[n]++
        if (multi) mark(n, " (MULTI-LINE VALUE)")
        if (v == "" || v == "\"\"" || v == sq sq) mark(n, " (EMPTY VALUE)")
        next
      }
      bad++
    }
    END {
      for (k in c) print "name present: " k (c[k] > 1 ? " (DUPLICATE)" : "") fl[k]
      if (other) print "assignments with a non-standard name (not shown): " other
      if (bad) print "lines that are not NAME=value (not shown): " bad
    }' <<<"$C" | sort
  grep -oE '^[[:space:]]*(export[[:space:]]+)?(REPLIT|REPL)_[A-Z_]*[[:space:]]*=' <<<"$C" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/[[:space:]]*=$/=SET (Replit variable present)/'
  # non-secret parts only, printed only when the whole value has the expected shape (optional quotes removed;
  # anything else prints a placeholder, never the value): scope, BETTER_AUTH_URL origin, database and Redis host
  val() { local r; r=$(sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" <<<"$C" | tail -1)
    r=${r%"${r##*[![:space:]]}"}; [ -n "$r" ] || return 0
    case $r in \"*\"|\'*\') r=${r:1:${#r}-2};; esac
    case $r in *[\"\'\\]*) r='?';; esac   # an unclosed or inner quote, or a continuation backslash: never parsed
    printf '%s' "$r"; }
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
