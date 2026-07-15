/*
 * Streaming custom-TTS module backed by Smallest AI Lightning.
 *
 * Implements the VoiceGateway *streaming* custom-TTS contract: the response is
 * chunked WAV (44-byte RIFF header + linear16 PCM @ 8000 Hz mono) — piped
 * straight back with no Content-Length so playback starts on the first chunk.
 * See DEVELOPER_GUIDE.md ("Streaming TTS") for the full contract.
 *
 * Upstream: POST https://api.smallest.ai/waves/v1/tts
 *   body: { text, voice_id, model, sample_rate, output_format: 'wav' }
 *   auth: Bearer <SMALLEST_API_KEY>
 */
const routes = require('express').Router();
const assert = require('assert');
const https = require('node:https');
const {URL} = require('node:url');

const SMALLEST_URL = process.env.SMALLEST_TTS_URL || 'https://api.smallest.ai/waves/v1/tts';
const SMALLEST_MODEL = process.env.SMALLEST_TTS_MODEL || 'lightning_v3.1_pro';
const DEFAULT_VOICE = process.env.SMALLEST_TTS_VOICE || 'meher';

routes.post('/', async (req, res) => {
  const {logger} = req.app.locals;
  const {text, voice, language, type, encoding, sample_rate} = req.body;

  try {
    assert(process.env.SMALLEST_API_KEY, 'SMALLEST_API_KEY is not set');
    assert(text, 'text is required');

    /*
     * Smallest Lightning accepts plain text only. Reject SSML explicitly rather
     * than sending markup through, so the contract boundary is clear.
     */
    if (type && type !== 'text') {
      return res.status(400).json({error: `type "${type}" is not supported by this example (plain text only)`});
    }

    /*
     * The request VG sends tells us exactly what to produce: linear16 @ 8kHz.
     * We forward those knobs to Smallest so it emits WAV at the requested rate;
     * VG will strip the 44-byte header and feed the raw PCM into FreeSWITCH.
     */
    const url = new URL(SMALLEST_URL);
    const upstreamBody = JSON.stringify({
      text,
      voice_id: voice || DEFAULT_VOICE,
      model: SMALLEST_MODEL,
      sample_rate: sample_rate || 8000,
      output_format: 'wav',
    });
    const startAt = process.hrtime();

    logger.info({voice, language, encoding, sample_rate}, 'streaming synthesis via smallest lightning');

    const upstream = https.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SMALLEST_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'audio/wav',
        'Content-Length': Buffer.byteLength(upstreamBody),
      },
    }, (upRes) => {
      if (upRes.statusCode < 200 || upRes.statusCode >= 300) {
        /* Drain and surface the upstream error; headers not yet sent to VG. */
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          const detail = Buffer.concat(chunks).toString().slice(0, 512);
          logger.error({status: upRes.statusCode, detail}, 'smallest returned non-2xx');
          res.status(502).json({error: `upstream returned status ${upRes.statusCode}`});
        });
        return;
      }

      /*
       * Stream the WAV straight through. NOT setting Content-Length makes Express
       * use chunked transfer encoding, so VG receives audio as it is produced.
       */
      res.set('Content-Type', 'audio/wav');
      upRes.pipe(res);

      upRes.on('end', () => {
        const diff = process.hrtime(startAt);
        const rtt = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(0);
        logger.info(`finished streaming speech from smallest in ${rtt} ms`);
      });
      upRes.on('error', (err) => {
        logger.error({err}, 'error while streaming smallest response');
        res.destroy(err);
      });
    });

    upstream.on('error', (err) => {
      logger.error({err}, 'smallest request failed');
      if (!res.headersSent) res.status(502).json({error: 'upstream request failed'});
      else res.destroy(err);
    });

    upstream.end(upstreamBody);
  } catch (err) {
    logger.info({err}, 'synthAudio: error synthesizing speech using smallest');
    if (!res.headersSent) res.status(400).json({error: err.message});
  }
});

module.exports = routes;
