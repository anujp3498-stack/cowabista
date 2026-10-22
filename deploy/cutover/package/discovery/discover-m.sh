#!/usr/bin/env bash
# P6 discovery (READ ONLY), operator workstation M: U1 evidence E1 (DNS, TLS) and what answers on the public
# origin today. Only public, read-only HTTPS GET requests. Prints hosts, status codes and
# markers only; no cookie, token or secret.
#   bash discover-m.sh <APP_DOMAIN> 2>&1 | tee discover-m-$(date -u +%Y%m%dT%H%M%SZ).txt
set -u
D=${1:?usage: discover-m.sh <APP_DOMAIN> [<PORT>]}
P=${2:-443}
O=https://$D; [ "$P" = 443 ] || O=$O:$P
command -v dig >/dev/null || echo "NOTE: dig not installed (package dnsutils or bind-utils); DNS lines below stay empty"
echo "== E1 DNS for $D =="
for t in A AAAA CNAME; do printf '%-6s %s\n' "$t" "$(dig +short "$D" "$t" 2>/dev/null | tr '\n' ' ')"; done
for r in 1.1.1.1 8.8.8.8; do printf 'A @%-8s %s\n' "$r" "$(dig +short "$D" A @"$r" 2>/dev/null | tr '\n' ' ')"; done
case "$(dig +short "$D" CNAME 2>/dev/null)" in *replit*) echo "MARKER: CNAME points at Replit";; esac
case "$(dig +short "$D" TXT 2>/dev/null)" in *replit-verify*) echo "MARKER: TXT replit-verify (a Replit custom domain)";; esac
echo "== E1 TLS certificate served for $D =="
T=; command -v timeout >/dev/null && T='timeout 15' || echo "NOTE: timeout not installed (macOS: brew install coreutils); TLS read without a time limit"
echo | $T openssl s_client -connect "$D:$P" -servername "$D" 2>/dev/null | openssl x509 -noout -subject -issuer -dates 2>/dev/null || echo "TLS: no certificate read"
echo "== What answers on $O (status codes and markers only) =="
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
printf 'GET /                    %s\n' "$(code "$O/")"
printf 'GET /api/healthz         %s\n' "$(code "$O/api/healthz")"
printf 'GET /api/readyz          %s   (release only; 404 at d22a8e43)\n' "$(code "$O/api/readyz")"
printf 'GET /api/auth-policy     %s   (release only; 404 at d22a8e43)\n' "$(code "$O/api/auth-policy")"
printf 'GET /api/__clerk/        %s   (d22a8e43 Clerk proxy when NODE_ENV=production and CLERK_SECRET_KEY are set, on Replit or on cells; 404 in the release)\n' "$(code "$O/api/__clerk/")"
HTML=$(curl -s --max-time 20 "$O/" | head -c 200000)
JS=$(grep -oE 'src="/assets/[^"]+\.js"' <<<"$HTML" | head -1 | sed -E 's/^src="(.*)"$/\1/')
if [ -n "$JS" ]; then BUNDLE=$(curl -s --max-time 30 "$O$JS" | head -c 20000000); else BUNDLE=; fi
if grep -qi 'clerk' <<<"$HTML$BUNDLE"; then echo "MARKER: the SPA references Clerk (d22a8e43 frontend)"
elif grep -q 'auth-policy' <<<"$BUNDLE"; then echo "MARKER: the SPA is the Better Auth release frontend"
else echo "MARKER: frontend not recognised (main bundle ${JS:-not found})"; fi
curl -s -D - -o /dev/null --max-time 20 "$O/" | grep -i -E '^(server|via|x-replit[a-z-]*|replit[a-z-]*|x-powered-by):' | sed 's/\r$//' | sed 's/^/HEADER: /'
echo "== E6 (manual, read only): Meta App Dashboard > WhatsApp > Configuration: record the Callback URL HOST only =="
echo "DONE discover-m"
