// Minimal Chrome DevTools Protocol driver: node cdp.mjs eval "<expr>" | shot <file.png>
import fs from 'fs';

const port = process.env.CDP_PORT || 9333;
const [cmd, arg] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type == 'page' && /index\.html/.test(t.url));
if (!page) { console.error('no page', targets.map(t => t.url)); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = {};
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; } };
await new Promise(r => ws.onopen = r);
const send = (method, params) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({id: i, method, params})); });

if (cmd == 'eval') {
	const res = await send('Runtime.evaluate', {expression: arg, awaitPromise: true, returnByValue: true});
	if (res.result?.exceptionDetails) console.log('EXCEPTION', JSON.stringify(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails));
	else console.log(typeof res.result?.result?.value === 'string' ? res.result.result.value : JSON.stringify(res.result?.result?.value, null, 1));
} else if (cmd == 'mouse') {
	const [x, y] = arg.split(',').map(Number);
	await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
	console.log('moved');
} else if (cmd == 'shot') {
	const res = await send('Page.captureScreenshot', {format: 'png'});
	fs.writeFileSync(arg, Buffer.from(res.result.data, 'base64'));
	console.log('saved', arg);
}
ws.close();
