# Making phone calls with `phone`

`phone` places a real call and hands it to an AI voice agent that follows your brief. You are the person it calls for: you watch the live transcript, answer its questions, and steer it if needed. It talks to a real person, so be decisive and quick.

## The loop

```bash
phone call <number> --goal - <<'EOF'
<the brief>
EOF
# prints the transcript live for ~100s, then returns while the call continues
phone wait            # repeat until "CALL ENDED" and the RESULT block
```

`phone wait` returns early when the agent asks you something:

```
[01:12] QUESTION q1 from the voice agent (the other party is waiting): They only take cards over the phone. Which card should I use?
```

Answer right away, then keep waiting:

```bash
phone answer "Say we'll pay cash on delivery; if they refuse, thank them and end the call."
phone wait
```

If nobody answers within `--ask-timeout` seconds (90 by default), the agent carries on without an answer. A late `phone answer` still reaches it.

## Writing the brief

The brief is the only thing the voice agent knows. Write it the way you would brief a sharp human assistant who has never heard of you, and include:

1. **Who they represent.** A name, and how to describe themselves ("calling on behalf of Sam").
2. **The goal**, and what "done" means ("done when the order is placed and you have the total and delivery time").
3. **Every fact they may be asked for:** names, spellings, addresses with unit numbers, callback number, dates, account or order numbers.
4. **Preferences and limits:** acceptable substitutes, price ceiling, time windows, what they may and may not agree to.
5. **Branches:** what to do if the thing is unavailable, they're closed, there's a menu or voicemail, or payment is required.
6. **What to bring back:** details to confirm and read back (total, ETA, confirmation number, name of the person spoken to).

Leave out anything that should never be said. The agent does not invent facts. When it needs one it doesn't have, it asks you mid-call. That costs the other person's patience, so front-load the facts.

Payment: never put full card numbers in a brief unless the human explicitly provided them for this call. Prefer cash or pay-at-pickup, and have the agent ask you if a card is required.

## Steering mid-call

| You want to | Command |
|---|---|
| Change course or add a fact | `phone steer "They're out of large; a medium is fine."` (silent: the agent applies it on its next turn) |
| Put words in its mouth now | `phone say "Could you also add a two-liter Coke?"` |
| Navigate a phone menu yourself | `phone keys 2` (the agent can also press keys itself) |
| End politely / immediately | `phone hangup` / `phone hangup --now` |

Steer only when the call is drifting or you have new information. Phrase steering as an instruction to the agent, not as a line for it to read.

## After the call

The RESULT block gives `goal achieved` (success/failure/unknown), an `outcome` listing the concrete details (totals, times, confirmation numbers), and a summary. Before you report success to anyone, check the claims against `phone transcript`.

## Useful facts

- `[id]` is optional everywhere; it defaults to the latest live call. Several calls can run at once; pass the id when they do.
- The agent waits for the other side to speak first. Use `--first-message` for calls where you should open, for example into a known IVR.
- Exit codes from `call` and `wait`: 0 means the call is over, 2 means still in progress, 3 means a question is waiting for you, 1 means it never connected (busy, no answer, bad number) or an error.
- `phone ls` is the call history (date, status, length, goal achieved). `phone transcript <id>` gives the result followed by every line, timed on the recording's clock; add `--json` for the full record.
- `phone view` opens the call log in a browser for a human, and `phone view <id>` opens one call: summary, recording, and a transcript you can click to jump through the audio. Calls are recorded by default; pass `--no-record` to turn that off.
- The agent says it is an AI if asked. It hangs up on voicemail unless the brief says what message to leave.

## Example brief

```
You're calling Joe's Pizza on behalf of Sam Lee to order one large pepperoni pizza for delivery.

Delivery address: 100 Main Street, Apt 4B, Springfield, NY 10001. Callback number: 718-555-0100. Name for the order: Sam.
Payment: cash on delivery. If they only take cards by phone, ask me before agreeing to anything.
If there's no large, a medium is fine. If they don't deliver to that address, ask if they know the nearest place that does, then end the call politely.
Done when the order is placed. Before hanging up, confirm the total and the estimated delivery time, and read back the address.
```
