const WebSocket = require('ws');

const WS_TTS_URL = 'wss://api.smallest.ai/waves/v1/tts/live';

const ttsStreamingSmallest = async (logger, socket, url) => {
  // url e.g. "/synthesize/smallest?voice=rhea&language=en&sampleRate=8000"
  const searchParams = new URL(url, 'http://localhost').searchParams;

  const voiceId = searchParams.get('voice') || 'rhea';
  const sampleRate = parseInt(searchParams.get('sampleRate') || '8000', 10);
  const model = searchParams.get('model') || 'lightning_v3.1_pro';

  let smallestSocket = null;
  let textBuffer = '';
  let pendingText = '';

  const openSmallestSocket = () => {
    if (smallestSocket && (smallestSocket.readyState === WebSocket.OPEN || smallestSocket.readyState === WebSocket.CONNECTING)) return;

    smallestSocket = new WebSocket(WS_TTS_URL, {
      headers: { Authorization: `Bearer ${process.env.SMALLEST_API_KEY}` },
    });
    socket.smallestSocket = smallestSocket;

    smallestSocket
      .on('open', () => {
        logger.info('smallest tts streaming: socket opened');
        if (pendingText) {
          sendToSmallest(pendingText);
          pendingText = '';
        }
      })
      .on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.status === 'chunk' && data.data?.audio) {
            socket.send(Buffer.from(data.data.audio, 'base64'), { binary: true });
          }
        } catch (err) {
          logger.error({ err }, 'smallest tts streaming: failed to parse message');
        }
      })
      .on('error', (err) => {
        logger.error({ err }, 'smallest tts streaming: smallest socket error');
      })
      .on('close', () => {
        logger.info('smallest tts streaming: smallest socket closed');
        smallestSocket = null;
        socket.smallestSocket = null;
      });
  };

  const sendToSmallest = (text) => {
    if (!text.trim()) return;
    if (!smallestSocket || smallestSocket.readyState !== WebSocket.OPEN) {
      pendingText = text;
      openSmallestSocket();
      return;
    }
    smallestSocket.send(JSON.stringify({ text, voice_id: voiceId, model, sample_rate: sampleRate }));
  };

  // Acknowledge the connection to Cognigy Voice Gateway
  socket.send(JSON.stringify({
    type: 'connect',
    data: { sample_rate: sampleRate, base64_encoding: false },
  }));

  openSmallestSocket();

  socket.on('message', async (data, isBinary) => {
    try {
      if (!isBinary) {
        const obj = JSON.parse(data.toString());
        logger.info({ obj }, 'received JSON message from Cognigy Voice Gateway');

        switch (obj.type) {
          case 'stream':
            textBuffer += obj.text || '';
            break;
          case 'flush':
            if (textBuffer.trim()) {
              sendToSmallest(textBuffer);
              textBuffer = '';
            }
            break;
          case 'stop':
            terminateSocket(socket);
            break;
        }
      }
    } catch (err) {
      logger.error({ err }, 'smallest tts streaming: error');
    }
  });

  socket.on('error', (err) => {
    logger.error({ err }, 'smallest tts streaming: cognigy socket error');
  });

  socket.on('close', () => {
    logger.info('smallest tts streaming: cognigy socket closed');
    terminateSocket(socket);
  });
};

const terminateSocket = (socket) => {
  if (socket.smallestSocket) {
    socket.smallestSocket.close();
    socket.smallestSocket = null;
  }
};

module.exports = ttsStreamingSmallest;
