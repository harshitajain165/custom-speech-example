const express = require('express');
const app = express();
const Websocket = require('ws');
const opts = Object.assign({level: process.env.LOGLEVEL || 'info'});
const logger = require('pino')(opts);
const port = process.env.PORT || process.env.HTTP_PORT || 3000;
const routes = require('./lib/tts');
app.locals = {...app.locals, logger};

/*
 * Cognigy Voice Gateway forwards the admin-configured key as `Authorization: Bearer <key>`
 * on every TTS HTTP request and STT WebSocket upgrade. We treat that token as the upstream
 * provider's key (e.g. Smallest.ai) and forward it on, so no provider key is stored here.
 */
const extractBearer = (hdr) => {
  const m = /^Bearer (.*)$/.exec(hdr || '');
  return m ? m[1] : null;
};

const requireBearer = (req, res, next) => {
  const token = extractBearer(req.headers['authorization']);
  if (!token) return res.status(401).json({ message: 'Missing Bearer token' });
  req.apiKey = token;
  next();
};

/* set up a websocket server for the STT api */
const transcribe = require('./lib/stt/');
const transcribeWsServer = new Websocket.Server({ noServer: true });
transcribeWsServer.setMaxListeners(0);
transcribeWsServer.on('connection', transcribe.bind(null, logger));

/*
 * The TTS api is HTTP only. Both non-streaming and streaming custom TTS use the
 * same POST endpoint (see lib/tts/); streaming is achieved by streaming the
 * WAV response body rather than buffering it. See the VoiceGateway streaming
 * custom-TTS contract for details.
 */

/* set up the http server for the TTS api */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/synthesize', requireBearer, routes);
app.use((err, req, res, next) => {
  logger.error(err, 'burped error');
  res.status(err.status || 500).json({msg: err.message});
});

const server = app.listen(port, () => {
  logger.info(`Example Cognigy Voice Gateway speech server listening at http://localhost:${port}`);
});

/* handle websocket upgrade requests */
server.on('upgrade', (request, socket, head) => {
  logger.debug({
    url: request.url,
    headers: request.headers,
  }, 'received upgrade request');

  /* only STT uses websockets; TTS (streaming and non-streaming) is HTTP */
  if (!request.url.startsWith('/transcribe')) {
    logger.info(`unhandled path: ${request.url}`);
    return socket.write('HTTP/1.1 404 Not Found \r\n\r\n', () => socket.destroy());
  }

  /* extract the Bearer token Cognigy forwarded; it is the upstream provider's key */
  const apiKey = extractBearer(request.headers['authorization']);
  if (!apiKey) {
    logger.info(`missing bearer token on upgrade: ${request.headers['authorization']}`);
    return socket.write('HTTP/1.1 401 Unauthorized \r\n\r\n', () => socket.destroy());
  }

  /* complete the upgrade; attach the forwarded key so the STT handler can use it */
  transcribeWsServer.handleUpgrade(request, socket, head, (ws) => {
    logger.info(`upgraded to websocket, url: ${request.url}`);
    ws.apiKey = apiKey;
    transcribeWsServer.emit('connection', ws, request.url);
  });
});
