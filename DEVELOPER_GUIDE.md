# Developer Guide: Creating STT and TTS Modules

This guide explains how to develop custom Speech-to-Text (STT) and Text-to-Speech (TTS) modules for Cognigy Voice Gateway, as well as how external providers should structure their APIs to be compatible with this integration framework.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Creating an STT Module](#creating-an-stt-module)
3. [Creating a TTS Module](#creating-a-tts-module)
   - [Streaming TTS](#streaming-tts)
4. [External Provider Requirements](#external-provider-requirements)
5. [Message Format Specifications](#message-format-specifications)
6. [Testing Your Module](#testing-your-module)
7. [Best Practices](#best-practices)

---

> ## The Streaming TTS Contract
>
> Custom TTS vendors can run in **non-streaming** mode (VG buffers your full
> response, then plays it) or **streaming** mode (VG plays audio as chunks
> arrive, cutting latency to time-to-first-byte).
>
> **The request is identical in both modes.** The only difference is the
> response:
>
> | | Non-streaming | Streaming |
> |---|---|---|
> | Response body | Any format VG can decode (MP3/WAV/OGG/…) | **Streamed WAV**: 44-byte RIFF header + linear16 PCM @ **8000 Hz mono** |
> | Delivery | `res.send(buffer)` with `Content-Length` | Pipe/flush the body (chunked transfer encoding), no `Content-Length` |
> | Enabled by | Always available | **"Enable text-to-speech streaming"** checkbox on the credential |
>
> [`lib/tts/deepgram.js`](lib/tts/deepgram.js) is a working reference
> implementation. See [Streaming TTS](#streaming-tts) below for the full
> contract and a walkthrough.

---

## Architecture Overview

### Project Structure

```
.
├── app.js                   # Main application entry point
├── lib/
│   ├── stt/
│   │   ├── index.js        # STT router
│   │   ├── google.js       # Google STT implementation
│   │   ├── assemblyAi.js   # AssemblyAI STT implementation
│   │   ├── gladia.js       # Gladia STT implementation
│   │   ├── vosk.js         # Vosk STT implementation
│   │   └── smallest.js     # Smallest AI Pulse STT implementation
│   └── tts/
│       ├── index.js        # TTS router
│       ├── google.js       # Google TTS implementation (non-streaming)
│       ├── elevenlabs.js   # ElevenLabs TTS implementation (non-streaming)
│       ├── deepgram.js     # Deepgram TTS implementation (STREAMING — reference impl)
│       └── smallest.js     # Smallest AI Lightning TTS implementation (STREAMING)
```

### Communication Protocols

- **STT**: WebSocket-based streaming protocol at `/transcribe/<provider-name>`
- **TTS**: HTTP POST endpoint at `/synthesize/<provider-name>` — for **both**
  streaming and non-streaming vendors. Streaming is achieved by streaming the
  HTTP response body, not by using a different transport (see
  [Streaming TTS](#streaming-tts)).
- **Authentication**: Bearer token via `Authorization` header

### Key Components

1. **WebSocket Server** (`wsServer`): Handles real-time audio streaming for STT
2. **Express HTTP Server** (`app`): Handles TTS synthesis requests
3. **Router Modules**: Route requests to appropriate provider implementations
4. **Provider Modules**: Implement the actual integration with external speech services

---

## Creating an STT Module

### Step 1: Create the Module File

Create a new file in `lib/stt/` directory, e.g., `lib/stt/yourprovider.js`:

```javascript
const transcribeYourProvider = async(logger, socket) => {
  // Your implementation here
};

module.exports = transcribeYourProvider;
```

### Step 2: Register the Module

Add your module to `lib/stt/index.js`:

```javascript
const path = require('node:path');
const transcribe = async(logger, socket, url) => {
  const p = path.basename(url);
  switch (p) {
    case 'google':
      return require('./google')(logger, socket);
    case 'assemblyAI':
      return require('./assemblyAI')(logger, socket);
    case 'vosk':
      return require('./vosk')(logger, socket);
    case 'yourprovider':  // Add your provider here
      return require('./yourprovider')(logger, socket);
    default:
      logger.info(`unknown stt vendor: ${p}`);
      socket.close();
  }
};

module.exports = transcribe;
```

### Step 3: Implement the WebSocket Handler

Your STT module receives:
- `logger`: Pino logger instance for logging
- `socket`: WebSocket connection from Voice Gateway

#### Required Implementation Pattern

```javascript
const transcribeYourProvider = async(logger, socket) => {
  // Handle incoming messages from Voice Gateway
  socket.on('message', async(data, isBinary) => {
    try {
      if (!isBinary) {
        // Handle JSON control messages
        const obj = JSON.parse(data.toString());
        logger.info({obj}, 'received JSON message from VoiceGateway');

        if (obj.type === 'start') {
          // Initialize transcription session
          const {language, sampleRateHz, interimResults} = obj;
          
          // Connect to your STT provider
          // Store provider connection on socket object
          // Start streaming audio
        }
        else if (obj.type === 'stop') {
          // Clean up transcription session
          // Close provider connection
          // Close socket
        }
      }
      else {
        // Handle binary audio data
        // Forward to your STT provider
        // Audio format: LINEAR16 PCM, sample rate from 'start' message
      }
    } catch (err) {
      logger.error({err}, 'transcribeYourProvider: error');
    }
  });

  // Handle socket lifecycle events
  socket.on('error', (err) => {
    logger.error({err}, 'transcribeYourProvider: error');
    // Clean up provider connection
  });

  socket.on('close', (data) => {
    logger.info({data}, 'transcribeYourProvider: close');
    // Clean up provider connection
  });

  socket.on('end', (err) => {
    logger.error({err}, 'transcribeYourProvider: socket closed from VoiceGateway');
    // Clean up provider connection
  });
};

module.exports = transcribeYourProvider;
```

### Step 4: Handle the 'start' Message

When you receive a `start` message, initialize your transcription session:

```javascript
if (obj.type === 'start') {
  const {language, sampleRateHz, interimResults} = obj;
  
  // Prevent multiple start messages
  assert.ok(!socket.providerConnection, 'Expect start only once per connection');
  
  // Connect to your STT provider
  const providerConnection = await connectToProvider({
    language,
    sampleRateHz,
    interimResults
  });
  
  // Store connection on socket for later use
  socket.providerConnection = providerConnection;
  
  // Listen for transcription results from provider
  providerConnection.on('transcription', (result) => {
    // Transform to Voice Gateway format and send
    const obj = {
      type: 'transcription',
      is_final: result.isFinal,
      alternatives: [{
        confidence: result.confidence,
        transcript: result.text
      }],
      channel: 1,
      language: language
    };
    socket.send(JSON.stringify(obj));
  });
}
```

### Step 5: Handle Binary Audio Data

Process incoming audio data and forward to your provider:

```javascript
else {
  // Binary audio data
  if (socket.providerConnection) {
    // Forward audio to your provider
    // Format depends on your provider's requirements
    socket.providerConnection.sendAudio(data);
  }
}
```

### Step 6: Handle the 'stop' Message

Clean up when transcription ends:

```javascript
else if (obj.type === 'stop') {
  if (socket.providerConnection) {
    socket.providerConnection.close();
    socket.providerConnection = null;
  }
  socket.close();
}
```

### Complete STT Module Examples

#### Example 1: REST API Provider (like AssemblyAI)

```javascript
const Websocket = require('ws');
const assert = require('assert');

const transcribeRestProvider = async(logger, socket) => {
  socket.on('message', async(data, isBinary) => {
    try {
      if (!isBinary) {
        const obj = JSON.parse(data.toString());
        logger.info({obj}, 'received JSON message from VoiceGateway');

        if (obj.type === 'start') {
          const {language, sampleRateHz, interimResults} = obj;
          assert.ok(!socket.providerSocket, 'Expect start only once per connection');

          // Connect to provider's WebSocket endpoint
          const providerSocket = new Websocket(
            `wss://your-provider.com/stream?sample_rate=${sampleRateHz}&language=${language}`
          );
          
          providerSocket
            .on('message', (buffer) => {
              const data = JSON.parse(buffer.toString());
              
              // Transform provider response to Voice Gateway format
              const obj = {
                type: 'transcription',
                is_final: data.is_final,
                alternatives: [{
                  confidence: data.confidence,
                  transcript: data.text
                }],
                channel: 1,
                language
              };
              socket.send(JSON.stringify(obj));
            })
            .on('open', () => {
              logger.info('connected to provider');
              socket.providerSocket = providerSocket;
            })
            .on('error', (err) => {
              logger.error({err}, 'provider error');
              socket.send(JSON.stringify({
                type: 'error',
                error: err.message
              }));
            })
            .on('close', () => {
              logger.info('provider connection closed');
              socket.providerSocket = null;
            });
        } 
        else if (obj.type === 'stop') {
          cleanup(socket);
        }
      }
      else {
        // Binary audio data
        if (socket.providerSocket && socket.providerSocket.readyState === Websocket.OPEN) {
          // Send audio to provider (format depends on provider)
          socket.providerSocket.send(data);
        }
      }
    } catch (err) {
      logger.error({err}, 'error');
      cleanup(socket);
    }
  });

  socket.on('error', (err) => {
    logger.error({err}, 'socket error');
    cleanup(socket);
  });

  socket.on('close', () => {
    logger.info('socket closed');
    cleanup(socket);
  });
};

const cleanup = (socket) => {
  if (socket.providerSocket) {
    socket.providerSocket.close();
    socket.providerSocket = null;
  }
};

module.exports = transcribeRestProvider;
```

#### Example 2: gRPC Provider (like Vosk)

```javascript
const grpc = require('@grpc/grpc-js');
const assert = require('assert');

const transcribeGrpcProvider = async(logger, socket) => {
  socket.on('message', async(data, isBinary) => {
    try {
      if (!isBinary) {
        const obj = JSON.parse(data.toString());
        logger.info({obj}, 'received JSON message from VoiceGateway');

        if (obj.type === 'start') {
          const {language, sampleRateHz, interimResults} = obj;
          assert.ok(!socket.stream, 'Expect start only once per connection');

          // Create gRPC client
          const client = new YourGrpcClient(
            process.env.GRPC_ENDPOINT,
            grpc.credentials.createInsecure()
          );
          
          // Create bidirectional stream
          const stream = client.streamingRecognize();
          
          // Send initial configuration
          const configRequest = createConfigRequest({
            language,
            sampleRateHz,
            interimResults
          });
          stream.write(configRequest);
          
          socket.stream = stream;

          // Handle responses
          stream.on('data', (response) => {
            const obj = {
              type: 'transcription',
              is_final: response.isFinal,
              alternatives: [{
                confidence: response.confidence,
                transcript: response.text
              }],
              channel: 1,
              language: language
            };
            socket.send(JSON.stringify(obj));
          });

          stream.on('error', (error) => {
            logger.error({error}, 'stream error');
            socket.send(JSON.stringify({
              type: 'error',
              error: error.message
            }));
          });

          stream.on('end', () => {
            logger.info('stream ended');
          });
        } 
        else if (obj.type === 'stop') {
          closeStream(socket);
        }
      } 
      else {
        // Binary audio data
        if (socket.stream) {
          const audioRequest = createAudioRequest(data);
          socket.stream.write(audioRequest);
        }
      }
    } catch (err) {
      logger.error({err}, 'error');
      closeStream(socket);
    }
  });

  socket.on('error', (err) => {
    logger.error({err}, 'socket error');
    closeStream(socket);
  });

  socket.on('close', () => {
    logger.info('socket closed');
    closeStream(socket);
  });
};

const closeStream = (socket) => {
  if (socket.stream) {
    socket.stream.end();
    socket.stream = null;
  }
};

module.exports = transcribeGrpcProvider;
```

#### Example 3: Native SDK Provider (like Google Speech)

```javascript
const YourProviderSDK = require('@your-provider/speech');
const Websocket = require('ws');
const assert = require('assert');

const transcribeSDKProvider = async(logger, socket) => {
  // Initialize SDK client
  const client = new YourProviderSDK.SpeechClient({
    credentials: loadCredentials()
  });

  socket.on('message', (data, isBinary) => {
    try {
      if (!isBinary) {
        const obj = JSON.parse(data.toString());
        logger.info({obj}, 'received JSON message from VoiceGateway');

        if (obj.type === 'start') {
          assert.ok(!socket.recognizeStream, 'Expect start only once per connection');
          const {language, sampleRateHz, interimResults} = obj;

          // Create streaming recognition
          socket.recognizeStream = client.streamingRecognize({
            config: {
              encoding: 'LINEAR16',
              sampleRateHertz: sampleRateHz,
              languageCode: language
            },
            interimResults
          })
            .on('error', (err) => {
              logger.error({err}, 'recognition error');
              socket.send(JSON.stringify({
                type: 'error',
                error: err.message
              }));
            })
            .on('data', (data) => {
              // Transform SDK response to Voice Gateway format
              if (data.results?.length > 0) {
                const obj = {
                  type: 'transcription',
                  is_final: data.results[0].isFinal,
                  alternatives: data.results[0].alternatives.map((alt) => ({
                    confidence: alt.confidence,
                    transcript: alt.transcript
                  })),
                  channel: data.results[0].channelTag || 1,
                  language: data.results[0].languageCode || language
                };
                socket.send(JSON.stringify(obj));
              }
            })
            .on('end', () => {
              logger.info('recognition stream ended');
            });

          // Pipe audio directly from WebSocket to recognition stream
          const duplex = socket.duplex = Websocket.createWebSocketStream(socket);
          duplex.pipe(socket.recognizeStream);
        }
        else if (obj.type === 'stop') {
          if (socket.duplex) {
            socket.duplex.unpipe(socket.recognizeStream);
            socket.duplex = null;
          }
          socket.recognizeStream.end();
          socket.recognizeStream = null;
          socket.close();
        }
      }
    } catch (err) {
      logger.error({err}, 'error');
    }
  });

  socket.on('error', (err) => {
    logger.error({err}, 'socket error');
  });

  socket.on('end', () => {
    logger.info('socket ended');
  });
};

module.exports = transcribeSDKProvider;
```

---

## Creating a TTS Module

### Step 1: Create the Module File

Create a new file in `lib/tts/` directory, e.g., `lib/tts/yourprovider.js`:

```javascript
const router = require('express').Router();

router.post('/', async(req, res) => {
  // Your implementation here
});

module.exports = router;
```

### Step 2: Register the Module

Add your module to `lib/tts/index.js`:

```javascript
const router = require('express').Router();

router.use('/google', require('./google'));
router.use('/yourprovider', require('./yourprovider'));  // Add your provider

module.exports = router;
```

### Step 3: Implement the HTTP Handler

Your TTS module receives HTTP POST requests with synthesis parameters.

#### Required Implementation Pattern

```javascript
const router = require('express').Router();

router.post('/', async(req, res) => {
  const {logger} = req.app.locals;
  const {language, voice, type, text} = req.body;

  try {
    // 1. Initialize your TTS provider client
    const client = initializeProvider();

    // 2. Prepare synthesis request
    const opts = {
      voice: voice,
      language: language,
      // ... other options
    };

    // 3. Call provider API
    const audioContent = await client.synthesize({
      input: type === 'ssml' ? {ssml: text} : {text},
      ...opts
    });

    // 4. Return audio response
    res.set('Content-Type', 'audio/mpeg'); // or audio/wav, audio/ogg, etc.
    res.set('Content-Length', audioContent.length);
    res.send(audioContent);

  } catch (err) {
    logger.error({err}, 'synthesis error');
    res.status(400).json({error: err.message});
  }
});

module.exports = router;
```

### Complete TTS Module Examples

#### Example 1: REST API Provider

```javascript
const router = require('express').Router();
const axios = require('axios');

router.post('/', async(req, res) => {
  const {logger} = req.app.locals;
  const {language, voice, type, text} = req.body;

  try {
    logger.info({language, voice, type}, 'synthesizing speech');

    // Call provider's REST API
    const response = await axios.post(
      'https://your-provider.com/tts/synthesize',
      {
        text: type === 'ssml' ? text : text,
        voice_id: voice,
        language_code: language,
        output_format: 'mp3',
        ssml: type === 'ssml'
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.PROVIDER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer'
      }
    );

    const audioContent = Buffer.from(response.data);
    
    logger.info('successfully synthesized speech');
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioContent.length);
    res.send(audioContent);

  } catch (err) {
    logger.error({err}, 'synthesis error');
    res.status(400).json({error: err.message});
  }
});

module.exports = router;
```

#### Example 2: SDK Provider (like Google)

```javascript
const router = require('express').Router();
const YourProviderTTS = require('@your-provider/text-to-speech');
const fs = require('fs');
const assert = require('assert');
let credentials;

router.post('/', async(req, res) => {
  const {logger} = req.app.locals;
  const {language, voice, type, text} = req.body;
  let client;

  try {
    // Load credentials lazily
    if (!credentials) {
      assert.ok(
        process.env.PROVIDER_CREDENTIALS_FILE,
        'PROVIDER_CREDENTIALS_FILE env var is required'
      );
      const json = fs.readFileSync(process.env.PROVIDER_CREDENTIALS_FILE, 'utf-8');
      credentials = JSON.parse(json);
    }

    // Initialize client
    client = new YourProviderTTS.TextToSpeechClient({credentials});

    // Prepare synthesis options
    const opts = {
      voice: {
        name: voice,
        languageCode: language
      },
      audioConfig: {
        audioEncoding: 'MP3'
      },
      input: type === 'ssml' ? {ssml: text} : {text}
    };

    logger.info({opts}, 'sending synthesis request');

    // Synthesize speech
    const [response] = await client.synthesizeSpeech(opts);
    
    // Clean up
    client.close();

    logger.info('successfully synthesized speech');
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', response.audioContent.length);
    res.send(response.audioContent);

  } catch (err) {
    logger.error({err}, 'synthesis error');
    client && client.close();
    res.status(400).json({error: err.message});
  }
});

module.exports = router;
```

---

## Streaming TTS

Everything above returns audio in **non-streaming** mode: your handler buffers
the full audio and sends it in one shot. Custom TTS vendors can also run in
**streaming** mode, where Voice Gateway begins playback as soon as the first
audio chunk arrives — reducing perceived latency from *full synthesis time +
transfer* down to *time-to-first-byte*.

> This section specifies the streaming contract in full and walks through the
> reference implementation in [`lib/tts/deepgram.js`](lib/tts/deepgram.js).

### The contract at a glance

Same endpoint, same request — the response is what changes.

#### Request (identical to non-streaming)

```http
POST /synthesize/<provider-name> HTTP/1.1
Authorization: Bearer <auth_token>
Content-Type: application/json
Accept: audio/wav

{
  "text": "Hello, how can I help you today?",
  "voice": "<voice_id>",
  "language": "en-US",
  "type": "text",            // or "ssml"
  "encoding": "linear16",    // always linear16 in v1
  "sample_rate": 8000        // always 8000 in v1
}
```

| Field | Type | Notes |
|-------|------|-------|
| `text` | string | Text to synthesize (SSML if `type` is `"ssml"`). |
| `voice` | string | Voice identifier configured on the credential. |
| `language` | string | BCP-47 language tag (e.g. `en-US`). |
| `type` | string | `"text"` or `"ssml"`. |
| `encoding` | string | Requested encoding — always `"linear16"` in v1. Informational: honor it or ignore it if your endpoint always produces linear16. |
| `sample_rate` | number | Requested sample rate — always `8000` in v1. |

- `encoding` and `sample_rate` are **new** compared to the non-streaming body;
  they tell your endpoint exactly what format VG expects so you can avoid
  resampling guesswork.
- `voice`, `language`, `type` are the **same** fields sent in non-streaming
  mode — so a single handler can serve both contracts.
- If no auth token is configured on the credential, the `Authorization` header
  is omitted.

#### Response (streaming mode)

```http
HTTP/1.1 200 OK
Content-Type: audio/wav
Transfer-Encoding: chunked

<44-byte RIFF/WAV header><linear16 PCM @ 8000 Hz mono, streamed as chunks>
```

**Requirements — these are strict in streaming mode:**

1. **`Content-Type: audio/wav`.**
2. **Format:** a standard 44-byte RIFF/WAV header followed by raw **linear16**
   (signed 16-bit little-endian) PCM at **8000 Hz, mono**. VG strips the 44-byte
   header and feeds the raw PCM into FreeSWITCH. The `data` chunk size in the
   header may be `0` or `0xFFFFFFFF` if the total length is unknown up front.
3. **Stream the body** — use chunked transfer encoding or progressively flush.
   Do **not** buffer the whole audio before responding; that defeats streaming.
   (In Express, simply *not* setting `Content-Length` and piping to `res`
   produces a chunked response.)

> **Non-streaming is more permissive:** it accepts any format VG can decode
> (WAV, MP3, OGG, raw PCM). Streaming requires WAV/linear16/8000 Hz
> specifically.

#### Errors

Signal failures with a non-2xx HTTP status:

| Status | Meaning |
|--------|---------|
| 4xx | Client error (bad request, auth failure) |
| 5xx | Server error |
| 200 + empty body | Treated as synthesis failure |

The body may carry `{"error": "..."}` for logging, but VG only acts on the
status code. Note that a **mid-stream** failure (connection dropped after
headers are sent) results in truncated audio — there is no mid-stream error
recovery in v1.

### Enabling streaming

Streaming activates only when **all** of these are true:

1. **"Enable text-to-speech streaming"** is checked on the custom speech
   credential (per-credential, customer-controlled opt-in).
2. The credential has a TTS URL configured.
3. The synthesis is a live call (not a cache-render pass).

If any is false, VG uses the non-streaming HTTP POST path. To roll back, uncheck
the box — the next call uses the non-streaming path, no restart required.

> **Note:** custom TTS streaming is gated *only* by the credential checkbox. The
> cluster-wide `JAMBONES_DISABLE_TTS_STREAMING` kill-switch for built-in vendors
> does **not** apply to custom vendors, so streaming works even on clusters
> where built-in streaming is disabled.

### Reference implementation

[`lib/tts/deepgram.js`](lib/tts/deepgram.js) implements the contract by
proxying to Deepgram's `/v1/speak` API and piping its WAV response straight
back. The essential shape:

```javascript
const routes = require('express').Router();
const https = require('node:https');
const {URL} = require('node:url');

routes.post('/', async(req, res) => {
  const {logger} = req.app.locals;
  const {text, voice, language, type, encoding, sample_rate} = req.body;

  // The request tells us exactly what to produce: linear16 @ 8 kHz.
  const url = new URL('https://api.deepgram.com/v1/speak');
  if (voice) url.searchParams.set('model', voice);
  url.searchParams.set('encoding', encoding || 'linear16');
  url.searchParams.set('sample_rate', String(sample_rate || 8000));

  const body = JSON.stringify({text});
  const upstream = https.request(url, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'audio/wav',
      'Content-Length': Buffer.byteLength(body)
    }
  }, (dgRes) => {
    if (dgRes.statusCode < 200 || dgRes.statusCode >= 300) {
      // Upstream failed and we haven't sent headers yet — return a clean error.
      return res.status(502).json({error: `upstream returned ${dgRes.statusCode}`});
    }

    // Stream the WAV straight through. NOT setting Content-Length makes Express
    // use chunked transfer encoding, so VG can start playback on chunk one.
    res.set('Content-Type', 'audio/wav');
    dgRes.pipe(res);
  });

  upstream.on('error', (err) => {
    logger.error({err}, 'deepgram request failed');
    if (!res.headersSent) res.status(502).json({error: 'upstream request failed'});
    else res.destroy(err);
  });

  upstream.end(body);
});

module.exports = routes;
```

Key points, and the pitfalls they avoid:

1. **Don't set `Content-Length`.** Piping the body makes the response chunked,
   which is what lets VG start playback early. A `Content-Length` forces the
   platform (and often the runtime) to buffer.
2. **Ask for the format VG requested.** Use `encoding`/`sample_rate` from the
   body so the upstream engine emits linear16/8000 Hz and no resampling is
   needed.
3. **Handle errors before vs. after headers.** Before the first byte you can
   still send a clean non-2xx status; once streaming has started you can only
   log and tear down the connection.
4. **SSML:** Deepgram is plain-text only, so the full module rejects
   `type: "ssml"` with a 400. An SSML-capable engine would branch on `type`
   instead.

### Upgrading a non-streaming endpoint

If your endpoint already returns `audio/wav` at linear16/8000 Hz, enabling
streaming requires **no synthesis changes** — just stream the response body
(chunked) instead of buffering it, then check the streaming box on the
credential. If your endpoint returns MP3/OGG or a different PCM format, switch
it to WAV/linear16/8000 Hz mono (most engines expose format parameters — drive
them from the `encoding`/`sample_rate` fields VG sends).

---

## External Provider Requirements

This section describes what external STT and TTS providers need to implement to be compatible with this integration framework.

### STT Provider Requirements

If you are building an external STT service that should work with this integration, your service must:

#### 1. Support WebSocket Connections

Your service should accept WebSocket connections for real-time audio streaming.

#### 2. Handle Configuration Parameters

Accept and honor these configuration parameters:
- `language` or `languageCode`: BCP-47 language code (e.g., "en-US", "de-DE")
- `sampleRate` or `sampleRateHz`: Audio sample rate in Hz (typically 8000 or 16000)
- `interimResults` or `partialResults`: Boolean indicating whether to return interim results

#### 3. Accept Audio Format

Accept audio in **LINEAR16 PCM** format (raw PCM audio, 16-bit signed integer, little-endian).

#### 4. Return Transcription Results

Return transcription results that include:
- **transcript/text**: The transcribed text
- **is_final/isFinal**: Boolean indicating if this is a final result
- **confidence**: Confidence score (0.0 to 1.0)
- Optional: **alternatives**: Multiple transcription hypotheses

#### 5. Protocol Options

Your service can implement one of these protocols:

##### Option A: WebSocket with JSON Messages

```javascript
// Client sends audio via WebSocket binary frames
// Server responds with JSON messages:
{
  "text": "hello world",
  "is_final": true,
  "confidence": 0.95
}
```

##### Option B: WebSocket with Binary + JSON

```javascript
// Client sends binary audio frames
// Server responds with JSON for transcriptions:
{
  "transcript": "hello world",
  "isFinal": true,
  "confidence": 0.95,
  "alternatives": [
    {"transcript": "hello world", "confidence": 0.95},
    {"transcript": "hello word", "confidence": 0.05}
  ]
}
```

##### Option C: gRPC Streaming

```protobuf
service SpeechRecognition {
  rpc StreamingRecognize(stream StreamingRecognizeRequest)
    returns (stream StreamingRecognizeResponse);
}

message StreamingRecognizeRequest {
  oneof streaming_request {
    RecognitionConfig config = 1;
    bytes audio_content = 2;
  }
}

message StreamingRecognizeResponse {
  repeated SpeechRecognitionResult results = 1;
}

message SpeechRecognitionResult {
  repeated SpeechRecognitionAlternative alternatives = 1;
  bool is_final = 2;
}

message SpeechRecognitionAlternative {
  string transcript = 1;
  float confidence = 2;
}
```

#### Example STT Provider Implementation (Node.js)

```javascript
const Websocket = require('ws');

const wss = new Websocket.Server({ port: 8080 });

wss.on('connection', (ws) => {
  console.log('Client connected');
  
  let config = null;
  let audioBuffer = Buffer.alloc(0);

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      // Configuration message
      config = JSON.parse(data.toString());
      console.log('Received config:', config);
      // Initialize your speech recognition with config
    } else {
      // Audio data
      audioBuffer = Buffer.concat([audioBuffer, data]);
      
      // Process audio when you have enough
      if (audioBuffer.length >= 8000) { // Example: 0.5s at 16kHz
        processAudio(audioBuffer, config, (result) => {
          ws.send(JSON.stringify({
            text: result.transcript,
            is_final: result.isFinal,
            confidence: result.confidence
          }));
        });
        audioBuffer = Buffer.alloc(0);
      }
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    // Clean up resources
  });
});
```

### TTS Provider Requirements

If you are building an external TTS service that should work with this integration, your service must:

#### 1. Support HTTP POST Requests

Accept POST requests for speech synthesis.

#### 2. Handle Request Parameters

Accept these parameters in the request body (JSON):
- `text`: The text to synthesize
- `type`: Either "text" or "ssml" (SSML support optional)
- `language`: BCP-47 language code
- `voice`: Voice identifier/name
- `encoding`, `sample_rate`: sent in **streaming** mode (always `"linear16"` /
  `8000` in v1) — see [Streaming TTS](#streaming-tts)

Request format:
```json
{
  "text": "Hello, world!",
  "type": "text",
  "language": "en-US",
  "voice": "en-US-Neural2-A"
}
```

For SSML:
```json
{
  "text": "<speak>Hello, <break time='500ms'/> world!</speak>",
  "type": "ssml",
  "language": "en-US",
  "voice": "en-US-Neural2-A"
}
```

#### 3. Return Audio Response

**Non-streaming mode** — buffer the audio and return it with:
- `Content-Type`: MIME type of audio (e.g., `audio/mpeg`, `audio/wav`, `audio/ogg`)
- `Content-Length`: Size of audio data in bytes
- Body: Raw audio data

**Streaming mode** — stream the body instead:
- `Content-Type`: `audio/wav` (required)
- **No `Content-Length`** — send chunked (a 44-byte RIFF header + linear16 PCM
  @ 8000 Hz mono, flushed progressively)
- See the full rules in [Streaming TTS](#streaming-tts).

#### 4. Supported Audio Formats

**Non-streaming** accepts any format VG can decode (choose one or support several):
- **MP3** (`audio/mpeg`): Compressed, good for streaming
- **WAV** (`audio/wav`): Uncompressed, higher quality
- **OGG** (`audio/ogg`): Compressed, open format
- **PCM** (`audio/l16`): Raw audio

**Streaming** requires **WAV specifically**: a 44-byte RIFF header + linear16
(signed 16-bit little-endian) PCM at **8000 Hz, mono**. MP3/OGG/headerless PCM
are not accepted on the streaming path.

#### 5. Error Handling

Return appropriate HTTP status codes:
- `200`: Success
- `400`: Bad request (invalid parameters)
- `401`: Unauthorized (invalid API key)
- `429`: Rate limit exceeded
- `500`: Server error

Error response format:
```json
{
  "error": "Error message description"
}
```

#### Example TTS Provider Implementation (Node.js + Express)

```javascript
const express = require('express');
const app = express();

app.use(express.json());

app.post('/synthesize', async (req, res) => {
  try {
    const {text, type, language, voice} = req.body;

    // Validate request
    if (!text || !language || !voice) {
      return res.status(400).json({
        error: 'Missing required parameters: text, language, voice'
      });
    }

    // Check if SSML
    const isSSML = type === 'ssml';
    
    // Synthesize speech (your implementation)
    const audioBuffer = await synthesizeSpeech({
      text,
      isSSML,
      language,
      voice,
      format: 'mp3'
    });

    // Return audio
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioBuffer.length);
    res.send(audioBuffer);

  } catch (err) {
    console.error('Synthesis error:', err);
    res.status(500).json({error: err.message});
  }
});

app.listen(3000, () => {
  console.log('TTS server listening on port 3000');
});
```

#### Example with Streaming Response

To satisfy the VoiceGateway [Streaming TTS](#streaming-tts) contract the streamed
body must be **WAV / linear16 / 8000 Hz mono**, and you must **not** set a
`Content-Length` (piping to `res` yields a chunked response):

```javascript
app.post('/synthesize', async (req, res) => {
  try {
    const {text, type, language, voice, encoding, sample_rate} = req.body;

    // Produce the exact format VG asked for: linear16 @ 8 kHz, in a WAV container.
    const audioStream = createSynthesisStream({
      text,
      isSSML: type === 'ssml',
      language,
      voice,
      format: 'wav',
      encoding: encoding || 'linear16',
      sampleRate: sample_rate || 8000
    });

    // audio/wav is required; do NOT set Content-Length — let the body stream.
    res.set('Content-Type', 'audio/wav');

    // Pipe chunk-by-chunk so VG can start playback on the first chunk.
    audioStream.pipe(res);

    audioStream.on('error', (err) => {
      console.error('Stream error:', err);
      // Only a clean status is possible before the first byte is sent.
      if (!res.headersSent) res.status(500).json({error: err.message});
      else res.destroy(err);
    });

  } catch (err) {
    console.error('Synthesis error:', err);
    if (!res.headersSent) res.status(500).json({error: err.message});
  }
});
```

See [`lib/tts/deepgram.js`](lib/tts/deepgram.js) for a complete, runnable
reference implementation.

---

## Message Format Specifications

### STT Message Formats

#### 1. From Voice Gateway to Your Service

##### Start Message
```json
{
  "type": "start",
  "language": "en-US",
  "sampleRateHz": 16000,
  "interimResults": true
}
```

Fields:
- `type`: Always "start"
- `language`: BCP-47 language code (e.g., "en-US", "de-DE", "fr-FR")
- `sampleRateHz`: Sample rate in Hz (typically 8000 or 16000)
- `interimResults`: Boolean indicating whether interim results are requested

##### Stop Message
```json
{
  "type": "stop"
}
```

Fields:
- `type`: Always "stop"

##### Audio Data
- Format: Binary WebSocket frames
- Encoding: LINEAR16 PCM (raw PCM audio, 16-bit signed integer, little-endian)
- Sample rate: As specified in the `start` message
- Channels: Mono (1 channel)

#### 2. From Your Service to Voice Gateway

##### Transcription Message
```json
{
  "type": "transcription",
  "is_final": true,
  "alternatives": [
    {
      "confidence": 0.95,
      "transcript": "hello world"
    },
    {
      "confidence": 0.05,
      "transcript": "hello word"
    }
  ],
  "channel": 1,
  "language": "en-US"
}
```

Fields:
- `type`: Always "transcription"
- `is_final`: Boolean indicating whether this is a final result (true) or interim result (false)
- `alternatives`: Array of transcription alternatives, ordered by confidence (highest first)
  - `confidence`: Confidence score from 0.0 to 1.0 (optional for interim results)
  - `transcript`: The transcribed text
- `channel`: Channel number (typically 1)
- `language`: Language code of the transcription

##### Error Message
```json
{
  "type": "error",
  "error": "Error message description"
}
```

Fields:
- `type`: Always "error"
- `error`: Human-readable error message

### TTS Message Formats

#### 1. Request (HTTP POST Body)

```json
{
  "text": "Hello, world!",
  "type": "text",
  "language": "en-US",
  "voice": "en-US-Neural2-A"
}
```

Fields:
- `text`: The text to synthesize (plain text or SSML)
- `type`: Either "text" or "ssml"
- `language`: BCP-47 language code
- `voice`: Voice identifier (provider-specific)
- `encoding`, `sample_rate`: sent only in **streaming** mode (always
  `"linear16"` / `8000` in v1) — see [Streaming TTS](#streaming-tts)

##### SSML Example
```json
{
  "text": "<speak>Hello, <break time='500ms'/> world!</speak>",
  "type": "ssml",
  "language": "en-US",
  "voice": "en-US-Neural2-A"
}
```

#### 2. Response

##### Success Response (non-streaming)
- Status Code: `200 OK`
- Headers:
  - `Content-Type`: Audio MIME type (e.g., `audio/mpeg`, `audio/wav`)
  - `Content-Length`: Size in bytes
- Body: Raw audio data (buffered)

##### Success Response (streaming)
- Status Code: `200 OK`
- Headers:
  - `Content-Type`: `audio/wav` (required)
  - `Transfer-Encoding`: `chunked` (no `Content-Length`)
- Body: 44-byte RIFF/WAV header + linear16 PCM @ 8000 Hz mono, streamed
  chunk-by-chunk. See [Streaming TTS](#streaming-tts).

##### Error Response
- Status Code: `400` (Bad Request) or `500` (Server Error)
- Headers:
  - `Content-Type`: `application/json`
- Body:
```json
{
  "error": "Error message description"
}
```

---

## Testing Your Module

### Testing STT Modules

#### 1. Unit Testing

Create a test file `test/stt/yourprovider.test.js`:

```javascript
const assert = require('assert');
const EventEmitter = require('events');
const transcribeYourProvider = require('../../lib/stt/yourprovider');

describe('YourProvider STT', () => {
  let mockSocket;
  let mockLogger;

  beforeEach(() => {
    mockSocket = new EventEmitter();
    mockSocket.send = jest.fn();
    mockSocket.close = jest.fn();

    mockLogger = {
      info: jest.fn(),
      error: jest.fn()
    };
  });

  it('should handle start message', async () => {
    await transcribeYourProvider(mockLogger, mockSocket);

    const startMessage = JSON.stringify({
      type: 'start',
      language: 'en-US',
      sampleRateHz: 16000,
      interimResults: true
    });

    mockSocket.emit('message', Buffer.from(startMessage), false);

    // Assert provider connection was established
    assert.ok(mockSocket.providerConnection);
  });

  it('should forward audio data', async () => {
    await transcribeYourProvider(mockLogger, mockSocket);

    // Send start message
    const startMessage = JSON.stringify({
      type: 'start',
      language: 'en-US',
      sampleRateHz: 16000,
      interimResults: false
    });
    mockSocket.emit('message', Buffer.from(startMessage), false);

    // Send audio data
    const audioData = Buffer.alloc(3200); // 0.1s of 16kHz audio
    mockSocket.emit('message', audioData, true);

    // Assert audio was forwarded to provider
    // (implementation depends on your provider)
  });

  it('should handle transcription results', async () => {
    await transcribeYourProvider(mockLogger, mockSocket);

    // Send start message
    const startMessage = JSON.stringify({
      type: 'start',
      language: 'en-US',
      sampleRateHz: 16000,
      interimResults: true
    });
    mockSocket.emit('message', Buffer.from(startMessage), false);

    // Simulate provider sending transcription
    // (implementation depends on your provider)

    // Assert transcription was sent to Voice Gateway
    assert(mockSocket.send.mock.calls.length > 0);
    const sentMessage = JSON.parse(mockSocket.send.mock.calls[0][0]);
    assert.equal(sentMessage.type, 'transcription');
    assert(sentMessage.alternatives);
  });

  it('should handle stop message', async () => {
    await transcribeYourProvider(mockLogger, mockSocket);

    // Send start message
    const startMessage = JSON.stringify({
      type: 'start',
      language: 'en-US',
      sampleRateHz: 16000,
      interimResults: false
    });
    mockSocket.emit('message', Buffer.from(startMessage), false);

    // Send stop message
    const stopMessage = JSON.stringify({type: 'stop'});
    mockSocket.emit('message', Buffer.from(stopMessage), false);

    // Assert cleanup occurred
    assert.ok(!mockSocket.providerConnection);
    assert(mockSocket.close.mock.calls.length > 0);
  });
});
```

#### 2. Integration Testing

Test with actual WebSocket connection:

```javascript
const Websocket = require('ws');

const testSTT = async () => {
  const ws = new Websocket('ws://localhost:3000/transcribe/yourprovider', {
    headers: {
      'Authorization': 'Bearer your-api-key'
    }
  });

  ws.on('open', () => {
    console.log('Connected');

    // Send start message
    ws.send(JSON.stringify({
      type: 'start',
      language: 'en-US',
      sampleRateHz: 16000,
      interimResults: true
    }));

    // Send audio data
    // Read from audio file and send in chunks
    const audioBuffer = fs.readFileSync('test-audio.raw');
    const chunkSize = 3200; // 0.1s at 16kHz
    let offset = 0;

    const interval = setInterval(() => {
      if (offset >= audioBuffer.length) {
        clearInterval(interval);
        // Send stop message
        ws.send(JSON.stringify({type: 'stop'}));
        return;
      }

      const chunk = audioBuffer.slice(offset, offset + chunkSize);
      ws.send(chunk);
      offset += chunkSize;
    }, 100); // Send every 100ms
  });

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    console.log('Received:', message);
  });

  ws.on('error', (err) => {
    console.error('Error:', err);
  });

  ws.on('close', () => {
    console.log('Connection closed');
  });
};

testSTT();
```

### Testing TTS Modules

#### 1. Unit Testing

Create a test file `test/tts/yourprovider.test.js`:

```javascript
const request = require('supertest');
const express = require('express');
const yourProviderRouter = require('../../lib/tts/yourprovider');

describe('YourProvider TTS', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.locals.logger = {
      info: jest.fn(),
      error: jest.fn()
    };
    app.use('/synthesize/yourprovider', yourProviderRouter);
  });

  it('should synthesize text', async () => {
    const response = await request(app)
      .post('/synthesize/yourprovider')
      .send({
        text: 'Hello, world!',
        type: 'text',
        language: 'en-US',
        voice: 'en-US-Standard-A'
      })
      .expect(200);

    assert.equal(response.headers['content-type'], 'audio/mpeg');
    assert(response.body.length > 0);
  });

  it('should synthesize SSML', async () => {
    const response = await request(app)
      .post('/synthesize/yourprovider')
      .send({
        text: '<speak>Hello, <break time="500ms"/> world!</speak>',
        type: 'ssml',
        language: 'en-US',
        voice: 'en-US-Standard-A'
      })
      .expect(200);

    assert.equal(response.headers['content-type'], 'audio/mpeg');
    assert(response.body.length > 0);
  });

  it('should return error for missing parameters', async () => {
    const response = await request(app)
      .post('/synthesize/yourprovider')
      .send({
        text: 'Hello, world!'
        // Missing language and voice
      })
      .expect(400);

    assert(response.body.error);
  });
});
```

#### 2. Integration Testing

Test with actual HTTP request:

```javascript
const axios = require('axios');
const fs = require('fs');

const testTTS = async () => {
  try {
    const response = await axios.post(
      'http://localhost:3000/synthesize/yourprovider',
      {
        text: 'Hello, world!',
        type: 'text',
        language: 'en-US',
        voice: 'en-US-Standard-A'
      },
      {
        headers: {
          'Authorization': 'Bearer your-api-key',
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer'
      }
    );

    // Save audio to file
    fs.writeFileSync('output.mp3', Buffer.from(response.data));
    console.log('Audio saved to output.mp3');

  } catch (err) {
    console.error('Error:', err.message);
    if (err.response) {
      console.error('Response:', err.response.data);
    }
  }
};

testTTS();
```

### Manual Testing with cURL

#### Testing TTS (non-streaming):
```bash
curl -X POST http://localhost:3000/synthesize/yourprovider \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello, world!",
    "type": "text",
    "language": "en-US",
    "voice": "en-US-Standard-A"
  }' \
  --output output.mp3
```

#### Testing TTS (streaming):

Send the streaming body (note `encoding`/`sample_rate`) and save the WAV. The
`-N`/`--no-buffer` flag lets you observe chunks arriving progressively:

```bash
curl -N -X POST http://localhost:3000/synthesize/deepgram \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -H "Accept: audio/wav" \
  -d '{
    "text": "Hello, world!",
    "type": "text",
    "language": "en-US",
    "voice": "aura-2-thalia-en",
    "encoding": "linear16",
    "sample_rate": 8000
  }' \
  --output output.wav

# Verify it is linear16, 8000 Hz, mono:
#   ffprobe output.wav      # or: soxi output.wav
```

#### Testing STT:
Use a WebSocket client tool like `wscat`:
```bash
npm install -g wscat

# Connect
wscat -c "ws://localhost:3000/transcribe/yourprovider" \
  -H "Authorization: Bearer your-api-key"

# Then send messages:
{"type":"start","language":"en-US","sampleRateHz":16000,"interimResults":true}
# Send binary audio data...
{"type":"stop"}
```

---

## Best Practices

### General

1. **Logging**: Use the provided logger extensively for debugging and monitoring
   ```javascript
   logger.info({param1, param2}, 'descriptive message');
   logger.error({err}, 'error occurred');
   ```

2. **Error Handling**: Always wrap in try-catch and handle errors gracefully
   ```javascript
   try {
     // Your code
   } catch (err) {
     logger.error({err}, 'operation failed');
     // Clean up resources
     // Send error to client if appropriate
   }
   ```

3. **Resource Cleanup**: Always clean up connections when sockets close
   ```javascript
   socket.on('close', () => {
     if (socket.providerConnection) {
       socket.providerConnection.close();
       socket.providerConnection = null;
     }
   });
   ```

4. **Assertions**: Use assertions to prevent invalid states
   ```javascript
   const assert = require('assert');
   assert.ok(!socket.recognizeStream, 'Expect start only once per connection');
   ```

### STT Best Practices

1. **Audio Buffering**: Some providers require minimum audio duration per request
   ```javascript
   socket.audioBuffer = [];
   
   // In binary message handler:
   socket.audioBuffer.push(data);
   if (socket.audioBuffer.length > 4) { // e.g., 100ms of audio
     const audioData = Buffer.concat(socket.audioBuffer);
     socket.audioBuffer = [];
     sendToProvider(audioData);
   }
   ```

2. **Interim Results**: Honor the `interimResults` flag
   ```javascript
   if (!is_final && !interimResults) return; // Skip interim results if not requested
   ```

3. **Stream Management**: Keep track of stream state
   ```javascript
   socket.providerStream = stream;
   // Later:
   if (socket.providerStream) {
     socket.providerStream.end();
     socket.providerStream = null;
   }
   ```

4. **Confidence Scores**: Always include confidence when available
   ```javascript
   alternatives: [{
     confidence: result.confidence || 0.0,
     transcript: result.text
   }]
   ```

### TTS Best Practices

1. **Credential Caching**: Load credentials once and reuse
   ```javascript
   let credentials; // Module-level variable
   
   if (!credentials) {
     credentials = loadCredentials();
   }
   ```

2. **Client Pooling**: Reuse clients when possible
   ```javascript
   let clientPool = [];
   
   function getClient() {
     return clientPool.pop() || createNewClient();
   }
   
   function releaseClient(client) {
     clientPool.push(client);
   }
   ```

3. **SSML Support**: Handle both text and SSML appropriately
   ```javascript
   const input = type === 'ssml' ? {ssml: text} : {text: text};
   ```

4. **Audio Format**: Choose appropriate format based on use case
   - MP3: Good compression, widely supported
   - WAV: Uncompressed, better quality
   - OGG: Open format, good compression

5. **Streaming**: To cut latency, stream the response instead of buffering it.
   In streaming mode the body must be **WAV/linear16/8000 Hz mono** and must
   **not** carry a `Content-Length` (pipe it so it goes out chunked). See
   [Streaming TTS](#streaming-tts).
   ```javascript
   res.set('Content-Type', 'audio/wav'); // no Content-Length → chunked
   synthStream.pipe(res);
   ```

### Security Best Practices

1. **Environment Variables**: Never hardcode credentials
   ```javascript
   const apiKey = process.env.PROVIDER_API_KEY;
   assert.ok(apiKey, 'PROVIDER_API_KEY must be set');
   ```

2. **Input Validation**: Validate all inputs
   ```javascript
   if (!language || !voice || !text) {
     return res.status(400).json({error: 'Missing required parameters'});
   }
   ```

3. **Error Messages**: Don't expose sensitive information in error messages
   ```javascript
   res.status(500).json({error: 'Internal server error'}); // Not the full stack trace
   ```

### Performance Best Practices

1. **Lazy Loading**: Load dependencies only when needed
   ```javascript
   let provider;
   function getProvider() {
     if (!provider) {
       provider = require('./expensive-module');
     }
     return provider;
   }
   ```

2. **Connection Pooling**: Reuse connections when possible

3. **Async Operations**: Use async/await properly
   ```javascript
   const result = await provider.transcribe(audio);
   ```

4. **Memory Management**: Clean up buffers and streams
   ```javascript
   socket.audioBuffer = null;
   stream.removeAllListeners();
   ```

### Documentation Best Practices

1. **Function Comments**: Document parameters and return values
   ```javascript
   /**
    * Transcribes audio using YourProvider
    * @param {Object} logger - Pino logger instance
    * @param {WebSocket} socket - WebSocket connection from Voice Gateway
    * @returns {Promise<void>}
    */
   const transcribeYourProvider = async(logger, socket) => {
     // ...
   };
   ```

2. **Configuration Documentation**: Document required environment variables
   ```javascript
   // Required environment variables:
   // - PROVIDER_API_KEY: API key for YourProvider
   // - PROVIDER_ENDPOINT: Endpoint URL (optional, defaults to production)
   ```

3. **Example Usage**: Provide examples in comments or README
   ```javascript
   // Example usage:
   // $ PROVIDER_API_KEY=abc123 node app.js
   ```

---

## Additional Resources

### Sample Audio Files for Testing

For testing STT modules, you'll need audio files in LINEAR16 PCM format:

```bash
# Convert MP3 to LINEAR16 PCM using ffmpeg
ffmpeg -i input.mp3 -acodec pcm_s16le -ar 16000 -ac 1 output.raw

# Convert WAV to LINEAR16 PCM
ffmpeg -i input.wav -acodec pcm_s16le -ar 16000 -ac 1 output.raw
```

### Useful Tools

- **wscat**: WebSocket testing tool
  ```bash
  npm install -g wscat
  ```

- **Postman**: HTTP API testing

- **ffmpeg**: Audio format conversion

- **sox**: Audio manipulation and analysis
  ```bash
  # Play raw PCM audio
  sox -t raw -r 16000 -e signed -b 16 -c 1 audio.raw -d
  ```

### Common Issues and Solutions

1. **WebSocket Connection Fails**
   - Check API key is correct
   - Verify path is `/transcribe/<provider-name>`
   - Check firewall settings

2. **Audio Not Transcribed**
   - Verify audio format is LINEAR16 PCM
   - Check sample rate matches configuration
   - Ensure audio is loud enough

3. **TTS Returns Error**
   - Validate all required parameters are provided
   - Check voice name is correct for the language
   - Verify SSML is well-formed if using SSML

4. **Streaming TTS: no audio / garbled / falls back to non-streaming**
   - Response must be `audio/wav`, linear16, **exactly 8000 Hz, mono** — a
     16000/22050 Hz stream sounds fast/garbled or fails
   - Do **not** set `Content-Length` on the streamed response (it prevents
     chunked delivery); pipe the body instead
   - Confirm **"Enable text-to-speech streaming"** is checked on the credential
     — otherwise VG uses the non-streaming path
   - See the [Streaming TTS](#streaming-tts) contract for the full checklist

5. **Memory Leaks**
   - Ensure all event listeners are removed
   - Close streams and connections properly
   - Clear buffers when done

### Environment Variables Reference

Common environment variables used across modules:

```bash
# Authentication
API_KEY=your-api-key-here

# Server Configuration
HTTP_PORT=3000
LOGLEVEL=info  # debug, info, warn, error

# Provider-specific (examples)
GCP_JSON_KEY_FILE=/path/to/credentials.json
ELEVEN_API_KEY=your-elevenlabs-key
DEEPGRAM_API_KEY=your-deepgram-key   # used by the streaming TTS example
SMALLEST_API_KEY=your-smallest-key   # used by Smallest AI Lightning TTS + Pulse STT
ASSEMBLY_AI_API_TOKEN=your-assemblyai-token
GLADIA_API_KEY=your-gladia-key
VOSK_URL=localhost:5000
PROVIDER_API_KEY=your-provider-key
PROVIDER_ENDPOINT=https://api.provider.com
```

---

## Conclusion

This guide covered:

✅ Creating STT modules for various provider types (REST, gRPC, SDK)  
✅ Creating TTS modules for various provider types  
✅ The [streaming TTS contract](#streaming-tts) (chunked WAV/linear16/8 kHz) and a reference implementation  
✅ Requirements for external STT/TTS providers  
✅ Complete message format specifications  
✅ Testing strategies and examples  
✅ Best practices for production-ready code  

### Next Steps

1. Choose a speech provider to integrate
2. Create your module following the examples
3. Test thoroughly with the provided testing strategies
4. Deploy and configure in Cognigy Voice Gateway
5. Monitor logs and performance

### Getting Help

If you encounter issues:
1. Check the existing implementations in `lib/stt/` and `lib/tts/`
2. Review the logs with `LOGLEVEL=debug`
3. Test with the manual testing tools provided
4. Refer to the provider's API documentation

Happy coding! 🎉