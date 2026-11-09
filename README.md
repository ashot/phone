# phone

A CLI for agents to place real phone calls. An AI voice agent (ElevenLabs) talks on the line and follows your brief. You follow the live transcript, answer its questions, and steer it as the call happens.

```
phone call 718-555-1234 --goal-file brief.md   # dial; streams the transcript for ~100s
phone wait                                     # repeat until CALL ENDED + RESULT
phone answer "Cash only, no card."             # reply to the agent's QUESTION
phone steer "They're out of large; medium is fine."
phone hangup
```

For people, `phone view` opens the call log as a page, and `phone view <id>` opens one call with its summary, recording, and a clickable transcript. For agents, `phone ls` and `phone transcript <id>` give the same information as text.

Run `phone` for every command and `phone guide` for how to write briefs. The guide is also in [GUIDE.md](GUIDE.md).

## Prompt snippet for agents

Paste this into an agent's instructions:

```markdown
## Phone calls
`phone` places real calls handled by an AI voice agent that follows your brief. Run `phone` for commands and `phone guide` before your first call.
- Put everything in the brief (`--goal -` with a heredoc, or `--goal-file`): who you represent, the goal and what "done" means, every fact they may ask for (names, addresses, callback number), limits and fallbacks, and what to bring back.
- `phone call <number> --goal ...` streams the transcript for about 100s, then returns while the call continues. Loop `phone wait` until it prints CALL ENDED and a RESULT.
- A QUESTION means a real person is waiting: answer quickly and concretely with `phone answer "<answer>"`. Use `phone steer "<instruction>"` to change course mid-call, `phone say "<text>"` to have the agent say something now, and `phone hangup` to end the call.
- Before you report the outcome, check it against `phone transcript`. The call is outward-facing: only call numbers and make commitments that your task allows.
```

## How it works

Each call gets its own background daemon (`phone _daemon <id>`) that:

1. Starts a cloudflared quick tunnel. It checks the route through Cloudflare's edge by IP and never looks up the new hostname, because any resolver asked too early would cache NXDOMAIN.
2. Places the call through Twilio. The call's TwiML connects a bidirectional media stream to the tunnel.
3. Bridges the 8 kHz mu-law audio to the `phone-cli` ElevenLabs agent over its websocket. Your brief is wrapped in phone-craft instructions (`src/prompt.ts`) and passed as a per-call prompt override.
4. Writes every event to `~/.phone/calls/<id>/events.jsonl` and takes commands on `~/.phone/calls/<id>/control.sock`:
   - `steer` sends a `contextual_update`.
   - `say` and late answers send a `user_message` that makes the agent take a turn.
   - `answer` returns the result of the async `ask_requester` client tool, so the agent keeps talking while you think.
   - `keys` injects synthesized DTMF tones into the stream.
5. After the call, collects the ElevenLabs analysis (a `goal_achieved` evaluation, an `outcome` data field, and a summary), caches the final transcript, and downloads the recording.
6. `src/timeline.ts` builds one record per call, with lines placed on the recording's clock. `transcript`, `ls`, and the page (`src/page.html`, written to `~/.phone/index.html`) all render from that record.

`phone listen <our-number>` flips this around. It points one of our Twilio numbers at the daemon, answers the next incoming call with a voice agent, and restores the number afterwards. It works as a simulated counterparty for rehearsing a brief without calling anyone real.

## Setup

```
brew install cloudflared
ELEVENLABS_API_KEY=... TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... phone setup --from +1XXXXXXXXXX
phone doctor
```

`setup` checks the credentials and creates or updates the `phone-cli` voice agent: phone audio format, tools, turn-taking tuned for phone calls, and post-call analysis. It saves `~/.config/phone/config.json` with mode 600. Rerun it after changing `src/providers.ts`. Environment variables override the file: `ELEVENLABS_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `PHONE_FROM`, `PHONE_AGENT_ID`, `PHONE_VOICE_ID`, `PHONE_LLM`.

Install with `ln -s $PWD/src/cli.ts ~/.local/bin/phone` (needs bun).

## License

MIT
