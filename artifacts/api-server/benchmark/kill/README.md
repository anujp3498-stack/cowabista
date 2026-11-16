# Kill benchmark: crash ambiguity, duplicates, rate cap, failover

Measures what a hard kill (SIGKILL) of a transport cell costs under load, on the real send path. Nothing here is
production code, and nothing here is in Gate B's measured files. It measures whatever runtime source the checkout
holds, and `identity.json` records the commit, the number of changed files and `measuredFilesSha256`.

**Why it exists.** `benchmark/distributed/failover.sh` cannot measure crash ambiguity:
- its cells use the in-process `benchmark` sender, with no provider intents and no receipts;
- so after a kill the reaper re-sends the dead cell's work, and nothing could tell whether that duplicated a send.

## What runs

- **`fake-graph.mjs`, the ground truth.** A local fake WhatsApp Graph server.
  - Every request whose whole body arrived is logged as having reached the provider, even if its sender is killed
    before the response.
  - Each cell process sends under its own URL prefix (`/<cell>-g<generation>/v25.0/<phone>/messages`), so every
    request names its sender.
  - The token is never logged.
- **`cell.ts`, the cells.** The real `CampaignRuntime` with production defaults:
  - 100 ms tick, 30 s job lease, 5 s ownership TTL, production assignment timings;
  - `DelegatingWhatsAppSender`, with real HTTP from the shard threads through a workspace credential.
  - It refuses to start unless sends resolve to the local fake server (`NODE_ENV=production` would send to
    graph.facebook.com).
- **`seed.ts`.** One workspace with an encrypted credential, connected phones and an approved provider-backed
  template, plus one Running campaign with one route per phone and unique recipients.
  - The encryption key and the token are random per run, and never written anywhere.
- **`run.mjs`, the orchestrator.** In order:
  1. builds the bundles;
  2. resets the benchmark database and Redis (the kit's own `distributed/prepare.sh`, through the guarded
     `push-force`);
  3. starts the fake server, seeds, and starts the cells;
  4. waits for warm-up (every phone at 90 % of its rate for 5 s);
  5. sends SIGKILL to the busiest cell, and reads the jobs it still held (`Processing`, `locked_by` = its runtime
     id) right after the kill;
  6. restarts it after `--restart-delay-ms` (systemd's `RestartSec=2`), unless told not to;
  7. waits until no job is open, then stops everything gracefully and analyses.

## Usage

```
cd artifacts/api-server
export CAMPAIGN_BENCHMARK_DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:5432/campaign_benchmark
export CAMPAIGN_BENCHMARK_CONFIRM=campaign_benchmark REDIS_URL=redis://127.0.0.1:6391   # a Redis used for nothing else
node benchmark/kill/run.mjs --label rc-static --mode static --phones 4 --tps 1000 --rows-per-phone 60000
node benchmark/kill/run.mjs --label rc-auto --mode auto --cells 2 --phones 4 --tps 1000 --rows-per-phone 90000
node benchmark/kill/run.mjs --label rc-control --no-kill --phones 4 --tps 1000 --rows-per-phone 30000
```

**Options:**
- `--latency-ms` and `--jitter-ms` set the fake provider's response latency;
- `--shards` is passed as `CAMPAIGN_TRANSPORT_SHARDS`;
- `--warmup-s` and `--warmup-max-s` bound the warm-up;
- `--settle-timeout-s` bounds the wait for every job to settle;
- `--no-restart` leaves the killed cell down.

Results go to `benchmark-results/kill/<label>/`, which is git-ignored.

## What is reported (`summary.md`, `result.json`)

**Every job against the fake provider's log:**
- Sent and reached once.
- Sent but never reached: a phantom send, must be 0.
- Duplicates: a recipient that reached the provider twice, must be 0.
- Delivery-unknown, split into reached the provider (genuinely ambiguous) and never reached it (avoidable).
  - By path:
    - A: broker reclaim, "after broker consumer loss";
    - B: re-preparation of a pending intent, "manual reconciliation is required";
    - provider timeout;
    - connection failure.
- Still open, and other failures.
- Delivery-unknown jobs the killed cell did not hold: must be 0, since only the crash may cause one.

**The killed cell's held jobs:** how each ended. Sent after a requeue means it was recovered as never sent.

**Failover:**
- per phone, the victim's last arrival and the successor's first arrival;
- recovery to 95 % of the pre-kill rate;
- sends below that rate meanwhile.

**Rate cap:** the per-phone peak of arrivals in any rolling second.
- Reported both over the whole run and after each sender's first 2 s (connection warm-up).
- The shard holds the limit on its own start clock. Arrivals add the sender's event-loop and transmission jitter,
  which Meta would also see, so the raw peaks are reported. The check allows one extra request.

**Latency:**
- pacing lateness, which is arrival minus the job's reserved slot (`scheduled_send_at`);
- the fake provider's response time and event-loop delay.

**Cells:** event-loop p99, RSS, dispatch counters.

## Validity

- **Host contention.** On one host, PostgreSQL, Redis, the fake provider and the cells share the CPUs. At the
  target rate (4 phones × 1,000) this is a host-saturation measurement. Compare runs only on the same host and
  configuration. The before/after comparison in `docs/ROCKET_THROUGHPUT_EVIDENCE.md` follows that rule.
- **No real Meta.** No real Meta or WhatsApp endpoint is ever contacted: the cells refuse any other Graph base URL,
  and the token and phone ids are fake.
