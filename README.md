# Aurora OS

A Windows 11 style desktop that runs in the browser. It has its own server, so it gets its own web address.

- Browser app: loads real web pages through the server's `/proxy`.
- Games: Snake, 2048, Minesweeper, Blocks, Breakout, Memory.
- Emulator: runs game files you own (NES, SNES, Game Boy, GBA, Genesis and more) using EmulatorJS.
- Also: Notepad, Calculator, Paint, Settings, light and dark themes.

## Run it on your computer

1. Install Node 18 or newer from nodejs.org.
2. In this folder run `node server.js`.
3. Open http://localhost:3000.
4. To use it on your phone, connect the phone to the same Wi-Fi and open `http://<your computer's local IP>:3000`.

## Put it online (free)

The server needs a host that runs Node. Render, Railway and Fly.io all work.

Render example:
1. Create a GitHub repository and upload everything in this folder.
2. On render.com choose New, then Web Service, and pick the repository.
3. Runtime: Node. Build command: leave empty. Start command: `node server.js`.
4. Deploy. Render gives you an address like `https://your-name.onrender.com`.
5. On your phone open that address, then use "Add to Home Screen" to install it like an app.

## Notes

- The proxy blocks private and local network addresses, limits requests per minute, and runs proxied pages in a sandbox so they cannot touch the desktop's data. It is still a public proxy, so do not share the address widely.
- It does not keep cookies, so signing in to other sites will not work. Sites that rely on heavy scripts (YouTube, Google apps) will often fail.
- Set `ALLOW_PRIVATE_HOSTS=1` only for local testing. Never set it on a public host.
- No game files are included. Use games you own.
