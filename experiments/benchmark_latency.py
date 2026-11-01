"""Measure full Decisions HTTP round-trip latency across frame counts."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import random
import statistics
import time

import httpx
from dotenv import load_dotenv

try:
    from .youtube_frames import ROOT, ENDPOINT, request_body, parse_answers, write_json
except ImportError:
    from youtube_frames import ROOT, ENDPOINT, request_body, parse_answers, write_json


def select_frames(frames: list[dict], count: int) -> list[dict]:
    if not 1 <= count <= len(frames):
        raise ValueError(f"Frame count must be between 1 and {len(frames)}")
    if count == 1:
        return [frames[len(frames) // 2]]
    return [frames[round(i * (len(frames) - 1) / (count - 1))] for i in range(count)]


def summarize(trials: list[dict]) -> list[dict]:
    rows = []
    for count in sorted({trial["frame_count"] for trial in trials}):
        group = [trial for trial in trials if trial["frame_count"] == count]
        valid = [trial for trial in group if trial["valid"]]
        times = [trial["elapsed_seconds"] for trial in valid]
        rows.append({
            "frames": count, "successes": len(valid), "failures": len(group) - len(valid),
            "median_seconds": statistics.median(times) if times else None,
            "mean_seconds": statistics.mean(times) if times else None,
            "min_seconds": min(times) if times else None,
            "max_seconds": max(times) if times else None,
            "request_bytes": group[0]["request_bytes"],
            "cache_hit_calls": sum(trial.get("cached_tokens", 0) > 0 for trial in valid),
            "observed_uncached_median_seconds": statistics.median([
                trial["elapsed_seconds"] for trial in valid if trial.get("cached_tokens") == 0
            ]) if any(trial.get("cached_tokens") == 0 for trial in valid) else None,
            "observed_cached_median_seconds": statistics.median([
                trial["elapsed_seconds"] for trial in valid if trial.get("cached_tokens", 0) > 0
            ]) if any(trial.get("cached_tokens", 0) > 0 for trial in valid) else None,
        })
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=ROOT / "artifacts/wiiFgsDJ8xk-76-102")
    parser.add_argument("--counts", type=int, nargs="+", default=[1, 3, 5, 10, 13])
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts" / (
        "latency-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")))
    args = parser.parse_args()
    if args.repeats < 1 or len(set(args.counts)) != len(args.counts):
        parser.error("Use positive repeats and distinct frame counts")
    load_dotenv(ROOT / ".env")
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        parser.error("Set OPENAI_API_KEY in .env")
    manifest = json.loads((args.dataset / "manifest.json").read_text())
    payloads = {}
    timestamps = {}
    for count in args.counts:
        selected = select_frames(manifest["frames"], count)
        timestamps[count] = [frame["source_seconds"] for frame in selected]
        payloads[count] = json.dumps(request_body(selected, args.dataset), separators=(",", ":")).encode()
    args.output.mkdir(parents=True, exist_ok=False)
    rng = random.Random(args.seed)
    trials = []
    started = datetime.now(timezone.utc).isoformat()
    # Reuse one HTTP client, as a backend would. No automatic retries or warm-up calls.
    with httpx.Client(timeout=120, headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json",
    }) as client:
        for repeat in range(1, args.repeats + 1):
            order = args.counts.copy()
            rng.shuffle(order)
            for count in order:
                trial = {"order": len(trials) + 1, "repeat": repeat, "frame_count": count,
                         "request_bytes": len(payloads[count]), "valid": False,
                         "started_at": datetime.now(timezone.utc).isoformat()}
                began = time.perf_counter()
                try:
                    response = client.post(ENDPOINT, content=payloads[count])
                    trial["elapsed_seconds"] = time.perf_counter() - began
                    trial["http_status"] = response.status_code
                    trial["request_id"] = response.headers.get("x-request-id")
                    response.raise_for_status()
                    body = response.json()
                    write_json(args.output / f"response-{trial['order']:02d}.json", body)
                    trial["probabilities"] = parse_answers(body)
                    trial["valid"] = True
                    trial["usage"] = body.get("usage", {})
                    trial["cached_tokens"] = trial["usage"].get("input_tokens_details", {}).get("cached_tokens", 0)
                    trial["model"] = body.get("model")
                except (httpx.HTTPError, ValueError, RuntimeError) as exc:
                    trial.setdefault("elapsed_seconds", time.perf_counter() - began)
                    trial["error"] = str(exc)
                trials.append(trial)
                write_json(args.output / "trials.json", trials)
                print(f"{trial['order']:02d}/{len(args.counts)*args.repeats}: {count:2d} frames, "
                      f"{trial['elapsed_seconds']:.3f}s, valid={trial['valid']}, "
                      f"cached_tokens={trial.get('cached_tokens', 'unknown')}", flush=True)
    result = {
        "started_at": started, "endpoint": ENDPOINT, "model": "gpt-6-luna",
        "source_url": manifest["url"], "source_start": manifest["start_seconds"],
        "source_end": manifest["end_seconds"], "width_pixels": 512, "questions": 9,
        "repeats": args.repeats, "seed": args.seed, "sample_timestamps": timestamps,
        "method": "Sequential calls; counts shuffled each round; one pooled HTTP client; no retries or warmup. "
                  "Timer surrounds POST through full response body receipt. Payload encoding, image extraction, "
                  "downloading, and response parsing excluded. Network, upload, connection establishment when needed, "
                  "and server processing included. Cache not disabled; observed cached tokens recorded per call. "
                  "Frame subsets span the same prepared clip; visual content varies with sample count.",
        "summary": summarize(trials), "trials": trials,
    }
    write_json(args.output / "benchmark.json", result)
    print("\nFrames | Valid | Median | Min | Max | Cache-hit calls")
    for row in result["summary"]:
        if row["successes"]:
            print(f"{row['frames']:6} | {row['successes']:5} | {row['median_seconds']:.3f}s | "
                  f"{row['min_seconds']:.3f}s | {row['max_seconds']:.3f}s | {row['cache_hit_calls']}")
        else:
            print(f"{row['frames']:6} | 0 valid responses")
    print(f"Saved {args.output / 'benchmark.json'}")


if __name__ == "__main__":
    main()
