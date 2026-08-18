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

import zendriver as zd  # type: ignore

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
            "--disable-features=PasswordCheckup",
            "--password-store=basic",
            "--disable-blink-features=AutomationControlled"
        ]
        if proxy_str:
            browser_args.append(f"--proxy-server={proxy_str}")
            
        user_agent = config.get("userAgent")
        if user_agent:
            browser_args.append(f"--user-agent={user_agent}")
            
        import platform
        if platform.system().lower() == "darwin" and config.get("macOSTilingEngine") == "native-cdp" and config.get("bounds"):
            b = config["bounds"]
            if "x" in b and "y" in b:
                browser_args.append(f"--window-position={int(b['x'])},{int(b['y'])}")
            if "width" in b and "height" in b:
                browser_args.append(f"--window-size={int(b['width'])},{int(b['height'])}")
            
        browser = await zd.start(
            headless=False,
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
        try:
            await asyncio.get_event_loop().run_in_executor(None, sys.stdin.read)
        except (EOFError, BrokenPipeError, OSError):
            pass
    except Exception as e:
        logging.error(f"Error starting zendriver headed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
