# Custom Speech Example

This repository serves as an illustrative guide for integrating support for a
custom speech vendor into [Cognigy Voice Gateway](https://www.cognigy.com/platform/cognigy-voice-gateway)
using the speech API. It showcases the incorporation of the following examples:

**TTS**:

- [google](https://cloud.google.com/text-to-speech/docs) — non-streaming
- [elevenlabs](https://beta.elevenlabs.io/) — non-streaming
- [deepgram](https://developers.deepgram.com/docs/text-to-speech) — **streaming** (reference implementation of the streaming TTS contract)
- [Smallest AI Lightning](https://smallest.ai) — **streaming** (WAV/linear16 @ 8 kHz mono)

**STT**:

- [google](https://cloud.google.com/speech-to-text)
- [gladia](https://docs.gladia.io/reference/live-audio)
- [assemblyAI](https://www.assemblyai.com/docs/walkthroughs#realtime-streaming-transcription)
- [Vosk](https://alphacephei.com/vosk/server)
- [Smallest AI Pulse](https://smallest.ai)

## TTS: non-streaming vs. streaming

Custom TTS vendors support two modes over the **same HTTP endpoint**:

| | Non-streaming (default) | Streaming |
|---|---|---|
| How VG plays it | Buffers the full response, writes it to a file, then plays the file | Plays audio as chunks arrive |
| Perceived latency | Full synthesis time + transfer | Time-to-first-byte (~200–500 ms typical) |
| Response format | Any audio format VG can decode (MP3, WAV, OGG, …) | **Streamed WAV** — 44-byte RIFF header + linear16 PCM at 8000 Hz mono |
| Request body | Same JSON body | Same JSON body |
| How to deliver | `res.send(buffer)` with `Content-Length` | Pipe/flush the response body (chunked transfer encoding) |
| Enabled by | Always available | The **"Enable text-to-speech streaming"** checkbox on the custom speech credential |

The request your endpoint receives is **identical** in both modes. The only
difference is how you deliver the response: buffer it (non-streaming) or stream
it (streaming). If your endpoint already returns `audio/wav` at linear16/8 kHz,
enabling streaming is just a matter of streaming the body instead of buffering.

> **The full streaming contract** — request/response shape, WAV format
> requirements, error semantics, and the enablement flow — is documented in
> [DEVELOPER_GUIDE.md → Streaming TTS](DEVELOPER_GUIDE.md#streaming-tts).
> The `deepgram` and `smallest` modules in this repo
> ([`lib/tts/deepgram.js`](lib/tts/deepgram.js),
> [`lib/tts/smallest.js`](lib/tts/smallest.js)) are working reference
> implementations.

## Configuration

You can configure the application to connect to all of the providers or just
some depending on the environment variables supplied.

- To use google, supply `GCP_JSON_KEY_FILE` pointing to your google json key
- To use elevenlabs, supply `ELEVEN_API_KEY` which has your api key
- To use deepgram (streaming TTS), supply `DEEPGRAM_API_KEY`
- To use assemblyAI, supply `ASSEMBLY_AI_API_TOKEN` which has your assemblyAI api key
- To use gladia, supply `GLADIA_API_KEY`
- To use Vosk, supply `VOSK_URL` which has the ip:port of the Vosk server grpc endpoint
- To use Smallest AI (Lightning TTS + Pulse STT), supply `SMALLEST_API_KEY` — get your key from the [Smallest AI console](https://console.smallest.ai)

## Running

```bash
$ npm ci

$ API_KEY=<apikey> \
GCP_JSON_KEY_FILE=<google-json-key-path> \
ASSEMBLY_AI_API_TOKEN=<assemblyai-api-key> \
VOSK_URL=xxxx:yyyy \
GLADIA_API_KEY=xxxxxxxx \
ELEVEN_API_KEY=xxxxxxx \
DEEPGRAM_API_KEY=xxxxxxx \
SMALLEST_API_KEY=<smallest-ai-api-key> \
HTTP_PORT=3000 node app.js
```

Then, in the Cognigy Voice Gateway portal create a custom speech vendor,
providing the wss (for STT) and http(s) (for TTS) URLs to your server,
and your api key (`apikey`).

- **STT** connects over WebSocket at `/transcribe/<provider-name>`.
- **TTS** connects over HTTP POST at `/synthesize/<provider-name>` — for both
  streaming and non-streaming vendors.

To use a **streaming** TTS vendor (e.g. `deepgram` or `smallest`), also check
**"Enable text-to-speech streaming"** on the custom speech credential. Leave it
unchecked to use the non-streaming path.

After adding the custom speech vendors you can use them in a Cognigy Voice Gateway
application. Make sure this application is running and accessible at the URLs
you provisioned into Cognigy Voice Gateway.
