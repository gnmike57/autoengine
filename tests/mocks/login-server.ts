/**
 * MOCK LOGIN SERVER — Synthetic Baseline Recording
 *
 * Serves deterministic HTML payloads for each classification outcome class.
 * Used by scripts/record-baseline.ts to produce ground-truth .webm fixtures.
 *
 * Outcome → trigger phrase mapping mirrors LOGIN_TRIGGER_RULES in login-flow.ts.
 */
import http from "node:http";
import { AddressInfo } from "node:net";

export type MockOutcome =
  | "noaccount"
  | "success"
  | "tempdisabled"
  | "permdisabled"
  | "2fa"
  | "incorrect"
  | "blocked";

const OUTCOME_PAGES: Record<MockOutcome, { status: number; body: string }> = {
  noaccount: {
    status: 200,
    body: `<!DOCTYPE html><html><head><title>Login</title></head><body>
      <form id="login-form">
        <input type="email" id="email" name="email" placeholder="Email" />
        <input type="password" id="password" name="password" placeholder="Password" />
        <button type="submit" id="submit-btn">Sign In</button>
      </form>
      <div id="error-message" style="display:none;color:red;">
        There is no account associated with this email address.
      </div>
      <script>
        document.getElementById('login-form').addEventListener('submit', function(e) {
          e.preventDefault();
          var msg = document.getElementById('error-message');
          // Hide first to force a DOM mutation on every submit, then show
          msg.style.display = 'none';
          void msg.offsetHeight; // force reflow
          msg.style.display = 'block';
        });
      </script>
    </body></html>`,
  },
  success: {
    status: 200,
    body: `<!DOCTYPE html><html><head><title>Dashboard</title></head><body>
      <form id="login-form">
        <input type="email" id="email" name="email" placeholder="Email" />
        <input type="password" id="password" name="password" placeholder="Password" />
        <button type="submit" id="submit-btn">Sign In</button>
      </form>
      <div id="dashboard" style="display:none;">
        <h1>Welcome back!</h1>
        <p>You are now logged in.</p>
      </div>
      <script>
        document.getElementById('login-form').addEventListener('submit', function(e) {
          e.preventDefault();
          document.getElementById('login-form').style.display = 'none';
          document.getElementById('dashboard').style.display = 'block';
        });
      </script>
    </body></html>`,
  },
  tempdisabled: {
    status: 200,
    body: `<!DOCTYPE html><html><head><title>Login</title></head><body>
      <form id="login-form">
        <input type="email" id="email" name="email" placeholder="Email" />
        <input type="password" id="password" name="password" placeholder="Password" />
        <button type="submit" id="submit-btn">Sign In</button>
      </form>
      <div id="error-message" style="display:none;color:orange;">
        Your account has been temporarily locked due to too many failed attempts.
        Please try again in 30 minutes.
      </div>
      <script>
        document.getElementById('login-form').addEventListener('submit', function(e) {
          e.preventDefault();
          document.getElementById('error-message').style.display = 'block';
        });
      </script>
    </body></html>`,
  },
  permdisabled: {
    status: 200,
    body: `<!DOCTYPE html><html><head><title>Login</title></head><body>
      <form id="login-form">
        <input type="email" id="email" name="email" placeholder="Email" />
        <input type="password" id="password" name="password" placeholder="Password" />
        <button type="submit" id="submit-btn">Sign In</button>
      </form>
      <div id="error-message" style="display:none;color:red;">
        This account has been permanently disabled.
        Please contact support for assistance.
      </div>
      <script>
        document.getElementById('login-form').addEventListener('submit', function(e) {
          e.preventDefault();
          document.getElementById('error-message').style.display = 'block';
        });
      </script>
    </body></html>`,
  },
  "2fa": {
    status: 428,
    body: `<!DOCTYPE html><html><head><title>Two-Factor Authentication</title></head><body>
      <form id="login-form">
        <input type="email" id="email" name="email" placeholder="Email" />
        <input type="password" id="password" name="password" placeholder="Password" />
        <button type="submit" id="submit-btn">Sign In</button>
      </form>
      <div id="mfa-prompt" style="display:none;">
        <h2>Verify your identity</h2>
        <p>mfa_required: Please enter the 6-digit code from your authenticator app.</p>
        <input type="text" id="mfa-code" placeholder="000000" maxlength="6" />
        <button>Verify</button>
      </div>
      <script>
        document.getElementById('login-form').addEventListener('submit', function(e) {
          e.preventDefault();
          document.getElementById('login-form').style.display = 'none';
          document.getElementById('mfa-prompt').style.display = 'block';
        });
      </script>
    </body></html>`,
  },
  incorrect: {
    status: 200,
    body: `<!DOCTYPE html><html><head><title>Login</title></head><body>
      <form id="login-form">
        <input type="email" id="email" name="email" placeholder="Email" />
        <input type="password" id="password" name="password" placeholder="Password" />
        <button type="submit" id="submit-btn">Sign In</button>
      </form>
      <div id="error-message" style="display:none;color:red;">
        Incorrect password. Please try again.
      </div>
      <script>
        document.getElementById('login-form').addEventListener('submit', function(e) {
          e.preventDefault();
          var msg = document.getElementById('error-message');
          msg.style.display = 'none';
          void msg.offsetHeight;
          msg.style.display = 'block';
        });
      </script>
    </body></html>`,
  },
  blocked: {
    status: 403,
    body: `<!DOCTYPE html><html><head><title>Access Denied</title></head><body>
      <h1>403 Forbidden</h1>
      <p>Your request has been blocked. Please try again later.</p>
    </body></html>`,
  },
};

export function createMockLoginServer(outcome: MockOutcome): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const page = OUTCOME_PAGES[outcome];
      res.writeHead(page.status, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(page.body),
      });
      res.end(page.body);
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/login`,
        close: () => server.close(),
      });
    });
  });
}
