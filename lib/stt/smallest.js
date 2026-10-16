const WebSocket = require('ws');
const assert = require('assert');

const PULSE_WS_URL = 'wss://api.smallest.ai/waves/v1/stt/live?model=pulse';

const transcribe = async (logger, socket) => {
  socket.on('message', async (data, isBinary) => {
    try {
      if (!isBinary) {
        const obj = JSON.parse(data.toString());
        logger.info({ obj }, 'received JSON message from Cognigy Voice Gateway');
        assert.ok(socket.apiKey, 'bearer token missing on socket');

        if (obj.type === 'start') {
          const { language, sampleRateHz, interimResults } = obj;
          assert.ok(!socket.pulseSocket, 'Expect start only once per connection');

          // Map BCP-47 tag (e.g. "en-US") to ISO 639-1 code expected by Pulse
          const lang = language ? language.split('-')[0] : 'en';
          const sampleRate = sampleRateHz || 16000;

          const wsUrl = new URL(PULSE_WS_URL);
          wsUrl.searchParams.set('language', lang);
          wsUrl.searchParams.set('encoding', 'linear16');
          wsUrl.searchParams.set('sample_rate', String(sampleRate));

          const pulseSocket = new WebSocket(wsUrl.toString(), {
            headers: { Authorization: `Bearer ${socket.apiKey}` },
          });

          pulseSocket
            .on('open', () => {
              logger.info('smallest stt: pulse socket opened');
              socket.pulseSocket = pulseSocket;
            })
            .on('message', (buffer) => {
              try {
                const msg = JSON.parse(buffer.toString());
                const { transcript, is_final } = msg;
                if (transcript == null) return;
                if (!is_final && !interimResults) return;
                if (!is_final && transcript.length === 0) return;

                socket.send(JSON.stringify({
                  type: 'transcription',
                  is_final,
                  alternatives: [{ confidence: 1.0, transcript }],
                  channel: 1,
                  language,
                }));
              } catch (err) {
                logger.error({ err }, 'smallest stt: failed to parse pulse message');
              }
            })
            .on('error', (err) => {
              logger.error({ err }, 'smallest stt: pulse socket error');
            })
            .on('close', () => {
              logger.info('smallest stt: pulse socket closed');
              socket.pulseSocket = null;
              socket.close();
            });
        } else if (obj.type === 'stop') {
          terminateSocket(socket);
        }
      } else {
        // Forward raw binary audio frames directly to Pulse
        if (socket.pulseSocket && socket.pulseSocket.readyState === WebSocket.OPEN) {
          socket.pulseSocket.send(data);
        }
      }
    } catch (err) {
      logger.error({ err }, 'smallest stt: error');
    }
  });

  socket.on('error', (err) => {
    logger.error({ err }, 'smallest stt: cognigy socket error');
  });

  socket.on('close', () => {
    logger.info('smallest stt: cognigy socket closed');
    terminateSocket(socket);
  });
};

const terminateSocket = (socket) => {
  if (socket.pulseSocket) {
    try {
      socket.pulseSocket.send(JSON.stringify({ type: 'close_stream' }));
    } catch (_) {}
    // Don't force-close — Pulse will send the final transcript then close on its own,
    // which triggers the on('close') handler above that calls socket.close().
    socket.pulseSocket = null;
  }
};

module.exports = transcribe;
