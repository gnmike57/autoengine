# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "zendriver",
# ]
# ///
import sys
import json
import asyncio
import logging

import zendriver as zd

logging.basicConfig(level=logging.DEBUG)

async def main():
    try:
        # Read config from stdin line
        input_data = sys.stdin.readline()
        config = json.loads(input_data) if input_data.strip() else {}
        
        proxy_str = None
        if config.get("proxy"):
            p = config["proxy"]
            if p.get("server"):
                proxy_str = p["server"]
        
        browser_args = [
            "--no-sandbox",
            "--window-position=-2000,-2000",
            "--window-size=1280,720",
            "--disable-features=PasswordCheckup",
            "--password-store=basic",
            "--disable-blink-features=AutomationControlled"
        ]
        if proxy_str:
            browser_args.append(f"--proxy-server={proxy_str}")
            
        user_agent = config.get("userAgent")
        if user_agent:
            browser_args.append(f"--user-agent={user_agent}")
            
        browser = await zd.start(
            headless=True,
            browser_args=browser_args,
            sandbox=False
        )
        
        result = {
            "ws_endpoint": browser.websocket_url,
            "pid": browser._process_pid
        }
        
        print(json.dumps(result))
        sys.stdout.flush()
        
        # Block until parent closes stdin (parent crash/exit), then self-terminate.
        # This prevents orphaned browser processes when Node.js dies unexpectedly.
        try:
            await asyncio.get_event_loop().run_in_executor(None, sys.stdin.read)
        except (EOFError, BrokenPipeError, OSError):
            pass
    except KeyboardInterrupt:
        pass
    except Exception as e:
        logging.error(f"zendriver launcher error: {e}")
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
