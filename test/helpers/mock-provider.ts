/**
 * A stand-in AI website for end-to-end tests: a chat box, a send button, a streamed reply,
 * a "thinking" indicator while it streams, and an optional sign-in gate.
 * The control plane drives it exactly the way it drives ChatGPT or Claude.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export const MOCK_SELECTORS = {
  composerSelector: "#box",
  sendSelector: "#send",
  replySelector: ".assistant",
  busySelector: '#stop[style*="inline"]',
  loggedOutSelector: "#login",
  loginUrlPatterns: ["/login"],
};

const page = (signedIn: boolean) => `<!doctype html><html><head><meta charset="utf-8"><title>Mock AI</title>
<style>body{font-family:system-ui;background:#f6f7f9;margin:0;padding:24px;color:#111}
.wrap{max-width:720px;margin:0 auto}.msg{padding:12px 16px;border-radius:12px;margin:10px 0;max-width:80%}
.user{background:#dbeafe;margin-left:auto}.assistant{background:#fff;border:1px solid #ddd}
textarea{width:100%;height:80px;font:inherit;padding:10px;border-radius:10px;border:1px solid #bbb}
button{font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#2563eb;color:#fff;margin-top:8px}
.busy{display:none;color:#666}h1{font-size:20px}</style></head><body><div class="wrap">
<h1>Mock AI <small style="color:#888;font-weight:400">${signedIn ? "signed in as tester" : "signed out"}</small></h1>
${signedIn ? "" : '<a id="login" href="/login">Log in</a>'}
<div id="log"></div>
<textarea id="box" placeholder="Ask me anything"></textarea>
<button id="send">Send</button> <span id="stop" class="busy">thinking…</span>
<script>
const log=document.getElementById('log'),box=document.getElementById('box'),stop=document.getElementById('stop');
function add(cls,t){const d=document.createElement('div');d.className='msg '+cls;d.textContent=t;log.appendChild(d);return d}
document.getElementById('send').onclick=()=>{const t=box.value.trim();if(!t)return;box.value='';add('user',t);stop.style.display='inline';
 const r=add('assistant','');let i=0;const full='You said: '+t+'. Here is a considered answer with three points: first, second, third.';
 const iv=setInterval(()=>{i+=8;r.textContent=full.slice(0,i);if(i>=full.length){clearInterval(iv);stop.style.display='none'}},80)};
box.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('send').click()}});
</script></div></body></html>`;

export interface MockProvider {
  url: string;
  /** Flip the site into a signed-out state; the app should detect it. */
  setSignedIn(v: boolean): void;
  close(): Promise<void>;
}

export function startMockProvider(): Promise<MockProvider> {
  let signedIn = true;
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/login")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<h1>Please log in</h1>");
    }
    if (!signedIn) {
      res.writeHead(302, { location: "/login" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page(signedIn));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        setSignedIn: (v) => (signedIn = v),
        // Drop keep-alive connections too, or a lingering browser tab keeps the test process alive.
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
