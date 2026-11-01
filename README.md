# Look-Ahead — Child Content Safety

A Chrome extension that checks upcoming content against a parent's preferences and intervenes before a flagged section plays. YouTube is the first integration; the longer-term goal is protection across more web content and devices.

**Hackathon demo:** a prepared video plays on YouTube while our backend analyses the matching original file. OpenAI Decisions evaluates sampled frames and speech. A visible timeline shows analysis ahead of playback. Before a flagged section, the extension pauses and covers the player, and a friendly mascot explains the concern and offers a return to safety.

**Status:** planning. This repository currently documents the intended implementation; the extension and backend are not implemented yet.

## What we are proving

- Real model decisions can drive intervention before a concerning video segment plays.
- Parents can choose which categories matter to their family.
- A child-friendly explanation and safe exit make the intervention understandable.
- Segment analysis can be cached and reused with different filtering preferences.

The prototype is a demonstration of content analysis and playback control, not a claim of comprehensive child protection or support for arbitrary YouTube videos.

## Scope for today

### Build first

1. An unpacked Manifest V3 Chrome extension and local FastAPI backend.
2. One short, team-owned demo clip with safe, concerning and safe sections, uploaded to YouTube and registered against its exact original file.
3. Real frame and speech analysis using OpenAI, with timestamped Decisions results.
4. A watch gate: hold playback until the current position and next five seconds are checked.
5. A visible timeline showing the playhead, checked segments and flagged segments, plus live/cache/mock status.
6. An automatic pause, player cover, category reason and **Go to safety** action. Navigate to the previous page only when it is a configured safe destination; otherwise use the extension's bundled safe page.
7. Seek protection: jumping into unchecked content holds playback and reprioritises analysis.
8. A clearly labelled cached replay and scripted mock mode for development and demo backup.

### Complete after the core loop works

- A compact popup with age band, sensitivity and per-category Allow/Warn/Block settings.
- A lightweight animated mascot in the extension overlay and safe page. This is extension UI; embedding ChatGPT's live Pets is not an established dependency.
- **Skip section**, enabled only when the destination has sufficient checked coverage.
- A small manually labelled evaluation set and a recorded backup demo.

### Stretch goals

- Homepage recommendation filtering from titles and channel names. Metadata clearance must never clear video segments.
- A curated safe page populated from configured clips whose full timelines pass the current settings.
- Parent PIN, approval requests and recent-block history.

Defer arbitrary-video downloading, comments ingestion, Shorts, live streams, large-scale shared caches, native mobile apps and network interception. iPad Safari and proxies are future research directions; neither is validated by this demo.

## Architecture

```text
Team-owned original MP4 -> ffmpeg -> sampled frames + audio
                                                     |
                                         OpenAI transcription
                                                     |
Frames + transcript + metadata + age -> OpenAI Decisions
                                                     |
                              Category probabilities -> policy -> SQLite
                                                     |
YouTube player <-> content script <-> background worker <-> FastAPI
```

### Chrome extension

- Use plain JavaScript, HTML and CSS. Keep YouTube selectors in one module.
- Inject covering CSS and the content script at document start. Observe player replacement and YouTube navigation; pause and mute while checking.
- Check continuous coverage through the next five seconds on play, seek, time updates and a short playback timer. Warn verdicts permit playback with a banner; block/review verdicts cover and pause it.
- Resume only when playback was intended. Preserve manual pauses and discard responses from previous videos or settings revisions.
- Route backend requests through the background worker. The content script polls once per second; backend state survives worker restarts.
- Store preferences in `chrome.storage.local`. Default to under 8 and standard sensitivity. Preference changes immediately re-evaluate coverage.
- Unconfigured videos remain paused with a clear demo limitation. Request failures remain paused with Retry.

### Backend and OpenAI integration

- FastAPI on `127.0.0.1:8000`, ffmpeg/ffprobe, SQLite and an in-process work queue. Keep the OpenAI key only in the backend environment.
- Register clips using a manifest containing YouTube ID, original file path, title and channel. Validate file existence and duration before scanning.
- Analyse 10-second segments: sample one frame every two seconds, resize to approximately 512 pixels wide, and extract 16 kHz mono audio.
- Transcribe audio using `gpt-4o-mini-transcribe`. A file with no audio track is valid; a failed transcription leaves the segment unchecked.
- Send timestamped images, transcript and metadata directly to `POST /v1/decisions` using `gpt-6-luna`. Decisions accepts images and text/JSON, not raw video or audio. A separate vision-description model is unnecessary.
- Ask independent predicate questions for each category. Treat metadata and transcripts as evidence, not instructions. Produce short explanations from category templates rather than another generation call.
- Process two segments concurrently, prioritising the playhead and next 30 seconds. Reprioritise pending work on seek and publish each result as it completes.
- Cache category probabilities by file hash, segment, age band, model and analysis version. Reapply parent policy without rescanning when only category actions or sensitivity change. Keep mock and real results separate.
- Model errors, refusals and missing answers leave a segment unchecked. Never silently replace real results with mocks.

### Parent policy

Age bands: under 8, 8–12 and 13+. Categories default as follows; parents can override them when the popup is implemented.

| Category | Under 8 | 8–12 | 13+ |
| --- | --- | --- | --- |
| Violence or gore | Block | Block | Warn |
| Sexual or suggestive content | Block | Block | Block |
| Frightening or disturbing content | Block | Warn | Allow |
| Dangerous stunts or challenges | Block | Block | Warn |
| Drugs, alcohol or smoking | Block | Warn | Allow |
| Bad language | Block | Warn | Allow |
| Children's characters in adult contexts | Block | Block | Block |
| Hate speech or discriminatory attacks | Block | Block | Block |
| Political messaging | Allow | Allow | Allow |
| Religious messaging | Allow | Allow | Allow |

Questions should distinguish hateful attacks from neutral discussion or reporting. Politics and religion are optional family preferences, not intrinsically unsafe labels.

Initial probability thresholds: relaxed `0.85`, standard `0.70`, strict `0.50`. A Block category at or above the threshold blocks; within `0.20` below the threshold it requests review and remains paused. A Warn category at or above threshold shows a banner. Allow categories do not restrict playback. Precedence is block, review, warn, allow. These are starting thresholds to evaluate, not calibrated guarantees.

### API contract

| Method and path | Input | Output |
| --- | --- | --- |
| `GET /health` | — | Readiness, mode and configured demo clip IDs |
| `POST /scan` | Video ID, position, age band and parent policy | Start/reuse/reprioritise scan; return job ID |
| `GET /scan/{job_id}` | — | Status, duration, completed segment results, errors and result provenance |
| `POST /score-metadata` (stretch) | Batched IDs, titles, channels and policy | Per-item actions and categories |

Segment results include `start`, `end`, category probabilities, action (`allow`, `warn`, `block`, `review`) and reason. Pending or failed intervals are not cleared. Polling replaces the original spec's server-sent events for this first version.

## Build order and responsibilities

| Milestone | Product / demo | Modelling | Extension / backend |
| --- | --- | --- | --- |
| 1. Validate the core | Prepare a rights-cleared clip with obvious safe and concerning sections | Test one safe and one concerning segment through transcription and Decisions; record latency | Scaffold the API and extension against scripted verdicts |
| 2. Real look-ahead | Review the timeline, stop reason and safe-exit interaction | Wire frame/audio processing and independent category questions | Connect real results to gating, navigation and seek protection |
| 3. Parent preferences | Add a simple mascot and understandable settings | Apply policy to cached probabilities | Add popup settings, cache replay and optional Skip |
| 4. Rehearse | Run the three-minute demo and record a backup | Check a small labelled set and document misses | Verify error handling, stale-response rejection and setup instructions |

Codex assists implementation. OpenAI Decisions supplies the filtering signals; deterministic application code applies parent policy and controls playback. Roles may be combined depending on the team.

## Evaluation and acceptance

- Start with a small rights-cleared set of labelled segments: safe content, visible concern, spoken concern and neutral discussion of a sensitive topic. Record expected category/action and observed results. Larger licensed benchmarks are follow-up work.
- Verify the demo stops before the flagged interval starts, returns to safety, and optionally skips only to checked content.
- Test forward/backward seeking, manual pause, rapid navigation and settings changes without accepting stale clearance.
- Test backend outage, missing segment results, model refusal, worker restart and cache separation.
- Measure first-clearance latency and contiguous checked-ahead duration. Aim for a first verdict within five seconds and 30 seconds of look-ahead; if scanning falls behind, playback waits.
- Rehearse in an ad-free standard YouTube watch session. Ads and unsupported player modes must not be treated as the registered clip.
- Frame sampling can miss brief events, transcription can fail, and browser event timing requires real-device testing. Report these limits alongside demo results.

## Demo and content sourcing

1. Show the configured age and preferences, or state the fixed defaults if the popup is not ready.
2. Start fresh analysis of the prepared clip and show the checking gate.
3. Play a safe section while the analysis timeline advances ahead.
4. Let the extension stop before the concerning section and explain why.
5. Return to the safe page, or demonstrate a checked Skip destination if implemented.
6. Seek into unchecked content to demonstrate the gate again.

Keep a cached replay and `MOCK_MODELS=true` backup visibly labelled. Provide a cache-reset command during implementation so fresh inference is reproducible.

Analyse our own original file, including audio we have permission to process, and upload a copy for playback. The uploaded copy and original must share the same timeline. Do not download the demonstration media from YouTube or capture its media stream for analysis.

This avoids extracting media from YouTube for the demo; it is not a blanket compliance claim for the extension. Arbitrary-video ingestion and the production playback integration need their own permissions and terms review. Creator-supplied originals and an authorised platform arrangement are possible future routes. A network proxy does not itself resolve content rights or platform terms.

## References

- [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions)
- [OpenAI transcription](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Chrome extension service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [YouTube Terms of Service](https://www.youtube.com/static?gl=GB&template=terms)
- [YouTube API developer policies](https://developers.google.com/youtube/terms/developer-policies)
- [Safari extension support and conversion](https://developer.apple.com/safari/extensions/)
