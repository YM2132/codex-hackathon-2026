# Decisions latency benchmark — 2026-11-01

**25/25 calls returned complete, valid category answers.** Five calls per frame count, nine questions per request, 512-pixel-wide JPEGs, `gpt-6-luna`. This run used the existing 1:16–1:42 samples from `wiiFgsDJ8xk`, not the newly shared uploaded video.

| Frames per request | Calls | Median | Mean | Min–max | Request size | Calls with cached tokens |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 5 | 0.812s | 0.762s | 0.507–1.064s | 18.6 kB | 0/5 |
| 3 | 5 | 0.615s | 0.783s | 0.576–1.123s | 60.4 kB | 0/5 |
| 5 | 5 | 0.428s | 0.736s | 0.321–1.590s | 94.6 kB | 0/5 |
| 10 | 5 | 0.876s | 1.055s | 0.589–2.169s | 184.0 kB | 4/5 |
| 13 | 5 | 1.033s | 1.390s | 0.499–3.026s | 234.0 kB | 5/5 |

## How to interpret this

These are full client-observed HTTP round-trips, including network and image upload. Downloading, frame extraction, payload encoding, and JSON parsing are outside the timer. One HTTP client was reused, requests ran sequentially, and frame-count order was shuffled each round with seed 42. There was no warmup or retry. The first call included connection establishment.

Each size uses an evenly distributed subset of the same 13 prepared frames (the single-image case uses the middle frame). All images in a request are classified together. The inputs repeat between rounds. No latency optimization or model substitution was applied.

**Cache matters:** four of five 10-frame calls and all five 13-frame calls reported cached input tokens. The one 10-frame call with zero cached tokens took 2.169s; the median of its four cached calls was 0.796s. There is no uncached 13-frame result in this benchmark. Zero reported cached tokens is not proof of entirely cold backend execution.

The smaller requests are not consistently faster: network/server variation, visual content, ordering, and caching can all affect this small sample. Five calls per size are insufficient for a reliable production p95 or a claim that five frames are optimal. This benchmark does not measure classification quality, concurrency, sustained throughput, or the full download-to-verdict pipeline.

For the extension, these results support trying small frame batches, but playback should remain gated until the relevant result arrives. Budget for the observed multi-second outliers, and benchmark new frame windows plus extraction before making a real-time guarantee.

## Reproduce and inspect

```sh
uv run python experiments/benchmark_latency.py --counts 1 3 5 10 13 --repeats 5
```

The command expects the prepared dataset described in [the experiment instructions](README.md). Each invocation makes 25 billable calls by default. [All measured trials and metadata](benchmarks/2026-11-01.json) are committed without credentials or image payloads. Raw API responses remain local under `artifacts/latency-benchmark-2026-11-01/`.
