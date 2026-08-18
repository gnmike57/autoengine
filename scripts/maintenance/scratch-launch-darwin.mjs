import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:3011');
let allEmails = [];
let started = false;

ws.on('open', () => {
  console.log('Connected to dashboard WS');

  // 1. Set backend to darwin
  ws.send(JSON.stringify({ type: 'set-backend', data: { value: 'darwin' } }));
  console.log('✅ Set backend to darwin');

  // 2. Request sync to get all credentials
  ws.send(JSON.stringify({ type: 'sync' }));
  console.log('⏳ Requesting credential sync...');
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    
    // The sync response comes as type "init" with data.credentials
    if (msg.type === 'init' && msg.data?.credentials && !started) {
      started = true;
      allEmails = msg.data.credentials.map(c => c.email);
      console.log(`📋 Got ${allEmails.length} credentials from init sync`);
      
      // Now launch with ALL emails
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'start',
          data: {
            targets: ['joe', 'ignition'],
            backend: 'darwin',
            emails: allEmails,
            concurrency: 5,
            inputMode: 'instant',
            fpStrategy: 'native-only',
            recordVideo: false,
            enableCacheInjection: false,
            enableVerification: false,
            injectStealthJS: false,
            postLoadDelay: 0,
            maxRetries: 3,
            parallelSites: false,
            mutateOnRetry: true,
            proxyRotateUrl: '',
            manualCaptchaMode: false
          }
        }));
        console.log(`🚀 Sent START with ${allEmails.length} credentials on DARWIN mode`);
        
        // Wait for engine confirmation then exit
        setTimeout(() => {
          ws.close();
          process.exit(0);
        }, 5000);
      }, 500);
    }
    
    if (msg.type === 'log') {
      console.log(`[LOG] ${msg.data?.message || ''}`);
    }
    if (msg.type === 'engine-state') {
      console.log(`[ENGINE] ${msg.data?.state || JSON.stringify(msg.data)}`);
    }
    if (msg.type === 'error') {
      console.log(`[ERROR] ${msg.data?.message || JSON.stringify(msg.data)}`);
    }
    if (msg.type === 'batch-summary') {
      console.log(`[BATCH] total=${msg.data?.total} active=${msg.data?.active} completed=${msg.data?.completed}`);
    }
  } catch {}
});

ws.on('error', (err) => {
  console.error('WS Error:', err.message);
  process.exit(1);
});
