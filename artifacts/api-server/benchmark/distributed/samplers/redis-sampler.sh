#!/bin/bash
# 1s Redis sampler: instantaneous ops/s, clients, cumulative CPU seconds. Usage: redis-sampler.sh <redis url> <out.csv>
url=$1; out=$2; echo "epoch_ms,ops_per_sec,clients,cpu_sys,cpu_user" > "$out"
while true; do i=$(redis-cli -u "$url" INFO 2>/dev/null | tr -d '\r'); echo "$(date +%s%3N),$(echo "$i" | awk -F: '/^instantaneous_ops_per_sec/{print $2}'),$(echo "$i" | awk -F: '/^connected_clients/{print $2}'),$(echo "$i" | awk -F: '/^used_cpu_sys:/{print $2}'),$(echo "$i" | awk -F: '/^used_cpu_user:/{print $2}')" >> "$out"; sleep 1; done
