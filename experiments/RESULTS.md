# First live run — 2026-11-01

- Source: https://www.youtube.com/watch?v=wiiFgsDJ8xk
- Title: YouTube's Disturbing "Kids" Channels #elsagate
- Interval: 76–102 seconds (1:16–1:42), downloaded with yt-dlp 2026.10.26.
- Input: 13 JPEG images, 512 pixels wide, sampled every two seconds at source times 76 through 100. No audio, transcript, video title, or description sent to the model.
- Model/endpoint: `gpt-6-luna`, `POST /v1/decisions`.
- One real request; no mock results. API round-trip: **5.981 seconds**, excluding downloading and frame extraction.
- Usage: 3,514 input tokens, 0 output tokens, 0 cached input tokens; 2,020 cache-write tokens reported.

| Visual category | Returned probability |
| --- | ---: |
| Violence | 0.96 |
| Frightening content | 0.44 |
| Dangerous behavior | 0.13 |
| Sexual content | 0.00 |
| Substance use | 0.00 |
| Hate or discrimination | 0.00 |
| Visible profanity | 0.00 |
| Political content | 0.00 |
| Religious content | 0.00 |

This establishes that the downloaded images can reach Decisions and yield validated category probabilities. It is one sample, not an accuracy benchmark. The source is commentary about disturbing children's videos; the visual-only request cannot assess its spoken context. A returned zero is not proof that a category is absent. These results describe the sampled interval as a group and do not locate the onset of concerning content.

The local raw request, response, and manifest are in `artifacts/wiiFgsDJ8xk-76-102/`. Media and base64 image payloads are excluded from Git. Four validation tests pass for timestamps, complete category results, refusals, duplicate/missing answers, and invalid probabilities.
