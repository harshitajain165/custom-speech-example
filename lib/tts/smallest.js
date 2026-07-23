const routes = require('express').Router();
const assert = require('assert');

const TTS_URL = 'https://api.smallest.ai/waves/v1/tts';

routes.post('/', async (req, res) => {
  const { logger } = req.app.locals;
  const { voice, text } = req.body;
  try {
    assert(process.env.SMALLEST_API_KEY, 'SMALLEST_API_KEY is not set');
    const startAt = process.hrtime();

    const response = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SMALLEST_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'audio/wav',
      },
      body: JSON.stringify({
        text,
        voice_id: voice || 'rhea',
        model: 'lightning_v3.1_pro',
        sample_rate: 8000,
        output_format: 'wav',
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Smallest TTS error ${response.status}: ${errBody}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const diff = process.hrtime(startAt);
    const rtt = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(0);
    logger.info(`successfully synthesized speech using Smallest AI Lightning in ${rtt} ms`);

    res.set('Content-Type', 'audio/wav');
    res.set('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    logger.info({ err }, 'smallest tts: error synthesizing speech');
    res.status(400).json({ error: err.message });
  }
});

module.exports = routes;
