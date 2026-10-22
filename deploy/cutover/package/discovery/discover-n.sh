#!/usr/bin/env bash
# P6 discovery (READ ONLY), nginx host N (if one exists): U1 evidence E5. Run as root. Prints the server names,
# listen and root lines of the running configuration, each proxy_pass target as scheme://host[:port] only (a path,
# query or user part may hold a token: never printed), the upstream servers and the certificate subject and dates;
# changes nothing (nginx -T only reads the configuration).
#   mkdir -p logs && bash discovery/discover-n.sh <APP_DOMAIN> 2>&1 | tee logs/discover-n-$(date -u +%Y%m%dT%H%M%SZ).txt
set -u
NGX="nginx${NGINX_CONF:+ -c $NGINX_CONF}"   # NGINX_CONF only to test against another configuration
D=${1:?usage: discover-n.sh <APP_DOMAIN>}
command -v nginx >/dev/null || { echo "no nginx on this host"; exit 0; }
echo "== nginx $(nginx -v 2>&1 | sed 's/.*\///')  active=$(systemctl is-active nginx 2>/dev/null) =="
$NGX -T 2>/dev/null | grep -nE '^\s*(server_name|listen|root|server [][0-9a-zA-Z.:-]+( [^;]*)?;|allow|deny|ssl_certificate )' | sed -E 's/^[0-9]+:\s*/  /'
echo "-- proxy_pass targets (scheme://host[:port] only; a path, query or user part is never printed), with counts"
$NGX -T 2>/dev/null | grep -oE '(^|[{;[:space:]])proxy_pass[[:space:]]+[^;[:space:]]+' | awk '{ t = $NF
  if (match(t, /^[A-Za-z]+:\/\/unix:[^:;]*/)) { print "  " substr(t, 1, RLENGTH); next }
  if (match(t, /^[A-Za-z]+:\/\/[^\/?;@]*/)) { r = substr(t, RLENGTH + 1); if (r == "" || r ~ /^[\/?]/) { print "  " substr(t, 1, RLENGTH); next } }
  print "  (target not shown)" }' | sort | uniq -c
for c in $($NGX -T 2>/dev/null | sed -n 's/^\s*ssl_certificate \(.*\);/\1/p' | sort -u); do
  echo "-- certificate $c"; openssl x509 -noout -subject -dates -in "$c" 2>/dev/null
done
ls -l /var/www/wabista 2>/dev/null | sed 1d | awk '{print "www:", $9, $10, $11}'
echo "DONE discover-n"
