// Fixture sites for the eval harness. Plain Node http, no deps.
// Every page reports its outcome to the server; tasks are judged from `state`,
// never from what the model says it did.
const http = require('node:http');

const PRODUCTS = [
  { id: 'p1', name: 'USB-C Cable 1m', price: 9.99 },
  { id: 'p2', name: 'USB-C Cable 2m', price: 12.5 },
  { id: 'p3', name: 'USB Hub 4-Port', price: 19.9 },
  { id: 'p4', name: 'USB Flash Drive 64GB', price: 7.49 },
  { id: 'p5', name: 'USB Flash Drive 128GB', price: 11.9 },
  { id: 'p6', name: 'HDMI Cable 2m', price: 6.99 },
  { id: 'p7', name: 'Wireless Mouse', price: 15.0 },
  { id: 'p8', name: 'Laptop Stand', price: 29.0 },
  { id: 'p9', name: 'Webcam 1080p', price: 34.5 },
  { id: 'p10', name: 'USB Microphone', price: 42.0 }
];
const CHEAPEST_USB = 'p4';

// Orders for the pagination task: 4 pages x 6 rows, deterministic.
function orderPages() {
  const pages = [];
  let n = 1;
  for (let p = 1; p <= 4; p++) {
    const rows = [];
    for (let i = 0; i < 6; i++, n++) rows.push({ no: `A-${1000 + n}`, amount: Math.round(((n * 137) % 900 + 120 + (n % 7) * 0.35) * 100) / 100 });
    pages.push(rows);
  }
  return pages;
}
const ORDERS = orderPages();
const pageTotal = (p) => Math.round(ORDERS[p - 1].reduce((s, r) => s + r.amount, 0) * 100) / 100;
const fmt = (n) => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const CANVAS_SQUARES = [
  { color: 'blue', x: 60, y: 60, s: 80 }, { color: 'red', x: 400, y: 240, s: 80 },
  { color: 'green', x: 250, y: 90, s: 80 }, { color: 'orange', x: 80, y: 280, s: 80 }
];

const shell = (title, body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px;max-width:760px}
input,select,textarea,button{font:inherit;padding:6px 10px;margin:4px 0}button{cursor:pointer}
.row{margin:10px 0}.err{color:#b00020}.ok{color:#0a7d33}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 10px}
${head}</style></head><body>${body}</body></html>`;
const post = (url, data) => `fetch(${JSON.stringify(url)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${data})})`;

function pageShop() {
  return shell('Gadget Shop', `<h1>Gadget Shop</h1>
<div class="row"><input id="q" placeholder="Search products" aria-label="Search products"><button id="go">Search</button> <a href="#" id="cartlink">Cart (<span id="cc">0</span>)</a></div>
<ul id="list"></ul><script>
const P=${JSON.stringify(PRODUCTS)};let cart=0;
function render(){const q=document.getElementById('q').value.trim().toLowerCase();
 document.getElementById('list').innerHTML=P.filter(p=>p.name.toLowerCase().includes(q)).map(p=>
 '<li data-id="'+p.id+'">'+p.name+' - $'+p.price.toFixed(2)+' <button data-add="'+p.id+'" aria-label="Add '+p.name+' to cart">Add to cart</button></li>').join('');}
document.getElementById('go').onclick=render;document.getElementById('q').addEventListener('keydown',e=>{if(e.key==='Enter')render()});
document.getElementById('list').addEventListener('click',async e=>{const id=e.target.dataset&&e.target.dataset.add;if(!id)return;
 await ${post('/api/cart', '{id}')};document.getElementById('cc').textContent=++cart;});
render();</script>`);
}

function pageSignup() {
  return shell('Create account', `<h1>Create account</h1><form id="f" novalidate>
<div class="row"><label>Full name <input id="name" name="name"></label></div>
<div class="row"><label>Email <input id="email" name="email" type="email"></label></div>
<div class="row"><label>Password <input id="pw" name="password" type="password"></label> <small>8+ chars, include a digit</small></div>
<div class="row"><label>Confirm password <input id="pw2" name="confirm" type="password"></label></div>
<div class="row"><label>Country <select id="country" name="country"><option value="">Select...</option><option>China</option><option>Japan</option><option>Germany</option><option>Brazil</option></select></label></div>
<div class="row"><label><input type="checkbox" id="agree"> I agree to the Terms of Service</label></div>
<button type="submit">Create account</button> <div id="msg" class="err" role="alert"></div></form><script>
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const g=i=>document.getElementById(i);const v={name:g('name').value.trim(),email:g('email').value.trim(),password:g('pw').value,confirm:g('pw2').value,country:g('country').value,agree:g('agree').checked};
 const errs=[];if(!v.name)errs.push('Name is required');if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v.email))errs.push('Email is invalid');
 if(v.password.length<8||!/\\d/.test(v.password))errs.push('Password must be 8+ chars with a digit');if(v.password!==v.confirm)errs.push('Passwords do not match');
 if(!v.country)errs.push('Choose a country');if(!v.agree)errs.push('You must agree to the Terms');
 const m=document.getElementById('msg');if(errs.length){m.className='err';m.textContent=errs.join('; ');return}
 const r=await ${post('/api/signup', 'v')};m.className='ok';m.textContent='Account created';};</script>`);
}

function pageDate() {
  return shell('Hotel booking', `<h1>Book your stay</h1><div class="row">Check-in: <input id="d" readonly placeholder="Select date" aria-label="Check-in date"></div>
<div id="cal" hidden style="border:1px solid #888;width:300px;padding:8px"><div><span id="prev" style="cursor:pointer;padding:0 8px">&lt;</span><b id="mon"></b><span id="next" style="cursor:pointer;padding:0 8px">&gt;</span></div><div id="grid" style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px"></div></div>
<button id="ok">Confirm booking</button><div id="msg" class="ok"></div><script>
let y=2026,m=9,sel=null;const names=['January','February','March','April','May','June','July','August','September','October','November','December'];
function draw(){mon.textContent=names[m]+' '+y;const first=new Date(y,m,1).getDay(),days=new Date(y,m+1,0).getDate();let h='';
 for(let i=0;i<first;i++)h+='<div></div>';for(let d=1;d<=days;d++)h+='<div class="day" style="text-align:center;cursor:pointer;padding:4px;border:1px solid #ddd;'+(sel&&sel.d===d&&sel.m===m&&sel.y===y?'background:#cde':'')+'" data-d="'+d+'">'+d+'</div>';grid.innerHTML=h;}
d.onclick=()=>{cal.hidden=false;draw()};prev.onclick=()=>{if(--m<0){m=11;y--}draw()};next.onclick=()=>{if(++m>11){m=0;y++}draw()};
grid.onclick=e=>{const n=+e.target.dataset.d;if(!n)return;sel={y,m,d:n};d.value=y+'-'+String(m+1).padStart(2,'0')+'-'+String(n).padStart(2,'0');cal.hidden=true;};
ok.onclick=async()=>{if(!sel){msg.textContent='Pick a date first';return}await ${post('/api/booking', '{checkin:d.value}')};msg.textContent='Booked '+d.value;};</script>`);
}

function pageAdmin() {
  return shell('Admin Console', `<h1>Admin Console</h1><div style="display:flex;gap:32px"><nav id="nav" style="width:200px">
<div class="m1" data-k="dash">Dashboard</div>
<div class="m1" data-k="sys" style="cursor:pointer">System &#9656;</div><div class="sub" id="sys" hidden style="margin-left:16px">
 <div class="m2" data-k="users" style="cursor:pointer">Users</div>
 <div class="m2" data-k="prefs" style="cursor:pointer">Preferences &#9656;</div><div id="prefs" hidden style="margin-left:16px">
  <div class="m3" data-k="appearance" style="cursor:pointer">Appearance</div><div class="m3" data-k="notif" style="cursor:pointer">Notifications</div></div></div></nav>
<main id="main"><p>Select a section.</p></main></div><script>
const $=id=>document.getElementById(id);
$('nav').onclick=e=>{const k=e.target.dataset.k;if(!k)return;if(k==='sys')$('sys').hidden=!$('sys').hidden;if(k==='prefs')$('prefs').hidden=!$('prefs').hidden;
 if(k==='notif'){$('main').innerHTML='<h2>Notifications</h2><div>Email digest <span id="sw" role="switch" aria-checked="false" aria-label="Email digest" tabindex="0" style="display:inline-block;width:44px;height:22px;border-radius:11px;background:#bbb;cursor:pointer;vertical-align:middle"></span></div><div>Weekly report <span style="color:#888">(off)</span></div><button id="save">Save changes</button><div id="msg" class="ok"></div>';
  const sw=$('sw');const tog=()=>{const on=sw.getAttribute('aria-checked')!=='true';sw.setAttribute('aria-checked',on);sw.style.background=on?'#2a7':'#bbb'};sw.onclick=tog;sw.onkeydown=e=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();tog()}};
  $('save').onclick=async()=>{await ${post('/api/settings', "{emailDigest:sw.getAttribute('aria-checked')==='true'}")};$('msg').textContent='Saved';};}
 else if(k==='appearance'||k==='users'||k==='dash'){$('main').innerHTML='<h2>'+k+'</h2><p>Nothing to configure.</p>'}};</script>`);
}

function pageOrders(p) {
  p = Math.min(4, Math.max(1, p | 0 || 1));
  const rows = ORDERS[p - 1].map((r) => `<tr><td>${r.no}</td><td>${fmt(r.amount)}</td></tr>`).join('');
  const nav = [p > 1 ? `<a href="/orders?page=${p - 1}">Previous</a>` : '', p < 4 ? `<a href="/orders?page=${p + 1}">Next</a>` : ''].join(' | ');
  return shell(`Orders - page ${p}`, `<h1>Orders</h1><p>Page ${p} of 4</p><table><tr><th>Order</th><th>Amount (CNY)</th></tr>${rows}<tr><td><b>Page total</b></td><td><b>${fmt(pageTotal(p))}</b></td></tr></table><p>${nav}</p>`);
}

function pageFrame(port) {
  return shell('Contact us', `<h1>Contact us</h1><p>The form below is hosted by a different origin.</p>
<iframe src="http://localhost:${port}/frame-inner" title="contact-form" width="520" height="300" style="border:1px solid #888"></iframe>`);
}
function pageFrameInner() {
  return shell('Contact form', `<form id="f"><div class="row"><label>Your name <input id="n"></label></div><div class="row"><label>Phone <input id="ph"></label></div>
<div class="row"><label>Topic <select id="t"><option>General</option><option>Billing</option><option>Support</option></select></label></div><button type="submit">Send message</button><div id="msg" class="ok"></div></form><script>
f.onsubmit=async e=>{e.preventDefault();await ${post('/api/frame', '{name:n.value,phone:ph.value,topic:t.value}')};msg.textContent='Sent';};</script>`);
}

function pageCookie() {
  return shell('Daily Digest', `<h1>Daily Digest</h1><p>Get the best stories in your inbox.</p>
<button id="open">Subscribe to newsletter</button>
<div id="banner" style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;z-index:10"><div style="background:#fff;padding:16px;width:100%"><b>We use cookies</b><p>Choose how we may use cookies.</p>
<button id="acc">Accept all</button> <button id="rej">Reject non-essential</button></div></div>
<div id="modal" hidden style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:5"><div style="background:#fff;margin:80px auto;padding:20px;width:360px"><h3>Subscribe</h3><label>Email <input id="em" type="email"></label><div><button id="sub">Subscribe</button> <button id="cancel">Cancel</button></div><div id="msg" class="ok"></div></div></div><script>
const $=i=>document.getElementById(i);$('acc').onclick=()=>{${post('/api/cookie', "{choice:'accept'}")};$('banner').remove()};$('rej').onclick=()=>{${post('/api/cookie', "{choice:'reject'}")};$('banner').remove()};
$('open').onclick=()=>{$('modal').hidden=false};$('cancel').onclick=()=>{$('modal').hidden=true};
$('sub').onclick=async()=>{await ${post('/api/subscribe', '{email:$("em").value}')};$('msg').textContent='Subscribed!';};</script>`);
}

function pageTrusted() {
  return shell('Secure action', `<h1>Secure action</h1><p>This button only responds to a real user click.</p><button id="b" style="padding:12px 24px">Activate device</button><div id="msg"></div><script>
b.addEventListener('click',async e=>{if(!e.isTrusted){msg.textContent='Blocked: synthetic input ignored';msg.className='err';await ${post('/api/trusted', '{trusted:false}')};return}
 await ${post('/api/trusted', '{trusted:true}')};msg.textContent='Device activated';msg.className='ok';});</script>`);
}

function pageCanvas() {
  return shell('Color game', `<h1>Color game</h1><canvas id="c" width="600" height="400" style="border:1px solid #333"></canvas><div id="msg"></div><script>
const S=${JSON.stringify(CANVAS_SQUARES)};const c=document.getElementById('c'),g=c.getContext('2d');
for(const q of S){g.fillStyle=q.color;g.fillRect(q.x,q.y,q.s,q.s)}
c.addEventListener('click',async e=>{const r=c.getBoundingClientRect();const x=(e.clientX-r.left)*c.width/r.width,y=(e.clientY-r.top)*c.height/r.height;
 const hit=S.find(q=>x>=q.x&&x<=q.x+q.s&&y>=q.y&&y<=q.y+q.s);await ${post('/api/canvas', '{color:hit?hit.color:null}')};msg.textContent=hit?'You clicked '+hit.color:'Missed';});</script>`);
}

function pageLong() {
  const filler = Array.from({ length: 60 }, (_, i) => `<p>Section ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p>`).join('');
  return shell('Package receipt', `<h1>Package receipt</h1><div class="row"><label>Reference code <input id="code" placeholder="Enter reference code"></label> <button id="verify">Verify</button> <span id="msg"></span></div>${filler}
<p style="margin-top:40px"><b>Reference code: KT-7391</b></p><p>End of document.</p><script>
verify.onclick=async()=>{await ${post('/api/verify', '{code:code.value.trim()}')};msg.textContent='Submitted';};</script>`);
}

function pageTabs() {
  return shell('Checkout', `<h1>Checkout</h1><p>Total: $120.00</p><p><a href="/partner" target="_blank" rel="noopener">View partner offer</a></p>
<div class="row"><label>Coupon code <input id="cp"></label> <button id="apply">Apply coupon</button> <span id="msg"></span></div><script>
apply.onclick=async()=>{await ${post('/api/coupon', '{code:cp.value.trim()}')};msg.textContent='Applied';};</script>`);
}
function pagePartner() {
  return shell('Partner offer', `<h1>Partner offer</h1><p>Use coupon code <b id="c">SAVE-4821</b> at checkout for 15% off.</p>`);
}

function pageSurvey() {
  return shell('Feedback', `<h1>Feedback survey</h1><form id="f"><fieldset><legend>Which product did you use?</legend>
<label><input type="radio" name="prod" value="Browser"> Browser</label> <label><input type="radio" name="prod" value="Mobile"> Mobile app</label> <label><input type="radio" name="prod" value="Desktop"> Desktop app</label></fieldset>
<div class="row">Rating: <span id="stars"></span></div><div class="row"><label>Comments<br><textarea id="cm" rows="4" cols="40"></textarea></label></div><button type="submit">Submit feedback</button><div id="msg" class="ok"></div></form><script>
let rating=0;stars.innerHTML=[1,2,3,4,5].map(n=>'<button type="button" class="star" data-n="'+n+'" aria-label="'+n+' stars">'+n+'&#9733;</button>').join('');
stars.onclick=e=>{const n=+e.target.dataset.n;if(n){rating=n;[...stars.children].forEach((b,i)=>b.style.background=i<n?'gold':'')}};
f.onsubmit=async e=>{e.preventDefault();const p=document.querySelector('input[name=prod]:checked');await ${post('/api/survey', '{product:p&&p.value,rating,comment:cm.value}')};msg.textContent='Thanks!';};</script>`);
}

function freshState() {
  return { cart: [], signups: [], bookings: [], settings: null, frame: [], cookie: null, subscribed: [], trusted: [], canvas: [], verified: [], coupons: [], surveys: [], requests: 0 };
}

function createFixtureServer() {
  let state = freshState();
  let port = 0;
  const json = (res, body, code = 200) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    state.requests++;
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' }); return res.end(); }
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let b = {};
        try { b = JSON.parse(raw || '{}'); } catch { /* keep {} */ }
        const k = u.pathname;
        if (k === '/api/cart') state.cart.push(b.id);
        else if (k === '/api/signup') state.signups.push(b);
        else if (k === '/api/booking') state.bookings.push(b);
        else if (k === '/api/settings') state.settings = b;
        else if (k === '/api/frame') state.frame.push(b);
        else if (k === '/api/cookie') state.cookie = b.choice;
        else if (k === '/api/subscribe') state.subscribed.push(b.email);
        else if (k === '/api/trusted') state.trusted.push(b.trusted === true);
        else if (k === '/api/canvas') state.canvas.push(b.color);
        else if (k === '/api/verify') state.verified.push(b.code);
        else if (k === '/api/coupon') state.coupons.push(b.code);
        else if (k === '/api/survey') state.surveys.push(b);
        else return json(res, { ok: false }, 404);
        json(res, { ok: true });
      });
      return;
    }
    const pages = {
      '/shop': pageShop, '/signup': pageSignup, '/date': pageDate, '/admin': pageAdmin,
      '/orders': () => pageOrders(Number(u.searchParams.get('page'))), '/frame': () => pageFrame(port),
      '/frame-inner': pageFrameInner, '/cookie': pageCookie, '/trusted': pageTrusted, '/canvas': pageCanvas,
      '/long': pageLong, '/tabs': pageTabs, '/partner': pagePartner, '/survey': pageSurvey
    };
    const fn = pages[u.pathname];
    if (!fn) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fn());
  });
  return {
    get state() { return state; },
    reset() { state = freshState(); },
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      port = server.address().port;
      return `http://127.0.0.1:${port}`;
    },
    close() { return new Promise((r) => server.close(r)); }
  };
}

module.exports = { createFixtureServer, PRODUCTS, CHEAPEST_USB, pageTotal, fmt, CANVAS_SQUARES };
