# YouTube frames → Decisions experiment

Downloads the interval **1:16–1:42** from `wiiFgsDJ8xk`, extracts one JPEG every two seconds (13 images, at source times 76–100s), and sends the images together to `POST https://api.openai.com/v1/decisions` with `gpt-6-luna`.

Each category is an independent predicate. The output is a probability per category for the sampled interval, not a timestamp for an unsafe event or an automatic child-safety verdict. Political and religious content are descriptive tags. This experiment does not analyze speech or infer what happens between sampled frames.

## Setup

Requires Python 3.11+, `uv`, `ffmpeg`, `ffprobe`, and Node.js for yt-dlp's YouTube extraction. Dependencies are locked in `uv.lock`.

```sh
uv sync
cp .env.example .env
# Set OPENAI_API_KEY in .env (never commit this file).
```

## Run

```sh
uv run python experiments/youtube_frames.py
```

The defaults use the requested URL and interval. To customize:

```sh
uv run python experiments/youtube_frames.py \
  --url 'https://www.youtube.com/watch?v=wiiFgsDJ8xk' \
  --start 1:16 --end 1:42 --interval 2 \
  --output artifacts/another-run
```

Preparation creates a new output directory and refuses to overwrite an existing run. To prepare without calling the API, use `--prepare-only`. To send an already-prepared request (each invocation makes a fresh, billable call):

```sh
uv run python experiments/youtube_frames.py --classify-only \
  --output artifacts/wiiFgsDJ8xk-76-102
```

Use `--clip /path/to/already-trimmed.mp4` to skip downloading. This file must contain only the selected interval; `--start` is then its timestamp offset in the original source. Preparation checks the duration within 0.5s, but does not independently verify content alignment against YouTube.

Artifacts are local and ignored by Git:

- `download/clip.*`: the requested clip and downloader metadata.
- `frames/`: JPEG samples, resized to 512 pixels wide.
- `manifest.json`: source interval and sample timestamps.
- `request.json`: exact API request including base64 image data, without credentials.
- `response.json`: raw successful HTTP response (saved even if category validation fails).
- `report.json`: validated probabilities, usage, and API latency in seconds.
- `api-error.json`: HTTP error details if the call fails.

Refused, missing, duplicate, or invalid category answers fail the run rather than being treated as safe. Download failures are logged; use a new output directory for a fresh preparation attempt. No browser cookies are accessed. Keep media/requests local; this download experiment does not establish production ingestion permissions.

```sh
uv run python -m unittest discover -s tests -v
```

API format: [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions), [create endpoint](https://developers.openai.com/api/reference/resources/decisions/methods/create).
