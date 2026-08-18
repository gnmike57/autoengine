import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import { app } from '../../src/server/server.js';

const request = supertest(app);
const MOBILE_API_KEY = process.env.MOBILE_API_KEY || "hermes-ios-app-key-998877";

describe('API Stress & Fortification Tests', () => {
  
  it('should gracefully handle 100 concurrent malformed text-paste requests', async () => {
    // Malformed requests missing headers or body
    const requests = Array.from({ length: 100 }).map(() => {
      return request.post('/api/credentials/text-paste')
        .set('Authorization', `Bearer ${MOBILE_API_KEY}`)
        .set('Content-Type', 'text/plain')
        // Intentionally sending garbage data
        .send(Math.random() > 0.5 ? "JUST ONE WORD" : ",,,\n,,,")
        .expect(res => {
           // We expect either a 200 (processed garbage as valid) or 400 (rejected gracefully), 
           // but NEVER a 500 server crash
           expect(res.status).not.toBe(500);
        });
    });

    await Promise.all(requests);
  }, 15000);

  it('should block 50 concurrent unauthorized requests without crashing', async () => {
    // Bombard the scaling endpoint without the API key, from a mocked external IP
    const requests = Array.from({ length: 50 }).map(() => {
      return request.post('/api/workers/scale')
        .set('Content-Type', 'application/json')
        .set('X-Forwarded-For', '203.0.113.195') // Spoof an external IP so it doesn't get whitelisted as localhost
        .send({ instances: 5000 }) // Malicious payload
        .expect(403); // MUST be 403 Forbidden
    });

    await Promise.all(requests);
  }, 10000);

  it('should handle massive payload injections on text-paste', async () => {
    // Generate a 10MB CSV string
    const massivePayload = Array.from({ length: 100000 }).map((_, i) => `test${i}@test.com,Password123!`).join('\n');
    
    await request.post('/api/credentials/text-paste')
      .set('Authorization', `Bearer ${MOBILE_API_KEY}`)
      .set('Content-Type', 'text/plain')
      .send(massivePayload)
      .expect(res => {
         // Should process or reject (413 Payload Too Large), but not crash
         expect([200, 413, 400]).toContain(res.status);
      });
  }, 30000);

});
