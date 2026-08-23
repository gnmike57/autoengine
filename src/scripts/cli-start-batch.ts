import WebSocket from 'ws';

async function startBatch() {
  const args = process.argv.slice(2);
  const port = args.find(a => a.startsWith('--port='))?.split('=')[1] || process.env.PORT || '3000';
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);

  ws.on('open', () => {
    console.log(`Connected to Engine Server on port ${port}.`);

    // Parse args if any, otherwise use defaults
    const backend = args.find(a => a.startsWith('--backend='))?.split('=')[1] || 'stealth-headed';
    const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '4', 10);

    console.log(`Setting backend: ${backend}`);
    ws.send(JSON.stringify({ type: 'set-backend', data: { value: backend } }));

    console.log(`Setting concurrency: ${concurrency}`);
    ws.send(JSON.stringify({ type: 'set-concurrency', data: { value: concurrency } }));

    // Enable auto optimize
    ws.send(JSON.stringify({ type: 'update_ui_settings', setting: 'advAutoOptimize', value: "true" }));
    ws.send(JSON.stringify({ type: 'set-auto-optimize-per-backend', data: { value: true } }));

    console.log("Starting batch...");
    ws.send(JSON.stringify({ type: 'start' }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); // eslint-disable-line @typescript-eslint/no-base-to-string
      if (msg.type === 'dashboard-stats') {
        console.log(`[Batch Progress] ${msg.data.completed}/${msg.data.total} (Success: ${msg.data.success}, Failed: ${msg.data.failed})`);
        
        if (msg.data.completed > 0 && msg.data.completed === msg.data.total) {
          console.log("Batch finished.");
          ws.close();
          process.exit(0);
        }
      } else if (msg.type === 'log') {
        // Uncomment to stream all server logs to terminal
        // console.log(`[Server Log] ${msg.data}`);
      }
    } catch (e) {
      // ignore
    }
  });

  ws.on('error', (err) => {
    console.error("Failed to connect to server. Is it running on port 3011? Error:", err.message);
    process.exit(1);
  });

  ws.on('close', () => {
    console.log("Connection closed.");
  });
}

startBatch().catch(console.error);
