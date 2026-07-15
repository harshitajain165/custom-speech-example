/*
 * Streaming custom-TTS example.
 *
 * This module is a reference implementation of the VoiceGateway *streaming*
 * custom-TTS contract. It accepts the VG-shaped POST body on its inbound side
 * and proxies each request to the Deepgram /v1/speak API, streaming Deepgram's
 * WAV response straight back to VoiceGateway chunk-by-chunk.
 *
 * The key difference from the non-streaming examples (google.js, elevenlabs.js)
 * is NOT the request — it is identical — but the response: instead of buffering
 * the full audio and sending it with a Content-Length, we pipe the upstream
 * body directly to the HTTP response so playback can start on the first chunk.
 *
 * ── VoiceGateway streaming custom-TTS contract ──────────────────────────────
 *
 *   Request  (identical to non-streaming custom TTS):
 *     POST <custom_tts_url>
 *     Authorization: Bearer <auth_token>   (omitted if no token configured)
 *     Content-Type: application/json
 *     Accept: audio/wav
 *     {
 *       "text": "Hello, how can I help you today?",
 *       "voice": "aura-2-thalia-en",
 *       "language": "en-US",
 *       "type": "text",            // or "ssml"
 *       "encoding": "linear16",    // always linear16 in v1
 *       "sample_rate": 8000        // always 8000 in v1
 *     }
 *
 *   Response (streaming mode):
 *     HTTP/1.1 200 OK
 *     Content-Type: audio/wav
 *     Transfer-Encoding: chunked
 *     <44-byte RIFF/WAV header><linear16 PCM @ 8000 Hz mono, streamed as chunks>
 *
 *   Requirements:
 *     - Content-Type MUST be audio/wav.
 *     - Body MUST be a standard 44-byte RIFF/WAV header followed by raw
 *       linear16 (signed 16-bit little-endian) PCM at 8000 Hz, mono.
 *     - The body MUST be streamed (chunked / progressively flushed). Do NOT
 *       buffer the entire audio before responding — that defeats streaming.
 *     - Errors are signalled with a non-2xx HTTP status; the body may carry
 *       {"error": "..."} for logging but VG only acts on the status code.
 *
 * See DEVELOPER_GUIDE.md ("Streaming TTS") for the full contract and a walkthrough.
 */
const routes = require('express').Router();
const assert = require('assert');
const https = require('node:https');
const {URL} = require('node:url');

const DEEPGRAM_URL = process.env.DEEPGRAM_URL || 'https://api.deepgram.com/v1/speak';

routes.post('/', async(req, res) => {
  const {logger} = req.app.locals;
  const {text, voice, language, type, encoding, sample_rate} = req.body;

  try {
    assert(process.env.DEEPGRAM_API_KEY, 'DEEPGRAM_API_KEY is not set');
    assert(text, 'text is required');

    /*
     * Deepgram's /v1/speak accepts plain text only — it has no SSML input mode.
     * Reject SSML explicitly rather than reading the markup aloud tag-by-tag,
     * so the contract boundary is clear. A real endpoint backed by an
     * SSML-capable engine would branch on `type` here instead.
     */
    if (type && type !== 'text') {
      return res.status(400).json({error: `type "${type}" is not supported by this example (plain text only)`});
    }

    /* The request VG sends tells us exactly what to produce: linear16 @ 8kHz. */
    const url = new URL(DEEPGRAM_URL);
    if (voice) url.searchParams.set('model', voice);
    url.searchParams.set('encoding', encoding || 'linear16');
    url.searchParams.set('sample_rate', String(sample_rate || 8000));

    const body = JSON.stringify({text});
    const startAt = process.hrtime();

    logger.info({voice, language, encoding, sample_rate}, 'streaming synthesis via deepgram');

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
        /* Drain and surface the upstream error; headers not yet sent to VG. */
        const chunks = [];
        dgRes.on('data', (c) => chunks.push(c));
        dgRes.on('end', () => {
          const detail = Buffer.concat(chunks).toString().slice(0, 512);
          logger.error({status: dgRes.statusCode, detail}, 'deepgram returned non-2xx');
          res.status(502).json({error: `upstream returned status ${dgRes.statusCode}`});
        });
        return;
      }

      /*
       * Stream the WAV response straight through. We deliberately do NOT set a
       * Content-Length: piping the body makes Express use chunked transfer
       * encoding, so VoiceGateway receives audio as it is produced and can
       * begin playback on the first chunk.
       */
      res.set('Content-Type', 'audio/wav');
      dgRes.pipe(res);

      dgRes.on('end', () => {
        const diff = process.hrtime(startAt);
        const rtt = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(0);
        logger.info(`finished streaming speech from deepgram in ${rtt} ms`);
      });
      dgRes.on('error', (err) => {
        /* Headers already sent — can only log and tear the connection down. */
        logger.error({err}, 'error while streaming deepgram response');
        res.destroy(err);
      });
    });

    upstream.on('error', (err) => {
      logger.error({err}, 'deepgram request failed');
      if (!res.headersSent) res.status(502).json({error: 'upstream request failed'});
      else res.destroy(err);
    });

    upstream.end(body);
  } catch (err) {
    logger.info({err}, 'synthAudio: error synthesizing speech using deepgram');
    if (!res.headersSent) res.status(400).json({error: err.message});
  }
});

module.exports = routes;
