import WebSocket from 'ws';

async function setConcurrency() {
  const args = process.argv.slice(2);
  const port = args.find(a => a.startsWith('--port='))?.split('=')[1] || process.env.PORT || '3000';
  const concurrencyStr = args.find(a => a.startsWith('--concurrency='))?.split('=')[1];
  
  if (!concurrencyStr) {
    console.error("Usage: npx tsx src/scripts/cli-set-concurrency.ts --concurrency=<number>");
    process.exit(1);
  }

  const concurrency = parseInt(concurrencyStr, 10);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);

  ws.on('open', () => {
    console.log(`Connected to Engine Server on port ${port}.`);
    console.log(`Setting live concurrency to: ${concurrency}`);
    ws.send(JSON.stringify({ type: 'set-concurrency', data: { value: concurrency } }));
    
    // Give it a moment to send before closing
    setTimeout(() => {
      console.log("Concurrency update sent.");
      ws.close();
      process.exit(0);
    }, 500);
  });

  ws.on('error', (err) => {
    console.error("Failed to connect to server. Is it running on port " + port + "? Error:", err.message);
    process.exit(1);
  });
}

setConcurrency().catch(console.error);
