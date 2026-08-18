const WebSocket = require('ws');

// Connect to the dashboard server
const ws = new WebSocket('ws://127.0.0.1:9223');

ws.on('open', () => {
  console.log('Connected to WebSocket server. Sending start command...');
  
  const startPayload = {
    type: 'start',
    data: {
      backend: 'stealth-headed',
      parallelSites: false,
      targets: ['joe', 'ignition'],
      emails: [] // Empty array means run all queued credentials
    }
  };
  
  ws.send(JSON.stringify(startPayload));
  console.log('Start command sent successfully.');
  
  // Wait a moment for server to acknowledge before closing
  setTimeout(() => {
    ws.close();
    console.log('Connection closed.');
  }, 2000);
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
});
