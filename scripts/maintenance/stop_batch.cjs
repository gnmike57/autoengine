const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9223');

ws.on('open', () => {
  console.log('Sending stop command...');
  ws.send(JSON.stringify({ type: 'stop' }));
  setTimeout(() => {
    ws.close();
    console.log('Stop command sent.');
  }, 1000);
});

ws.on('error', (err) => console.error(err));
