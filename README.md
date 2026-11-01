# codex-hackathon-2026

The goal is to create a Chrome extension that acts as a content safety filter for children. We are focusing on Youtube videos to start with, wherein we want to feed multiple frames from across the video and associated metadata (transcripts, comments etc.) to evaluate whether it contains hate speech, discriminatory content, political content, sexual content, religious content, etc. Parents should be able to provide customized filters to decide how their children access it. If a video is not advisable, a live Openai Pet should redirect the child back to the previous webpage. As an extension, we could even imagine caching classification labels of videos at scale, and serving them based on the custom-set preferences, such that children only already see pre-approved videos.

We need to use the OpenAI stack to implement this, including the Decisions API for filtering, Codex for building this, etc.

## Dividing Responsibilities

### Product

1. Designing a child-friendly interface to the Chrome extension, eg. OpenAI Pets for Kids
2. Ensuring the extension reroutes back to a safe page
3. Using the models to detect if what the child is seeing should be blocked via pop-up
4. Create a demo
### Modelling

1. Downloading a benchmark for evaluating content safety filters for children, specifically focused on Youtube videos.
2. Evaluating OpenAI stack on this benchmark to assess viability
3. Optimizing inference using metadata + avoid downloading videos. How can we get reliable performance while minimizing the cost of OpenAI calls? 
