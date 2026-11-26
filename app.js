/* ============================================================
   Cobra — app.js
   chess.js (rules) + Stockfish 18 in a Web Worker (bot, eval, review)
   behind an original UI. No network calls anywhere in this file.
   ============================================================ */
(function(){
"use strict";

/* ---------------------------------------------------------
   0. Helpers
   --------------------------------------------------------- */
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const FILES = ['a','b','c','d','e','f','g','h'];
const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const clamp = (v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const other = (c)=> c==='w' ? 'b' : 'w';
// SVG elements have no .hidden property, so toggle the attribute directly.
const setHidden = (el, on)=>{ if(el) el.toggleAttribute('hidden', !!on); };

function loadJSON(key, fallback){
  try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch(e){ return fallback; }
}
function saveJSON(key, val){
  try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){ /* storage unavailable */ }
}
function escapeHTML(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ---------------------------------------------------------
   1. Piece sets (Lichess, bundled locally under pieces/)
   --------------------------------------------------------- */
const BOARD_THEMES = [
  {id:'blueprint', label:'Blueprint',        light:'#e4ebf5', dark:'#5a7fb0'},
  {id:'teal',      label:'Teal & Parchment', light:'#e9e2d0', dark:'#3e6e64'},
  {id:'walnut',    label:'Walnut',           light:'#e8d9b5', dark:'#6b4a30'},
  {id:'slate',     label:'Slate',            light:'#dbdfe5', dark:'#4a5568'},
  {id:'sage',      label:'Sage',             light:'#eef0e2', dark:'#5b7553'},
  {id:'midnight',  label:'Midnight',         light:'#ccd2df', dark:'#232a3d'},
  {id:'coral',     label:'Coral',            light:'#fbe9df', dark:'#b5583f'},
  {id:'violet',    label:'Violet',           light:'#ece6f5', dark:'#7a5fb0'},
  {id:'mono',      label:'Mono',             light:'#f1f1f1', dark:'#8d8d93'}
];
/* Free sets first, then non-commercial (CC BY-NC-SA) sets marked nc. */
function ps(id, label, extra){ return Object.assign({id:id, label:label, ext:'svg', nc:false}, extra||{}); }
const PIECE_THEMES = [
  ps('cburnett','Cburnett'), ps('merida','Merida'), ps('chessnut','Chessnut'), ps('mono','Mono',{mono:true}),
  ps('mpchess','MP Chess'), ps('fantasy','Fantasy'), ps('spatial','Spatial'), ps('celtic','Celtic'),
  ps('rhosgfx','Rhosgfx'), ps('firi','Firi'), ps('kiwen-suwi','Kiwen Suwi'), ps('totoy','Totoy'),
  ps('papercut','Papercut'), ps('shapes','Shapes'), ps('letter','Letter'), ps('pirouetti','Pirouetti'), ps('pixel','Pixel'),
  ps('california','California',{nc:true}), ps('caliente','Caliente',{nc:true}), ps('maestro','Maestro',{nc:true}),
  ps('fresca','Fresca',{nc:true}), ps('cardinal','Cardinal',{nc:true}), ps('icpieces','IC Pieces',{nc:true}),
  ps('gioco','Gioco',{nc:true}), ps('tatiana','Tatiana',{nc:true}), ps('staunty','Staunty',{nc:true}),
  ps('dubrovny','Dubrovny',{nc:true}), ps('anarcandy','Anarcandy',{nc:true}), ps('disguised','Disguised',{nc:true}),
  ps('cooke','Cooke',{nc:true}), ps('monarchy','Monarchy',{nc:true, ext:'webp'}), ps('xkcd','xkcd',{nc:true}),
  ps('horsey','Horsey',{nc:true}), ps('minimal-warmth','Minimal Warmth',{nc:true})
];
function pieceSrc(type, color, style){
  const t = PIECE_THEMES.find(x=>x.id===style) || PIECE_THEMES[0];
  const file = t.mono ? type.toUpperCase() : color + type.toUpperCase();
  return 'pieces/'+t.id+'/'+file+'.'+t.ext;
}
function pieceMarkup(type, color, style, cls){
  return '<img src="'+pieceSrc(type,color,style)+'" class="pc'+(cls?' '+cls:'')+'" draggable="'+(cls==='ghost'?'false':'true')+'" data-piece="'+color+type+'" alt="">';
}

/* Cobra's strength: a 1-20 slider mapped to Stockfish Skill Level 0-20,
   an approximate Elo, and a per-move search budget. */
const MAX_LEVEL = 20;
function levelElo(L){ return Math.round((400 + (L-1)*(2200/(MAX_LEVEL-1)))/10)*10; }
function levelTier(L){ return L<=7 ? 'Mamba' : L<=14 ? 'Cobra' : 'King Cobra'; }

/* ---------------------------------------------------------
   3. Persistent settings, stats and saved games
   --------------------------------------------------------- */
const settings = Object.assign({
  uiTheme:'dark', sound:true, soundPack:'cobra', premove:true, autoQueen:false, engine:'auto', showEval:true,
  boardTheme:'blueprint', pieceStyle:'cburnett', showCoords:true, showHighlights:true,
  sidebarHidden:false, level:7, timePreset:'blitz', customMinutes:5, customIncrement:0, side:'w'
}, loadJSON('cobra.settings', {}));
const stats = Object.assign({wins:0, losses:0, draws:0, rating:1200}, loadJSON('cobra.stats', {}));
let savedGames = loadJSON('cobra.games', []);
if(!Array.isArray(savedGames)) savedGames = [];

function persistSettings(){ saveJSON('cobra.settings', settings); }
function persistStats(){ saveJSON('cobra.stats', stats); }
function persistGames(){ saveJSON('cobra.games', savedGames); }

/* ---------------------------------------------------------
   4. Sound — synthesized with Web Audio. Every call is wrapped so
   an audio failure can never interrupt a move, click or clock tick.
   --------------------------------------------------------- */
const Sound = (function(){
  let ctx = null, loopTimer = null;
  function ensure(){
    if(!ctx){
      const AC = window.AudioContext || window.webkitAudioContext;
      if(!AC) return null;
      ctx = new AC();
    }
    if(ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(()=>{});
    return ctx;
  }
  function tone(freq, start, dur, opts){
    if(!settings.sound) return;
    opts = opts || {};
    const c = ensure(); if(!c) return;
    const t0 = c.currentTime + start;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = opts.type || 'sine'; osc.frequency.setValueAtTime(freq, t0);
    if(opts.sweepTo) osc.frequency.linearRampToValueAtTime(opts.sweepTo, t0+dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(opts.gain || 0.18, t0+0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    osc.connect(g); g.connect(c.destination);
    osc.start(t0); osc.stop(t0+dur+0.03);
  }
  function thud(start){
    if(!settings.sound) return;
    const c = ensure(); if(!c) return;
    const n = Math.floor(c.sampleRate*0.12);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const data = buf.getChannelData(0);
    for(let i=0;i<n;i++) data[i] = (Math.random()*2-1) * (1-i/n);
    const src = c.createBufferSource(); src.buffer = buf;
    const filt = c.createBiquadFilter(); filt.type='lowpass'; filt.frequency.value=520;
    const g = c.createGain(); const t0 = c.currentTime+start;
    g.gain.setValueAtTime(0.35, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0+0.12);
    src.connect(filt); filt.connect(g); g.connect(c.destination);
    src.start(t0);
  }
  const rnd = (a,b)=>a+Math.random()*(b-a);

  /* Synthesized versions — used for UI feedback and as a fallback when a sound file is missing. */
  const synth = {
    gameStart(){ [392,523,659].forEach((f,i)=>tone(f,i*0.07,0.14,{type:'triangle',gain:0.14})); },
    moveSelf(){ tone(520,0,0.09,{type:'triangle'}); },
    moveOpponent(){ tone(392,0,0.10,{type:'sine'}); },
    capture(){ thud(0); tone(180,0.01,0.1,{type:'triangle',gain:0.12}); },
    castle(){ tone(440,0,0.07,{type:'triangle'}); tone(660,0.08,0.09,{type:'triangle'}); },
    check(){ tone(880,0,0.08,{type:'square',gain:0.1}); tone(660,0.09,0.12,{type:'square',gain:0.1}); },
    promote(){ [523,659,784].forEach((f,i)=>tone(f,i*0.08,0.12,{type:'triangle'})); },
    premove(){ tone(300,0,0.05,{type:'sine',gain:0.1}); },
    tenSeconds(){ tone(1000,0,0.08,{type:'square',gain:0.08}); tone(1000,0.14,0.08,{type:'square',gain:0.08}); },
    gameEnd(kind){
      if(kind==='win') [523,659,784,1046].forEach((f,i)=>tone(f,i*0.11,0.18,{type:'triangle'}));
      else if(kind==='lose') [392,349,293].forEach((f,i)=>tone(f,i*0.14,0.22,{type:'sine'}));
      else [440,440].forEach((f,i)=>tone(f,i*0.18,0.16,{type:'sine'}));
    },
    invalid(){ tone(180,0,0.09,{type:'sawtooth',gain:0.08}); }
  };
  /* UI feedback is always synthesized (tiny, quiet). */
  const ui = {
    tap(){ tone(rnd(640,860),0,0.035,{type:'sine',gain:0.07}); },
    toggle(on){ tone(on?820:560,0,0.05,{type:'sine',gain:0.08}); tone(on?1040:420,0.05,0.05,{type:'sine',gain:0.06}); },
    swipe(){ const f = rnd(240,360); tone(f,0,0.14,{type:'sine',gain:0.05,sweepTo:f*2.2}); },
    loopStart(){
      if(loopTimer) return;
      let k = 0;
      loopTimer = setInterval(()=>{ try{ tone([440,523,659,523][k++%4],0,0.08,{type:'sine',gain:0.05}); }catch(e){} }, 360);
    },
    loopStop(){ if(loopTimer){ clearInterval(loopTimer); loopTimer = null; } }
  };

  /* Lichess sound files (sounds/<pack>/<Name>.mp3). A missing/unplayable file
     falls back to its synthesized version. */
  const FILE = {
    gameStart:{n:'GenericNotify', c:'game-start.mp3', v:0.6}, moveSelf:{n:'Move', c:'move-self.mp3', v:0.7}, moveOpponent:{n:'Move', c:'move-opponent.mp3', v:0.7},
    capture:{n:'Capture', c:'capture.mp3', v:0.8}, castle:{n:'Move', c:'castle.mp3', v:0.8}, check:{n:'Check', c:'move-check.mp3', v:0.8},
    promote:{n:'Confirmation', c:'promote.mp3', v:0.6}, premove:{n:'Move', c:'move-self.mp3', v:0.35, rate:1.25}, tenSeconds:{n:'LowTime', c:'tenseconds.mp3', v:0.7},
    invalid:{n:'Error', c:null, v:0.5}
  };
  const END_FILE = {win:'Victory', lose:'Defeat', draw:'Draw'};
  const cache = {}, broken = {};
  function srcFor(name, cname){
    if(settings.soundPack === 'cobra') return cname ? 'sounds/cobra/'+cname : null;
    return 'sounds/'+settings.soundPack+'/'+name+'.mp3';
  }
  function audioFor(name, cname){
    const src = srcFor(name, cname);
    if(!src) return null;
    const key = src;
    if(broken[key]) return null;
    if(!cache[key]){
      try{
        const a = new Audio(src);
        a.preload = 'auto';
        a.addEventListener('error', ()=>{ broken[key] = true; });
        cache[key] = a;
      }catch(e){ broken[key] = true; return null; }
    }
    return cache[key];
  }
  function playFile(name, cname, vol, rate, fallback){
    if(!settings.sound) return;
    if(settings.soundPack === 'synth'){ fallback(); return; }
    const base = audioFor(name, cname);
    if(!base){ fallback(); return; }
    try{
      const a = base.cloneNode(true);
      a.volume = vol; a.playbackRate = rate || 1;
      const pr = a.play();
      if(pr && pr.catch) pr.catch(err=>{
        if(err && err.name === 'NotAllowedError') return;   // autoplay policy: stay silent
        broken[srcFor(name, cname)] = true; fallback();
      });
    }catch(e){ fallback(); }
  }

  const api = {};
  Object.keys(FILE).forEach(k=>{
    api[k] = function(){ const f = FILE[k]; playFile(f.n, f.c, f.v, f.rate, ()=>synth[k]()); };
  });
  api.gameEnd = function(kind){ playFile(END_FILE[kind] || 'Draw', 'game-end.mp3', 0.8, 1, ()=>synth.gameEnd(kind)); };
  api.preload = function(){
    if(settings.soundPack === 'synth') return;
    Object.keys(FILE).forEach(k=>audioFor(FILE[k].n, FILE[k].c));
    ['Victory','Defeat','Draw'].forEach(n=>audioFor(n, 'game-end.mp3'));
    if(settings.soundPack === 'cobra'){
      ['button-click_01.wav','button-click_02.wav','button-click_03.wav','button-click_04.wav','button-click_05.wav','toggle_on.wav','toggle_off.wav','progress_loop.wav'].forEach(c=>audioFor('', c));
    }
  };
  /* UI sounds: use the Cobra pack's own click / toggle / loading files when present, else synthesize. */
  const pick = (arr)=>arr[Math.floor(Math.random()*arr.length)];
  let loopAudio = null;
  api.tap = function(){
    if(settings.soundPack === 'cobra') playFile('', pick(['button-click_01.wav','button-click_02.wav','button-click_03.wav','button-click_04.wav','button-click_05.wav']), 0.5, 1, ()=>ui.tap());
    else ui.tap();
  };
  api.toggle = function(on){
    if(settings.soundPack === 'cobra') playFile('', on ? 'toggle_on.wav' : 'toggle_off.wav', 0.6, 1, ()=>ui.toggle(on));
    else ui.toggle(on);
  };
  api.swipe = ui.swipe;
  api.loopStart = function(){
    if(settings.sound && settings.soundPack === 'cobra'){
      const base = audioFor('', 'progress_loop.wav');
      if(base){ if(!loopAudio){ loopAudio = base.cloneNode(true); loopAudio.loop = true; loopAudio.volume = 0.6; } loopAudio.play().catch(()=>{}); return; }
    }
    ui.loopStart();
  };
  api.loopStop = function(){ if(loopAudio){ loopAudio.pause(); loopAudio.currentTime = 0; } ui.loopStop(); };

  const safe = {};
  Object.keys(api).forEach(k=>{ safe[k] = function(){ try{ api[k].apply(null, arguments); }catch(e){ /* audio unavailable */ } }; });
  return safe;
})();

/* ---------------------------------------------------------
   5. Small UI services: toasts, dialogs, clipboard, download
   --------------------------------------------------------- */
function notify(message, kind){
  const host = $('#toasts'); if(!host) return;
  const el = document.createElement('div');
  el.className = 'toast glass' + (kind ? ' toast-'+kind : '');
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(()=>el.classList.add('in'));
  setTimeout(()=>{ el.classList.remove('in'); setTimeout(()=>el.remove(), 300); }, 3400);
}

function dialog(cfg){
  return new Promise(resolve=>{
    const backdrop = $('#dialog-backdrop');
    $('#dialog-title').textContent = cfg.title || '';
    $('#dialog-body').textContent = cfg.body || '';
    const box = $('#dialog-actions'); box.innerHTML = '';
    let done = false;
    function close(v){
      if(done) return; done = true;
      backdrop.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.removeEventListener('mousedown', onBackdrop);
      resolve(v);
    }
    function onKey(e){ if(e.key === 'Escape'){ e.stopPropagation(); close(null); } }
    function onBackdrop(e){ if(e.target === backdrop) close(null); }
    let first = null;
    (cfg.actions||[]).forEach(a=>{
      const b = document.createElement('button');
      b.className = a.kind || 'btn-ghost'; b.textContent = a.label;
      b.addEventListener('click', ()=>close(a.value));
      box.appendChild(b);
      if(!first && (a.kind==='btn-primary' || a.kind==='btn-danger')) first = b;
    });
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('mousedown', onBackdrop);
    backdrop.hidden = false;
    const target = first || box.firstChild; if(target) target.focus();
  });
}
function confirmDialog(title, body, okLabel, danger){
  return dialog({title:title, body:body, actions:[
    {label:'Cancel', value:false, kind:'btn-ghost'},
    {label:okLabel||'OK', value:true, kind: danger ? 'btn-danger' : 'btn-primary'}
  ]}).then(v=>v===true);
}

function fallbackCopy(text){
  try{
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly',''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return !!ok;
  }catch(e){ return false; }
}
function copyText(text){
  if(navigator.clipboard && window.isSecureContext){
    return navigator.clipboard.writeText(text).then(()=>true).catch(()=>fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}
function downloadText(filename, text, mime){
  const blob = new Blob([text], {type: mime || 'text/plain'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
}
async function shareText(title, text){
  if(navigator.share){
    try{ await navigator.share({title:title, text:text}); return; }
    catch(e){ if(e && e.name === 'AbortError') return; }
  }
  const ok = await copyText(text);
  notify(ok ? 'Copied to clipboard — paste it to share.' : 'Sharing is not available here.', ok ? '' : 'warn');
}

/* ---------------------------------------------------------
   6. Stockfish 18 engines (Web Worker)
   ---------------------------------------------------------
   Two builds ship with the app:
     • WASM  — engine/stockfish.js + .wasm  (fast; needs http://)
     • JS    — engine/stockfish-asm.embed.js (pure JavaScript, the
               open-source asm.js build; slower, but runs anywhere,
               including when index.html is opened straight from disk,
               because it is started from an in-memory Blob).
   "Automatic" tries WASM first and falls back to JS.
   --------------------------------------------------------- */
const ENGINE_LABEL = {
  wasm:'Cobra Engine · WebAssembly',
  js:'Cobra Engine · JavaScript'
};
let embedPromise = null, embedBlobUrl = null;
function loadEmbeddedEngine(){
  if(embedBlobUrl) return Promise.resolve(embedBlobUrl);
  if(!embedPromise){
    embedPromise = new Promise((resolve, reject)=>{
      const finish = ()=>{
        if(!window.__SF_ASM_SRC){ embedPromise = null; reject(new Error('engine source missing')); return; }
        embedBlobUrl = URL.createObjectURL(new Blob([window.__SF_ASM_SRC], {type:'text/javascript'}));
        window.__SF_ASM_SRC = null;            // free the 10 MB string once it lives in the Blob
        resolve(embedBlobUrl);
      };
      if(window.__SF_ASM_SRC){ finish(); return; }
      const s = document.createElement('script');
      s.src = 'engine/stockfish-asm.embed.js';
      s.onload = finish;
      s.onerror = ()=>{ embedPromise = null; reject(new Error('engine file not found')); };
      document.head.appendChild(s);
    });
  }
  return embedPromise;
}
async function createWorker(kind){
  if(kind === 'wasm') return new Worker('engine/stockfish.js');
  return new Worker(await loadEmbeddedEngine());
}

const NO_RESULT = {bestmove:null, info:null, info2:null};

class Engine{
  constructor(){
    this.worker = null; this.available = false; this.ready = false; this.kind = null;
    this.busy = false; this.queue = [];
    this._uciResolve = null; this._readyResolve = null; this._resolve = null;
    this._infos = {};
    this.onRuntimeFail = null;
  }
  async boot(choice){
    const onDisk = location.protocol === 'file:';     // browsers refuse the WebAssembly worker on file://
    const order = choice === 'wasm' ? ['wasm'] : choice === 'js' ? ['js'] : (onDisk ? ['js'] : ['wasm','js']);
    for(const kind of order){
      if(await this._tryKind(kind)) return true;
    }
    return false;
  }
  async _tryKind(kind){
    this._teardown();
    let worker;
    try{ worker = await createWorker(kind); }
    catch(err){ console.info('Cobra: '+ENGINE_LABEL[kind]+' is unavailable here.', err && err.message); return false; }
    this.worker = worker; this.available = true; this.kind = kind;
    worker.onmessage = (e)=>this._onLine(e.data);
    worker.onerror = (err)=>{
      console.warn('Cobra: engine worker error.', err && err.message);
      const wasReady = this.ready;
      this._teardown();
      if(wasReady && this.onRuntimeFail) this.onRuntimeFail();
    };
    this.ready = false;
    const handshake = (async ()=>{
      await this.uci(); if(!this.available) return false;
      await this.isready(); if(!this.available) return false;
      this._send('ucinewgame');
      return true;
    })();
    const ok = await Promise.race([handshake, sleep(kind === 'js' ? 40000 : 20000).then(()=>false)]);
    if(!ok){ console.warn('Cobra: '+ENGINE_LABEL[kind]+' did not answer.'); this._teardown(); return false; }
    this.ready = true;
    return true;
  }
  _teardown(){
    if(this.worker){ try{ this.worker.onmessage = this.worker.onerror = null; this.worker.terminate(); }catch(e){} }
    this.worker = null; this.available = false; this.ready = false; this.kind = null;
    const u = this._uciResolve, r = this._readyResolve, g = this._resolve, q = this.queue;
    this._uciResolve = this._readyResolve = this._resolve = null;
    this.queue = []; this.busy = false; this._infos = {};
    if(u) u(); if(r) r();
    if(g) g(NO_RESULT);
    q.forEach(job=>job.resolve(NO_RESULT));
  }
  _onLine(line){
    if(typeof line !== 'string') return;
    if(line === 'uciok' && this._uciResolve){ const r=this._uciResolve; this._uciResolve=null; r(); return; }
    if(line === 'readyok' && this._readyResolve){ const r=this._readyResolve; this._readyResolve=null; r(); return; }
    if(line.startsWith('info')){
      if(line.includes('lowerbound') || line.includes('upperbound')) return;
      const sc = line.match(/score (cp|mate) (-?\d+)/); if(!sc) return;
      const mpv = line.match(/multipv (\d+)/);
      const depth = line.match(/\bdepth (\d+)/);
      const pv = line.match(/ pv (.+)$/);
      this._infos[mpv ? parseInt(mpv[1],10) : 1] = {
        cp: sc[1]==='cp' ? parseInt(sc[2],10) : null,
        mate: sc[1]==='mate' ? parseInt(sc[2],10) : null,
        depth: depth ? parseInt(depth[1],10) : null,
        pv: pv ? pv[1].trim().split(/\s+/) : []
      };
      return;
    }
    if(line.startsWith('bestmove')){
      const best = line.split(' ')[1];
      const infos = this._infos; this._infos = {};
      const resolve = this._resolve; this._resolve = null;
      this.busy = false;
      if(resolve) resolve({bestmove: (!best || best==='(none)') ? null : best, info: infos[1]||null, info2: infos[2]||null, lines: infos});
      this._pump();
    }
  }
  _send(cmd){ if(this.worker && this.available){ try{ this.worker.postMessage(cmd); }catch(e){ this._teardown(); } } }
  uci(){ if(!this.available) return Promise.resolve(); return new Promise(res=>{ this._uciResolve=res; this._send('uci'); }); }
  isready(){ if(!this.available) return Promise.resolve(); return new Promise(res=>{ this._readyResolve=res; this._send('isready'); }); }
  setOption(name, value){ this._send('setoption name '+name+' value '+value); }
  newGame(){ this._send('ucinewgame'); }
  _pump(){
    if(this.busy || !this.queue.length || !this.available) return;
    const job = this.queue.shift();
    this.busy = true; this._resolve = job.resolve; this._infos = {};
    this._send('position fen '+job.fen);
    this._send(job.cmd);
  }
  _search(fen, cmd){
    if(!this.available) return Promise.resolve(NO_RESULT);
    return new Promise(resolve=>{ this.queue.push({fen:fen, cmd:cmd, resolve:resolve}); this._pump(); });
  }
  go(fen, o){
    o = o || {};
    let cmd = 'go';
    if(o.depth) cmd += ' depth '+o.depth;
    if(o.movetime || !o.depth) cmd += ' movetime '+Math.max(20, Math.round(o.movetime||1000));
    return this._search(fen, cmd);
  }
  stop(){ if(this.busy) this._send('stop'); }
}

const engine = new Engine();        // plays the bot's moves
const reviewEngine = new Engine();  // eval bar + game review
let engineReady = false;            // both engines booted
let engineBooting = true;           // true until the first boot attempt finishes
let engineInitPromise = null;

function botMode(){ return engine.available || engineBooting; }
function skillFor(level){ return Math.round((level-1)/(MAX_LEVEL-1)*20); }
function applySkillLevel(level){ engine.setOption('Skill Level', skillFor(level)); }

function updateEngineChip(){
  const t = $('#engine-chip-text'); if(!t) return;
  if(engineBooting) t.textContent = 'Starting engine…';
  else if(engine.available) t.textContent = ENGINE_LABEL[engine.kind] || 'Cobra Engine';
  else t.textContent = 'No engine — pass & play';
  const chip = $('#engine-chip'); if(chip) chip.classList.toggle('is-off', !engineBooting && !engine.available);
}

async function bootEngines(choice){
  engineBooting = true; engineReady = false; updateEngineChip();
  const [a, b] = await Promise.all([engine.boot(choice), reviewEngine.boot(choice)]);
  engineReady = !!(a && b);
  if(engineReady){
    [engine, reviewEngine].forEach(e=>{ e.setOption('Threads', 1); e.setOption('Hash', 16); });
    applySkillLevel(state.skillLevel);
  } else {
    // If only one of the two came up, drop both so behaviour is consistent.
    engine._teardown(); reviewEngine._teardown();
  }
  engineBooting = false;
  const banner = $('#engine-banner'); if(banner) banner.hidden = engineReady;
  updateEngineChip(); refreshControls();
  return engineReady;
}
function onEngineRuntimeFail(){
  engineReady = false;
  engine._teardown(); reviewEngine._teardown();
  const banner = $('#engine-banner'); if(banner) banner.hidden = false;
  updateEngineChip(); refreshControls(); renderClocks();
  setThinking(false);
  notify('The chess engine stopped — switching to pass-and-play.', 'warn');
}
engine.onRuntimeFail = onEngineRuntimeFail;
reviewEngine.onRuntimeFail = onEngineRuntimeFail;

/* Convert an engine info object to a White-relative evaluation. */
function infoToEval(info, turn){
  if(!info) return null;
  let cp, mate = null;
  if(info.mate != null){
    mate = turn==='w' ? info.mate : -info.mate;
    cp = (mate>0?1:-1) * (3000 - Math.min(Math.abs(mate),50)*20);
  } else {
    cp = turn==='w' ? info.cp : -info.cp;
  }
  return {cp:cp, mate:mate};
}

/* ---------------------------------------------------------
   7. Opening book — original list of mainline sequences, matched
   by position (so transpositions count too).
   --------------------------------------------------------- */
const BOOK_LINES = ["e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3", "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5 Qxd8+ Kxd8", "e4 e5 Nf3 Nc6 Bb5 Nf6 d3 Bc5 c3 O-O O-O d6", "e4 e5 Nf3 Nc6 Bb5 f5 Nc3 fxe4 Nxe4 d5 Nxe5 dxe4 Nxc6 Qg5", "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O", "e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5 d4 exd4 O-O", "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5 Bb5+ c6 dxc6 bxc6 Be2 h6 Nf3 e4 Ne5 Bd6", "e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Be7 O-O O-O", "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nxc6 bxc6 e5 Qe7 Qe2 Nd5 c4 Ba6", "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Bc5 Be3 Qf6 c3 Nge7 Bc4 O-O", "e4 e5 Nf3 Nc6 d4 exd4 Bc4 Bc5 c3 Nf6 e5 d5 Bb5 Ne4", "e4 e5 Nf3 Nc6 Nc3 Nf6 Bb5 Bb4 O-O O-O d3 d6 Bg5 Bxc3 bxc3 Qe7", "e4 e5 Nf3 Nc6 Nc3 Nf6 d4 exd4 Nxd4 Bb4 Nxc6 bxc6 Bd3 d5 exd5 cxd5 O-O O-O", "e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5 Bd3 Nc6 O-O Be7 c4 Nb4", "e4 e5 Nf3 Nf6 d4 Nxe4 Bd3 d5 Nxe5 Nd7 Nxd7 Bxd7 Qe2 Qe7 O-O O-O-O", "e4 e5 Nf3 d6 d4 Nf6 Nc3 Nbd7 Bc4 Be7 O-O O-O Qe2 c6 a4 exd4", "e4 e5 Nc3 Nf6 f4 d5 fxe5 Nxe4 Nf3 Be7 d3 Nxc3 bxc3 O-O", "e4 e5 f4 exf4 Nf3 g5 h4 g4 Ne5 Nf6 Bc4 d5 exd5 Bd6", "e4 e5 f4 d5 exd5 exf4 Nf3 Nf6 Bc4 Nxd5 O-O Be7 d4 O-O", "e4 e5 Bc4 Nf6 d3 c6 Nf3 d5 Bb3 Bd6 O-O O-O", "e4 e5 Qh5 Nc6 Bc4 g6 Qf3 Nf6 Qb3 Qe7 Nc3 Na5 Qa4 c6", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3 Be7 Qd2 O-O O-O-O", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6 Be3 Bg7 f3 O-O Qd2 Nc6 Bc4 Bd7 O-O-O", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6 Bg5 e6 Qd2 a6 O-O-O Bd7 f4 Be7", "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 d6 Bg5 e6 Qd2 a6 O-O-O Bd7 f4 Be7", "e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6 Bd3 Nf6 O-O Qc7 Qe2 d6 c4 g6 Nc3 Bg7", "e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Qc7 Be3 a6 Qd2 Nf6 O-O-O Be7 f3 O-O", "e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nf6 Nc3 d6 Be2 Be7 O-O O-O f4 Nc6 Be3 Bd7", "e4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7 d3 d6 Be3 e6 Qd2 Nge7", "e4 c5 c3 d5 exd5 Qxd5 d4 Nf6 Nf3 e6 Be2 cxd4 cxd4 Nc6", "e4 c5 c3 Nf6 e5 Nd5 d4 cxd4 Nf3 Nc6 cxd4 d6 Bc4 Nb6 Bb5 dxe5 Nxe5 Bd7", "e4 c5 Nf3 d6 Bb5+ Bd7 Bxd7+ Qxd7 c4 Nc6 Nc3 Nf6 O-O g6 d4 cxd4 Nxd4 Bg7", "e4 c5 Nf3 Nc6 Bb5 g6 Bxc6 dxc6 d3 Bg7 h3 Nf6 Nc3 O-O", "e4 c5 d4 cxd4 c3 dxc3 Nxc3 Nc6 Nf3 d6 Bc4 e6 O-O Nf6 Qe2 Be7", "e4 e6 d4 d5 Nc3 Nf6 Bg5 Be7 e5 Nfd7 Bxe7 Qxe7 f4 O-O Nf3 c5", "e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3 Ne7 Qg4 O-O Bd3 Nbc6", "e4 e6 d4 d5 Nd2 Nf6 e5 Nfd7 Bd3 c5 c3 Nc6 Ne2 cxd4 cxd4 f6", "e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6 a3 c4 Nbd2 Na5", "e4 e6 d4 d5 exd5 exd5 Nf3 Nf6 Bd3 Bd6 O-O O-O Bg5 Bg4", "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7 h5 Bh7 Bd3 Bxd3 Qxd3 e6", "e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 Nd7 O-O Ne7 c3 h6", "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nd7 Nf3 Ngf6 Nxf6+ Nxf6 Ne5 Be6", "e4 c6 Nc3 d5 Nf3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Ne5 Bh7 Bc4 e6", "e4 c6 d4 d5 exd5 cxd5 c4 Nf6 Nc3 e6 Nf3 Be7 cxd5 Nxd5 Bd3 Nc6 O-O O-O", "e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6 Bc4 Bf5 Bd2 e6 Qe2 Bb4", "e4 d5 exd5 Nf6 d4 Nxd5 Nf3 g6 Be2 Bg7 O-O O-O c4 Nb6 Nc3 Nc6", "e4 d6 d4 Nf6 Nc3 g6 Nf3 Bg7 Be2 O-O O-O Bg4 Be3 Nc6", "e4 d6 d4 Nf6 Nc3 g6 f4 Bg7 Nf3 O-O Bd3 Na6 O-O c5", "e4 g6 d4 Bg7 Nc3 d6 Nf3 Nf6 Be2 O-O O-O Bg4 Be3 Nc6", "e4 Nf6 e5 Nd5 d4 d6 Nf3 Bg4 Be2 e6 O-O Be7 c4 Nb6 Nc3 O-O", "e4 Nf6 e5 Nd5 d4 d6 c4 Nb6 f4 dxe5 fxe5 Nc6 Be3 Bf5 Nc3 e6", "e4 b6 d4 Bb7 Nc3 e6 Nf3 Nf6 Bd3 Bb4 Qe2 O-O Bd2 d5", "e4 Nc6 Nf3 e5 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5 Qxd8+ Kxd8", "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6 cxd5 Nxd5", "d4 d5 c4 e6 Nc3 Nf6 Nf3 Be7 Bg5 h6 Bh4 O-O e3 Ne4 Bxe7 Qxe7 cxd5 Nxc3 bxc3 exd5", "d4 d5 c4 e6 Nc3 c6 e3 Nf6 Nf3 Nbd7 Bd3 dxc4 Bxc4 b5 Bd3 a6 e4 c5", "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5 e3 e6 Bxc4 Bb4 O-O Nbd7", "d4 d5 c4 c6 Nf3 Nf6 e3 e6 Nbd2 Nbd7 Bd3 dxc4 Bxc4 b5 Bd3 a6 e4 c5", "d4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5 O-O a6 Bb3 cxd4 exd4 Nc6", "d4 d5 c4 dxc4 e3 Nf6 Bxc4 e6 Nf3 c5 O-O a6 Qe2 b5 Bb3 Bb7", "d4 d5 Nf3 Nf6 c4 e6 Nc3 Be7 Bg5 h6 Bh4 O-O e3 b6 Rc1 Bb7", "d4 d5 Nf3 Nf6 Bf4 e6 e3 c5 c3 Nc6 Nbd2 Bd6 Bg3 O-O", "d4 d5 Bf4 Nf6 e3 e6 Nf3 Bd6 Bg3 O-O Nbd2 c5 c3 Nc6", "d4 d5 Nf3 Nf6 Bg5 Ne4 Bf4 c5 e3 Qb6 Nbd2 Nxd2 Qxd2 e6 c3 Nc6", "d4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5 Nf3 c5 O-O Nc6 a3 Bxc3 bxc3 dxc4 Bxc4 Qc7", "d4 Nf6 c4 e6 Nf3 b6 g3 Bb7 Bg2 Be7 O-O O-O Nc3 Ne4 Qc2 Nxc3 Qxc3 d6", "d4 Nf6 c4 e6 Nf3 d5 Nc3 Be7 Bg5 h6 Bh4 O-O e3 Ne4 Bxe7 Qxe7", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7", "d4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7 Nf3 c5 Rb1 O-O", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f3 O-O Be3 e5 d5 Nh5 Qd2 f5", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Be2 O-O Nf3 e5 O-O Nc6 d5 Ne7", "d4 Nf6 Nf3 g6 Bf4 Bg7 e3 O-O h3 d6 Be2 Nbd7 O-O b6", "d4 Nf6 Nf3 e6 Bf4 c5 e3 Nc6 Nbd2 Qb6 c3 d5 Bd3 Bd6", "d4 Nf6 Bg5 Ne4 Bf4 d5 e3 c5 c3 Nc6 Nd2 Nxd2 Qxd2 e6", "d4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3 O-O O-O dxc4 Qc2 a6 Qxc4 b5 Qc2 Bb7", "d4 f5 g3 Nf6 Bg2 e6 Nf3 Be7 O-O O-O c4 d6 Nc3 Qe8", "d4 e6 e4 d5 Nc3 Nf6 Bg5 Be7 e5 Nfd7 Bxe7 Qxe7 f4 O-O Nf3 c5", "c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6 O-O Be7 d3 O-O", "c4 e5 Nc3 Nc6 g3 g6 Bg2 Bg7 d3 d6 Rb1 f5 Nf3 Nf6 O-O O-O", "c4 c5 Nf3 Nf6 Nc3 Nc6 g3 g6 Bg2 Bg7 O-O O-O d4 cxd4 Nxd4 d6", "c4 e6 Nc3 d5 d4 Nf6 Nf3 Be7 Bg5 O-O e3 h6 Bh4 b6 cxd5 Nxd5", "c4 Nf6 Nc3 g6 e4 d6 d4 Bg7 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7", "c4 Nf6 Nc3 e6 e4 d5 e5 d4 exf6 dxc3 bxc3 Qxf6 d4 c5 Nf3 Nc6", "Nf3 d5 g3 Nf6 Bg2 c6 O-O Bg4 d3 Nbd7 Nbd2 e5 e4 Bc5", "Nf3 d5 c4 d4 b4 c5 Bb2 cxb4 Bxd4 Nf6 g3 Nc6 Bb2 e5", "Nf3 Nf6 c4 g6 Nc3 Bg7 e4 d6 d4 O-O Be2 e5 O-O Nc6 d5 Ne7", "Nf3 Nf6 g3 g6 Bg2 Bg7 O-O O-O d3 d6 e4 c5 Nbd2 Nc6 Re1 Rb8", "Nf3 d5 d4 Nf6 c4 e6 Nc3 Be7 Bg5 h6 Bh4 O-O e3 Ne4 Bxe7 Qxe7 Rc1 c6 Bd3 Nxc3 Rxc3 dxc4 Bxc4 Nd7", "Nf3 c5 c4 Nc6 Nc3 e5 g3 g6 Bg2 Bg7 O-O Nge7 d3 O-O", "b3 e5 Bb2 Nc6 e3 d5 Bb5 Bd6 Bxc6+ bxc6 d3 Ne7", "b3 d5 Bb2 Nf6 e3 e6 Nf3 Bd6 Be2 O-O O-O Nbd7 d3 c5", "f4 d5 Nf3 Nf6 e3 g6 Be2 Bg7 O-O O-O d3 c5", "g3 d5 Bg2 Nf6 Nf3 c6 O-O Bg4 d3 Nbd7 Nbd2 e5 e4 Bc5", "e3 e5 c4 d6 Nc3 Nf6 a3 g6 d4 exd4 exd4 Bg7"];
let bookSet = null;
function epd(fen){ return fen.split(' ').slice(0,4).join(' '); }
function buildBook(){
  if(bookSet) return bookSet;
  bookSet = new Set();
  BOOK_LINES.forEach(line=>{
    const g = new Chess();
    for(const san of line.split(' ')){
      try{ g.move(san); }catch(e){ break; }
      bookSet.add(epd(g.fen()));
    }
  });
  return bookSet;
}

/* ---------------------------------------------------------
   8. Game state
   --------------------------------------------------------- */
const game = new Chess();
const state = {
  mode:'play',                 // 'play' vs the bot, or 'analysis'
  humanColor:'w', flipped:false,
  selected:null, legalTargets:[], premove:null, promoting:false,
  skillLevel: clamp(parseInt(settings.level,10)||7, 1, MAX_LEVEL),
  takebacksLeft:3, hintsLeft:3, assisted:false, hint:null,
  shapes:{arrows:[], marks:[]}, drawing:null,
  initialMs:180000, incrementSec:2, untimed:false,
  clocks:{w:180000, b:180000}, clockTimer:null, lastTick:0,
  lowFlags:{quarter:false, ten:false},
  gameOver:false, result:null,
  viewPly:null, autoplayTimer:null,
  review:null, reviewing:false, reviewAbort:false,
  evalCp:0, evalSeq:0, botToken:0, thinking:false
};

const boardEl = $('#board');

function isViewing(){ return state.viewPly !== null && state.viewPly < game.history().length; }
function currentPly(){ return state.viewPly === null ? game.history().length : state.viewPly; }
function viewFen(){
  if(!isViewing()) return game.fen();
  const h = game.history({verbose:true});
  return state.viewPly === 0 ? h[0].before : h[state.viewPly-1].after;
}
function humanToMove(){
  if(state.gameOver) return false;
  if(state.mode === 'analysis' || !botMode()) return true;
  return game.turn() === state.humanColor;
}
function movableColor(){
  if(state.mode === 'analysis' || !botMode()) return game.turn();
  return state.humanColor;
}
function botName(){ return 'Cobra'; }

/* ---------------------------------------------------------
   9. Board rendering
   --------------------------------------------------------- */
function squareEl(sq){ return $('.sq[data-square="'+sq+'"]', boardEl); }

function orientedSquares(){
  const ranks = state.flipped ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1];
  const files = state.flipped ? FILES.slice().reverse() : FILES;
  const out = [];
  ranks.forEach(r=> files.forEach(f=> out.push(f+r)));
  return out;
}

function buildBoardDOM(){
  boardEl.innerHTML = '';
  orientedSquares().forEach((sq, idx)=>{
    const file = sq[0], rank = sq[1];
    const isLight = (FILES.indexOf(file) + parseInt(rank,10)) % 2 === 0;
    const div = document.createElement('div');
    div.className = 'sq ' + (isLight ? 'light' : 'dark');
    div.dataset.square = sq;
    const col = idx % 8, row = Math.floor(idx/8);
    if(settings.showCoords){
      if(row === 7){ const c = document.createElement('span'); c.className='coord file'; c.textContent=file; div.appendChild(c); }
      if(col === 0){ const c = document.createElement('span'); c.className='coord rank'; c.textContent=rank; div.appendChild(c); }
    }
    div.addEventListener('click', onSquareClick);
    boardEl.appendChild(div);
  });
  $('#eval-bar').classList.toggle('is-flipped', state.flipped);
}

function kingSquare(g, color){
  const b = g.board();
  for(let r=0;r<8;r++) for(let c=0;c<8;c++){
    const cell = b[r][c];
    if(cell && cell.type==='k' && cell.color===color) return FILES[c]+(8-r);
  }
  return null;
}

function renderBoard(){
  const fen = viewFen();
  const vg = fen === game.fen() ? game : new Chess(fen);
  $$('.sq', boardEl).forEach(sq=>{
    sq.classList.remove('is-selected','is-target','is-last','is-check','has-piece','is-premove');
    $$('.pc, .mbadge', sq).forEach(n=>n.remove());
  });
  const b = vg.board();
  for(let r=0;r<8;r++){
    for(let c=0;c<8;c++){
      const cell = b[r][c]; if(!cell) continue;
      const el = squareEl(FILES[c]+(8-r)); if(!el) continue;
      el.classList.add('has-piece');
      el.insertAdjacentHTML('beforeend', pieceMarkup(cell.type, cell.color, settings.pieceStyle));
    }
  }
  const hist = game.history({verbose:true});
  const ply = currentPly();
  if(ply > 0){
    const m = hist[ply-1];
    const a = squareEl(m.from), z = squareEl(m.to);
    if(a) a.classList.add('is-last');
    if(z) z.classList.add('is-last');
    if(state.review && state.review.rows[ply-1] && z){
      const cls = state.review.rows[ply-1].cls;
      z.insertAdjacentHTML('beforeend', '<span class="mbadge b-'+cls+'" title="'+CLS[cls].label+'">'+clsImg(cls)+'</span>');
    }
  }
  if(!isViewing()){
    if(state.selected){
      const s = squareEl(state.selected); if(s) s.classList.add('is-selected');
      if(settings.showHighlights) state.legalTargets.forEach(t=>{ const el = squareEl(t.to); if(el) el.classList.add('is-target'); });
    }
    if(state.premove){
      const a = squareEl(state.premove.from), z = squareEl(state.premove.to);
      if(a) a.classList.add('is-premove');
      if(z){
        z.classList.add('is-premove');
        const mover = game.get(state.premove.from);
        if(mover) z.insertAdjacentHTML('beforeend', pieceMarkup(mover.type, mover.color, settings.pieceStyle, 'ghost'));
      }
    }
  }
  if(vg.inCheck()){
    const ks = kingSquare(vg, vg.turn()); const el = ks && squareEl(ks);
    if(el) el.classList.add('is-check');
  }
  drawBestArrow(); drawShapes(); renderCaptured(vg);
}

/* ---- Arrow / mark layers ------------------------------------------------ */
function shapeLayer(id){
  let layer = document.getElementById(id);
  if(!layer){
    layer = document.createElementNS('http://www.w3.org/2000/svg','svg');
    layer.setAttribute('id', id); layer.setAttribute('viewBox','0 0 8 8');
    layer.classList.add('shape-layer');
    boardEl.parentNode.appendChild(layer);
  }
  return layer;
}
function sqPoint(sq){
  let f = FILES.indexOf(sq[0]), r = parseInt(sq[1],10)-1;
  if(state.flipped){ f = 7-f; r = 7-r; }
  return {x:f+0.5, y:7-r+0.5};
}
function arrowSVG(from, to, color, opacity){
  const a = sqPoint(from), z = sqPoint(to);
  const dx = z.x-a.x, dy = z.y-a.y, len = Math.hypot(dx,dy) || 1;
  const ux = dx/len, uy = dy/len, head = 0.4;
  const sx = a.x+ux*0.22, sy = a.y+uy*0.22;
  const ex = z.x-ux*head*0.85, ey = z.y-uy*head*0.85;
  return '<line x1="'+sx+'" y1="'+sy+'" x2="'+ex+'" y2="'+ey+'" stroke="'+color+'" stroke-width="0.17" stroke-linecap="round" opacity="'+opacity+'"/>'+
         '<polygon points="'+z.x+','+z.y+' '+(ex-uy*0.25)+','+(ey+ux*0.25)+' '+(ex+uy*0.25)+','+(ey-ux*0.25)+'" fill="'+color+'" opacity="'+opacity+'"/>';
}
/* Game Review: the engine's preferred move after an inaccuracy, mistake or blunder. */
function drawBestArrow(){
  const layer = shapeLayer('arrow-layer'); layer.innerHTML = '';
  const ply = currentPly();
  if(!state.review || ply < 1) return;
  const row = state.review.rows[ply-1];
  if(!row || !row.bestUci || ['inaccuracy','mistake','blunder'].indexOf(row.cls) < 0) return;
  layer.innerHTML = arrowSVG(row.bestUci.slice(0,2), row.bestUci.slice(2,4), '#0a84ff', 0.85);
}
/* Right-click arrows and marks, plus the hint arrow. */
const SHAPE_COLORS = {blue:'#0a84ff', green:'#30d158', red:'#ff453a', yellow:'#ffd60a'};
function drawShapes(){
  const layer = shapeLayer('draw-layer'); let h = '';
  state.shapes.marks.forEach(m=>{
    const c = sqPoint(m.sq);
    h += '<circle cx="'+c.x+'" cy="'+c.y+'" r="0.44" fill="none" stroke="'+SHAPE_COLORS[m.color]+'" stroke-width="0.075" opacity="0.85"/>';
  });
  state.shapes.arrows.forEach(a=>{ h += arrowSVG(a.from, a.to, SHAPE_COLORS[a.color], 0.8); });
  if(state.drawing && state.drawing.to && state.drawing.to !== state.drawing.from) h += arrowSVG(state.drawing.from, state.drawing.to, SHAPE_COLORS[state.drawing.color], 0.55);
  if(state.hint) h += arrowSVG(state.hint.uci.slice(0,2), state.hint.uci.slice(2,4), '#30d158', 0.9);
  layer.innerHTML = h;
}
function clearShapes(){
  const had = state.shapes.arrows.length || state.shapes.marks.length || state.hint || state.drawing;
  state.shapes.arrows = []; state.shapes.marks = []; state.hint = null; state.drawing = null;
  if(had) drawShapes();
}
function toggleShape(list, test, make){
  const i = list.findIndex(test);
  if(i >= 0) list.splice(i,1); else list.push(make);
}
function colorFromEvent(e){ return e.metaKey ? 'green' : e.ctrlKey ? 'red' : e.altKey ? 'yellow' : 'blue'; }
function squareAt(x, y){
  const el = document.elementFromPoint(x, y);
  const sq = el && el.closest ? el.closest('.sq') : null;
  return sq && boardEl.contains(sq) ? sq.dataset.square : null;
}
boardEl.addEventListener('contextmenu', e=>e.preventDefault());
boardEl.addEventListener('mousedown', (e)=>{
  if(e.button !== 2) return;
  e.preventDefault();
  const sq = squareAt(e.clientX, e.clientY); if(!sq) return;
  state.drawing = {from:sq, to:sq, color:colorFromEvent(e)};
});
document.addEventListener('mousemove', (e)=>{
  if(!state.drawing) return;
  const sq = squareAt(e.clientX, e.clientY);
  if(sq && sq !== state.drawing.to){ state.drawing.to = sq; drawShapes(); }
});
document.addEventListener('mouseup', (e)=>{
  if(e.button !== 2 || !state.drawing) return;
  const d = state.drawing; state.drawing = null;
  const sq = squareAt(e.clientX, e.clientY) || d.to;
  if(sq === d.from){
    const pm = state.premove;
    if(pm && (pm.from === sq || pm.to === sq)){ state.premove = null; renderBoard(); Sound.tap(); return; }   // right-click cancels a premove
    toggleShape(state.shapes.marks, m=>m.sq===sq, {sq:sq, color:d.color});
  } else {
    toggleShape(state.shapes.arrows, a=>a.from===d.from && a.to===sq, {from:d.from, to:sq, color:d.color});
  }
  drawShapes();
});
/* A left-click anywhere outside the board clears every arrow, mark and hint. */
document.addEventListener('mousedown', (e)=>{
  if(e.button === 0 && !boardEl.contains(e.target) && !(e.target.closest && e.target.closest('.promo-picker'))) clearShapes();
});

/* ---- Captured pieces & material ------------------------------------------ */
const START_COUNT = {p:8,n:2,b:2,r:2,q:1};
const PIECE_POINTS = {p:1,n:3,b:3,r:5,q:9};
function renderCaptured(vg){
  const cnt = {w:{p:0,n:0,b:0,r:0,q:0}, b:{p:0,n:0,b:0,r:0,q:0}};
  const b = vg.board();
  for(let r=0;r<8;r++) for(let c=0;c<8;c++){ const x = b[r][c]; if(x && cnt[x.color][x.type] != null) cnt[x.color][x.type]++; }
  const lost = {w:{}, b:{}}; const pts = {w:0, b:0};
  ['w','b'].forEach(col=>{
    Object.keys(START_COUNT).forEach(t=>{ lost[col][t] = Math.max(0, START_COUNT[t]-cnt[col][t]); pts[col] += cnt[col][t]*PIECE_POINTS[t]; });
  });
  const diff = pts.w - pts.b;                       // >0: White ahead
  const html = (loserColor, adv)=>{
    let out = '';
    ['q','r','b','n','p'].forEach(t=>{
      const n = lost[loserColor][t]; if(!n) return;
      out += '<span class="grp">'+Array(n+1).join('<img src="'+pieceSrc(t, loserColor, settings.pieceStyle)+'" alt="">')+'</span>';
    });
    if(adv > 0) out += '<span class="adv">+'+adv+'</span>';
    return out;
  };
  const humanSide = state.humanColor, botSide = other(humanSide);
  const humanAhead = humanSide==='w' ? diff : -diff;
  // Top card: what Cobra has captured (your lost pieces). Bottom: what you have captured.
  $('#cap-top').innerHTML = html(humanSide, humanAhead < 0 ? -humanAhead : 0);
  $('#cap-bottom').innerHTML = html(botSide, humanAhead > 0 ? humanAhead : 0);
}

/* ---------------------------------------------------------
   10. Interaction: click-to-move, drag-and-drop, premoves
   --------------------------------------------------------- */
function canPremove(){ return settings.premove && state.mode==='play' && botMode() && !state.gameOver && !isViewing(); }

function onSquareClick(e){
  const sq = e.currentTarget.dataset.square;
  if(state.gameOver || state.promoting) return;
  if(isViewing()) return;
  if(!humanToMove()){
    if(canPremove()) handlePremoveClick(sq);
    return;
  }
  if(state.premove) state.premove = null;
  const piece = game.get(sq);
  if(state.selected === sq){ state.selected=null; state.legalTargets=[]; renderBoard(); return; }
  if(state.selected && state.legalTargets.some(m=>m.to===sq)){ attemptMove(state.selected, sq); return; }
  if(piece && piece.color === movableColor()){
    state.selected = sq; state.legalTargets = game.moves({square:sq, verbose:true});
    Sound.tap();
    renderBoard();
  } else if(state.selected){
    state.selected=null; state.legalTargets=[]; Sound.invalid(); renderBoard(); flashIllegal(sq);
  }
}

function handlePremoveClick(sq){
  const piece = game.get(sq);
  if(!state.selected){
    if(piece && piece.color === state.humanColor){ state.selected = sq; renderBoard(); }
    return;
  }
  if(state.selected === sq){ state.selected=null; renderBoard(); return; }
  if(piece && piece.color === state.humanColor){ state.selected = sq; renderBoard(); return; }
  state.premove = {from: state.selected, to: sq};
  state.selected = null;
  Sound.premove(); renderBoard();
}

boardEl.addEventListener('dragstart', (e)=>{
  const pc = e.target.closest ? e.target.closest('.pc') : null; if(!pc) return;
  const sqEl = pc.closest('.sq'); if(!sqEl) return;
  const sq = sqEl.dataset.square;
  const piece = game.get(sq);
  const mine = movableColor();
  if(state.gameOver || state.promoting || isViewing() || !piece || piece.color !== mine ||
     (!humanToMove() && !canPremove())){
    e.preventDefault(); return;
  }
  e.dataTransfer.setData('text/plain', sq);
  e.dataTransfer.effectAllowed = 'move';
  state.selected = sq;
  state.legalTargets = humanToMove() ? game.moves({square:sq, verbose:true}) : [];
  setTimeout(renderBoard, 0);   // after the browser has captured the drag image
});
boardEl.addEventListener('dragover', (e)=>{ e.preventDefault(); if(e.dataTransfer) e.dataTransfer.dropEffect = 'move'; });
boardEl.addEventListener('drop', (e)=>{
  e.preventDefault();
  const from = e.dataTransfer.getData('text/plain');
  const sqEl = e.target.closest ? e.target.closest('.sq') : null;
  if(!sqEl || !from) return;
  const to = sqEl.dataset.square;
  if(from === to){ return; }
  if(humanToMove()) attemptMove(from, to);
  else if(canPremove()){ state.premove = {from:from, to:to}; state.selected=null; Sound.premove(); renderBoard(); }
});
boardEl.addEventListener('dragend', ()=>{
  if(state.promoting) return;
  if(!humanToMove()){ state.selected=null; state.legalTargets=[]; }
  renderBoard();
});

function flashIllegal(sq){
  const el = squareEl(sq); if(!el) return;
  el.classList.remove('is-illegal'); void el.offsetWidth; el.classList.add('is-illegal');
  setTimeout(()=>el.classList.remove('is-illegal'), 760);
}
async function attemptMove(from, to){
  const piece = game.get(from);
  let promotion;
  const willPromote = piece && piece.type==='p' && ((piece.color==='w' && to[1]==='8') || (piece.color==='b' && to[1]==='1'));
  const legal = game.moves({square:from, verbose:true}).some(m=>m.to===to);
  if(!legal){ state.selected=null; state.legalTargets=[]; Sound.invalid(); renderBoard(); flashIllegal(to); return; }
  if(willPromote){
    promotion = settings.autoQueen ? 'q' : await askPromotion(piece.color, to);
    if(!promotion){ state.selected=null; state.legalTargets=[]; renderBoard(); return; }
  }
  let move = null;
  try{ move = game.move({from:from, to:to, promotion:promotion}); }catch(err){ move = null; }
  if(!move){ Sound.invalid(); state.selected=null; state.legalTargets=[]; renderBoard(); flashIllegal(to); return; }
  onMoveMade(move);
}

function askPromotion(color, square){
  return new Promise(resolve=>{
    state.promoting = true;
    const shield = document.createElement('div'); shield.className = 'promo-shield';
    const wrap = document.createElement('div'); wrap.className = 'promo-picker';
    function finish(v){ state.promoting = false; shield.remove(); wrap.remove(); resolve(v); }
    ['q','r','b','n'].forEach(t=>{
      const b = document.createElement('button');
      b.setAttribute('aria-label', {q:'Queen',r:'Rook',b:'Bishop',n:'Knight'}[t]);
      b.innerHTML = pieceMarkup(t, color, settings.pieceStyle);
      b.addEventListener('click', (ev)=>{ ev.stopPropagation(); finish(t); });
      wrap.appendChild(b);
    });
    shield.addEventListener('click', ()=>finish(null));
    const rect = squareEl(square).getBoundingClientRect();
    const down = rect.top < window.innerHeight/2;
    wrap.style.left = Math.round(rect.left)+'px';
    wrap.style.top = Math.round(down ? rect.top : rect.bottom - 4*64)+'px';
    document.body.appendChild(shield); document.body.appendChild(wrap);
  });
}

/* ---------------------------------------------------------
   11. Consequences of a move
   --------------------------------------------------------- */
function playMoveSound(move, byHuman){
  if(game.inCheck()){ Sound.check(); return; }
  if(move.promotion){ Sound.promote(); return; }
  if(move.flags.indexOf('k') >= 0 || move.flags.indexOf('q') >= 0){ Sound.castle(); return; }
  if(move.captured){ Sound.capture(); return; }
  if(byHuman) Sound.moveSelf(); else Sound.moveOpponent();
}

function onMoveMade(move){
  stopAutoplay(); clearShapes();
  state.viewPly = null; state.selected = null; state.legalTargets = []; state.review = null;
  hideReviewResults();
  const plies = game.history().length;
  if(state.mode==='play' && !state.untimed && plies > 1) state.clocks[move.color] += state.incrementSec*1000;
  const byHuman = state.mode==='analysis' || !botMode() || move.color === state.humanColor;
  const over = game.isGameOver();
  if(!over) playMoveSound(move, byHuman);
  renderBoard(); updateMoveList(); renderClocks(); refreshControls(); updateTransportState();
  syncStringBoxes();
  if(over){ handleGameOver(); return; }
  updateEvalBar();
  if(state.mode==='play' && !humanToMove() && botMode()){
    triggerBotMove();
  } else if(state.premove && humanToMove()){
    playPremove();
  }
}

function playPremove(){
  const pm = state.premove; state.premove = null;
  if(!pm) return;
  const legal = game.moves({verbose:true}).find(m=>m.from===pm.from && m.to===pm.to);
  if(!legal){ renderBoard(); notify('Premove cancelled — it is no longer legal.'); return; }
  setTimeout(()=>{
    if(state.gameOver || !humanToMove()) return;
    let move = null;
    try{ move = game.move({from:pm.from, to:pm.to, promotion: legal.promotion ? 'q' : undefined}); }catch(e){}
    if(move) onMoveMade(move);
  }, 60);
}

/* ---------------------------------------------------------
   12. The bot
   --------------------------------------------------------- */
function botBudget(){
  const L = state.skillLevel;
  let ms = Math.round(150 + Math.pow((L-1)/(MAX_LEVEL-1), 1.5)*4200);
  if(!state.untimed){
    const rem = state.clocks[other(state.humanColor)];
    ms = Math.min(ms, Math.max(60, rem*0.04 + state.incrementSec*400));
  }
  return L <= 4 ? {depth: 2+L, movetime: ms} : {movetime: ms};
}

let thinkLoopTimer = null;
function setThinking(on){
  state.thinking = on;
  clearTimeout(thinkLoopTimer);
  if(on){ thinkLoopTimer = setTimeout(()=>{ if(state.thinking && !state.reviewing) Sound.loopStart(); }, 450); }
  else if(!state.reviewing){ Sound.loopStop(); }
  const dot = $('#bot-status');
  if(!dot) return;
  dot.hidden = !on; dot.textContent = on ? 'thinking…' : '';
}

async function triggerBotMove(){
  if(state.gameOver || state.mode!=='play') return;
  const token = ++state.botToken;
  setThinking(true);
  if(engineBooting && engineInitPromise) await engineInitPromise;
  if(token !== state.botToken || state.gameOver){ setThinking(false); return; }
  if(!engine.available){ setThinking(false); refreshControls(); renderClocks(); return; }
  const t0 = performance.now();
  const res = await engine.go(game.fen(), botBudget());
  const wait = 420 - (performance.now()-t0);
  if(wait > 0) await sleep(wait);
  if(token !== state.botToken || state.gameOver){ setThinking(false); return; }
  setThinking(false);
  if(!res.bestmove){ refreshControls(); return; }
  const uci = res.bestmove;
  let move = null;
  try{ move = game.move({from:uci.slice(0,2), to:uci.slice(2,4), promotion: uci.length>4 ? uci[4] : undefined}); }catch(e){}
  if(move) onMoveMade(move);
}

/* ---------------------------------------------------------
   13. Evaluation bar
   --------------------------------------------------------- */
function winPct(cp){ return 50 + 50*(2/(1+Math.exp(-0.00368208*cp)) - 1); }

function renderEval(ev){
  if(!ev) return;
  state.evalCp = ev.cp;
  const fill = $('#eval-fill'), readout = $('#eval-readout');
  let pct = winPct(ev.cp), label;
  if(ev.mate != null){
    label = (ev.mate>0 ? '+M' : '-M') + Math.abs(ev.mate);
    pct = ev.mate>0 ? 100 : 0;
  } else if(Math.abs(ev.cp) >= 2900){
    label = ev.cp>0 ? '1-0' : '0-1'; pct = ev.cp>0 ? 100 : 0;
  } else {
    label = (ev.cp>=0 ? '+' : '') + (ev.cp/100).toFixed(1);
  }
  fill.style.height = pct + '%';
  readout.textContent = label;
  readout.classList.toggle('on-white', pct > 50);
}

function viewFen(){
  const n = currentPly(), hist = game.history({verbose:true});
  if(n >= hist.length) return game.fen();
  return n === 0 ? hist[0].before : hist[n-1].after;
}
async function updateEvalBar(){
  if(state.reviewing) return;
  const seq = ++state.evalSeq;
  const live = state.mode === 'analysis';
  const fen = live ? viewFen() : game.fen();
  const g = new Chess(fen);
  if(live){ state.hint = null; drawShapes(); }
  if(g.isCheckmate()){ renderEval({cp: g.turn()==='w' ? -3000 : 3000, mate:null}); renderLiveLines(null, fen); return; }
  if(g.isGameOver()){ renderEval({cp:0, mate:null}); renderLiveLines(null, fen); return; }
  if(engineBooting && engineInitPromise) await engineInitPromise;
  if(!reviewEngine.available || seq !== state.evalSeq || state.reviewing) return;
  if(live){ const q = reviewEngine.queue.splice(0); q.forEach(j=>j.resolve(NO_RESULT)); reviewEngine.stop(); }
  reviewEngine.setOption('MultiPV', live ? 3 : 1);
  const res = await reviewEngine.go(fen, {movetime: live ? (reviewEngine.kind === 'js' ? 1500 : 900) : (reviewEngine.kind === 'js' ? 400 : 250)});
  if(seq !== state.evalSeq || state.reviewing) return;
  renderEval(infoToEval(res.info, fen.split(' ')[1]));
  if(live){
    renderLiveLines(res, fen);
    if(res.bestmove && !state.review && !state.shapes.arrows.length){ state.hint = {uci:res.bestmove}; drawShapes(); }
  }
}
function renderLiveLines(res, fen){
  const box = $('#live-lines'); if(!box) return;
  if(!res || !res.lines){ box.innerHTML = '<div class="ll-empty">'+(res===null ? 'Game over in this position.' : 'Thinking…')+'</div>'; return; }
  const turn = fen.split(' ')[1]; let html = ''; const seen = {};
  [1,2,3].forEach(i=>{
    const info = res.lines[i]; if(!info || !info.pv.length || seen[info.pv[0]]) return; seen[info.pv[0]] = 1;
    const ev = infoToEval(info, turn);
    const sans = pvToSan(fen, info.pv, 6);
    html += '<div class="ll-row'+(i===1?' best':'')+'"><span class="ll-ev">'+fmtEval(ev)+'</span><span class="ll-pv"><b>'+escapeHTML(sans[0]||'')+'</b> '+escapeHTML(sans.slice(1).join(' '))+'</span><span class="ll-d">d'+(info.depth||'')+'</span></div>';
  });
  box.innerHTML = html || '<div class="ll-empty">No engine lines.</div>';
}

function renderEvalForView(){
  if(!state.review) return;
  const i = Math.min(currentPly(), state.review.evals.length-1);
  renderEval(state.review.evals[i]);
}

/* ---------------------------------------------------------
   14. Clocks
   --------------------------------------------------------- */
const clockTopEl = $('#clock-top'), clockBottomEl = $('#clock-bottom');

function fmtClock(ms){
  ms = Math.max(0, ms);
  const total = ms/1000;
  const m = Math.floor(total/60), s = Math.floor(total%60);
  if(total < 20) return m+':'+String(s).padStart(2,'0')+'.'+Math.floor((ms%1000)/100);
  return m+':'+String(s).padStart(2,'0');
}

function renderClocks(){
  const topColor = other(state.humanColor), bottomColor = state.humanColor;
  const timed = state.mode==='play' && !state.untimed;
  clockTopEl.textContent = timed ? fmtClock(state.clocks[topColor]) : '∞';
  clockBottomEl.textContent = timed ? fmtClock(state.clocks[bottomColor]) : '∞';
  [clockTopEl, clockBottomEl].forEach(el=>el.classList.remove('is-active','is-low'));
  if(state.gameOver) return;
  const active = game.turn();
  const el = active === topColor ? clockTopEl : clockBottomEl;
  el.classList.add('is-active');
  if(timed && state.clocks[active] < 10000) el.classList.add('is-low');
}

function stopClock(){ if(state.clockTimer){ clearInterval(state.clockTimer); state.clockTimer = null; } }

function startClock(){
  stopClock();
  state.lowFlags = {quarter:false, ten:false};
  renderClocks();
  if(state.mode !== 'play' || state.untimed) return;
  state.lastTick = performance.now();
  state.clockTimer = setInterval(tick, 100);
}

function tick(){
  const now = performance.now(); const dt = now - state.lastTick; state.lastTick = now;
  if(state.gameOver) return;
  if(game.history().length < 1){ renderClocks(); return; }      // the clock starts after the first move
  const c = game.turn();
  state.clocks[c] -= dt;
  if(state.clocks[c] <= 0){
    state.clocks[c] = 0; renderClocks(); handleFlag(c); return;
  }
  if(c === state.humanColor){
    const ms = state.clocks[c];
    if(!state.lowFlags.quarter && state.initialMs >= 40000 && ms <= state.initialMs/4 && ms > 10000){ state.lowFlags.quarter = true; Sound.tenSeconds(); }
    if(!state.lowFlags.ten && ms <= 10000){ state.lowFlags.ten = true; Sound.tenSeconds(); }
  }
  renderClocks();
}

function hasMatingMaterial(color){
  const b = game.board(); let minors = 0;
  for(let r=0;r<8;r++) for(let c=0;c<8;c++){
    const p = b[r][c]; if(!p || p.color !== color) continue;
    if(p.type==='p' || p.type==='r' || p.type==='q') return true;
    if(p.type==='n' || p.type==='b') minors++;
  }
  return minors >= 2;
}
function handleFlag(color){
  const winner = other(color);
  const can = hasMatingMaterial(winner);
  finishGame(can ? winner : null, can ? 'flag' : 'flag-draw');
}

/* ---------------------------------------------------------
   15. Game over, results, stats and saved games
   --------------------------------------------------------- */
function handleGameOver(){
  let winner = null, reason = 'fifty';
  if(game.isCheckmate()){ winner = other(game.turn()); reason = 'checkmate'; }
  else if(game.isStalemate()) reason = 'stalemate';
  else if(game.isThreefoldRepetition()) reason = 'repetition';
  else if(game.isInsufficientMaterial()) reason = 'material';
  finishGame(winner, reason);
}

const REASON_TEXT = {
  checkmate:'Checkmate', stalemate:'Stalemate', repetition:'Threefold repetition',
  material:'Insufficient material', fifty:'Fifty-move rule', resignation:'Resignation',
  flag:'Won on time', 'flag-draw':'Out of time vs insufficient material', agreement:'Draw agreed'
};

function ensureHeaders(){
  if(state.mode !== 'play') return;
  const today = new Date(); const pad = n=>String(n).padStart(2,'0');
  const you = $('#user-name').textContent.trim() || 'You';
  const white = state.humanColor==='w' ? you : botName();
  const black = state.humanColor==='b' ? you : botName();
  const tc = state.untimed ? '-' : Math.round(state.initialMs/1000)+'+'+state.incrementSec;
  const set = (k,v)=>{ try{ game.setHeader(k, v); }catch(e){} };
  set('Event','Cobra game'); set('Site','Cobra (offline)');
  set('Date', today.getFullYear()+'.'+pad(today.getMonth()+1)+'.'+pad(today.getDate()));
  set('White', white); set('Black', black); set('TimeControl', tc);
  if(!state.result) set('Result','*');
}

function finishGame(winner, reason){
  if(state.gameOver) return;
  state.gameOver = true;
  stopClock(); stopAutoplay(); setThinking(false);
  state.botToken++; engine.stop();
  state.premove = null; state.selected = null; state.legalTargets = [];
  const result = winner==='w' ? '1-0' : winner==='b' ? '0-1' : '1/2-1/2';
  state.result = {winner:winner, reason:reason, result:result};
  try{ game.setHeader('Result', result); }catch(e){}
  const plies = game.history().length;
  const vsBot = state.mode==='play' && engine.available;
  let headline, kind;
  if(winner === null){ headline = 'Draw'; kind = 'draw'; }
  else if(!vsBot){ headline = winner==='w' ? 'White wins' : 'Black wins'; kind = 'draw'; }
  else if(winner === state.humanColor){ headline = 'You win'; kind = 'win'; }
  else { headline = botName() + ' wins'; kind = 'lose'; }
  if(vsBot && plies >= 2){
    const botElo = levelElo(state.skillLevel);
    const score = winner===null ? 0.5 : (winner===state.humanColor ? 1 : 0);
    const expected = 1/(1+Math.pow(10,(botElo - stats.rating)/400));
    if(!state.assisted) stats.rating = Math.max(100, Math.round(stats.rating + 24*(score-expected)));
    if(score===1) stats.wins++; else if(score===0) stats.losses++; else stats.draws++;
    persistStats(); renderStats();
  }
  if(state.mode==='play' && plies >= 2) saveCurrentGame(result);
  Sound.gameEnd(kind);
  renderBoard(); renderClocks(); updateMoveList(); refreshControls(); syncStringBoxes();
  updateEvalBar();
  if(state.mode==='play') showResult(headline, (REASON_TEXT[reason] || 'Game over') + (state.assisted && vsBot ? ' · rating unchanged (hint or takeback used)' : ''));
  else notify((REASON_TEXT[reason] || 'Game over')+' — '+headline);
}

function showResult(headline, sub){
  $('#result-head').textContent = headline;
  $('#result-sub').textContent = sub;
  $('#board-toast').hidden = false;
  const first = $('#result-rematch'); if(first) first.focus({preventScroll:true});
}
function hideResult(){ $('#board-toast').hidden = true; }

function saveCurrentGame(result){
  ensureHeaders();
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    pgn: game.pgn(), result:result,
    level: state.skillLevel, human: state.humanColor,
    plies: game.history().length, date: Date.now(),
    reason: state.result ? state.result.reason : ''
  };
  savedGames.unshift(entry);
  if(savedGames.length > 50) savedGames.length = 50;
  persistGames(); renderGamesList();
}

function renderStats(){
  $('#stat-wins').textContent = stats.wins;
  $('#stat-losses').textContent = stats.losses;
  $('#stat-draws').textContent = stats.draws;
  $('#user-elo').textContent = 'Rating ' + stats.rating;
}

/* ---------------------------------------------------------
   16. Move list (shared by Moves tab and Review)
   --------------------------------------------------------- */
const CLS = {
  brilliant:{label:'Brilliant move', glyph:'!!', phrase:'a brilliant move'},
  great:{label:'Great', glyph:'!', phrase:'a great move'},
  best:{label:'Best', glyph:'★', phrase:'the best move'},
  excellent:{label:'Excellent', glyph:'✓', phrase:'an excellent move'},
  good:{label:'Good', glyph:'•', phrase:'a good move'},
  book:{label:'Book', glyph:'B', phrase:'a book move'},
  inaccuracy:{label:'Inaccuracy', glyph:'?!', phrase:'an inaccuracy'},
  mistake:{label:'Mistake', glyph:'?', phrase:'a mistake'},
  blunder:{label:'Blunder', glyph:'??', phrase:'a blunder'}
};
function clsImg(cls){ return '<img src="icons/'+cls+'.png" alt="" draggable="false">'; }
const CLS_ORDER = ['brilliant','great','best','excellent','good','book','inaccuracy','mistake','blunder'];

function buildMoveRows(container, withBadges){
  container.innerHTML = '';
  const hist = game.history({verbose:true});
  if(!hist.length) return;
  const cells = hist.map((m,i)=>({ply:i+1, san:m.san, color:m.color}));
  let moveNo = parseInt(hist[0].before.split(' ')[5], 10) || 1;
  const frag = document.createDocumentFragment();
  const cell = (c)=>{
    if(!c) return '<span class="mv empty"></span>';
    let badge = '';
    if(withBadges && state.review && state.review.rows[c.ply-1]){
      const cls = state.review.rows[c.ply-1].cls;
      badge = '<span class="badge-dot b-'+cls+'" title="'+CLS[cls].label+'">'+clsImg(cls)+'</span>';
    }
    return '<span class="mv" data-ply="'+c.ply+'">'+badge+escapeHTML(c.san)+'</span>';
  };
  let idx = 0;
  const addRow = (n, w, b)=>{
    const li = document.createElement('li');
    li.innerHTML = '<span class="mv-num">'+n+'.</span>'+cell(w)+cell(b);
    frag.appendChild(li);
  };
  if(cells[0].color === 'b'){ addRow(moveNo, null, cells[0]); idx = 1; moveNo++; }
  while(idx < cells.length){ addRow(moveNo, cells[idx], cells[idx+1]); idx += 2; moveNo++; }
  container.appendChild(frag);
}

function highlightCurrentMove(){
  const ply = currentPly();
  $$('.move-list .mv[data-ply]').forEach(el=>{
    const on = parseInt(el.dataset.ply,10) === ply;
    el.classList.toggle('is-current', on);
    if(on){ const li = el.closest('li'); if(li && li.scrollIntoView) li.scrollIntoView({block:'nearest'}); }
  });
}

function updateMoveList(){
  buildMoveRows($('#move-list'), true);
  $('#move-list-empty').hidden = game.history().length > 0;
  if(state.review) buildMoveRows($('#review-list'), true); else $('#review-list').innerHTML = '';
  highlightCurrentMove();
}

document.addEventListener('click', (e)=>{
  const mv = e.target.closest ? e.target.closest('.move-list .mv[data-ply]') : null;
  if(!mv) return;
  stopAutoplay();
  goToPly(parseInt(mv.dataset.ply,10));
});

/* ---------------------------------------------------------
   17. Move navigation & replay
   --------------------------------------------------------- */
function goToPly(n, quiet){
  const len = game.history().length;
  n = clamp(n, 0, len);
  state.viewPly = n >= len ? null : n;
  state.selected = null; state.legalTargets = [];
  renderBoard(); highlightCurrentMove(); updateTransportState(); updateReviewDetail(); renderEvalForView(); renderEvalGraph();
  if(state.mode==='analysis' && !state.reviewing) updateEvalBar();
  if(!quiet && n > 0){
    const m = game.history({verbose:true})[n-1];
    const g2 = new Chess(m.after);
    if(g2.inCheck()) Sound.check();
    else if(m.promotion) Sound.promote();
    else if(m.flags.indexOf('k') >= 0 || m.flags.indexOf('q') >= 0) Sound.castle();
    else if(m.captured) Sound.capture();
    else Sound.moveSelf();
  }
}
function stepPly(d){ stopAutoplay(); goToPly(currentPly()+d); }

function stopAutoplay(){
  if(state.autoplayTimer){ clearInterval(state.autoplayTimer); state.autoplayTimer = null; }
  setHidden($('#ico-play'), false); setHidden($('#ico-pause'), true);
}
function toggleAutoplay(){
  if(state.autoplayTimer){ stopAutoplay(); return; }
  const len = game.history().length;
  if(!len){ notify('No moves to replay yet.'); return; }
  if(currentPly() >= len) goToPly(0, true);
  setHidden($('#ico-play'), true); setHidden($('#ico-pause'), false);
  state.autoplayTimer = setInterval(()=>{
    if(currentPly() >= game.history().length){ stopAutoplay(); return; }
    goToPly(currentPly()+1);
    if(currentPly() >= game.history().length) stopAutoplay();
  }, 900);
}

function updateTransportState(){
  const len = game.history().length, p = currentPly();
  $('#nav-first').disabled = p <= 0; $('#nav-prev').disabled = p <= 0;
  $('#nav-next').disabled = p >= len; $('#nav-last').disabled = p >= len;
  $('#nav-play').disabled = len === 0;
}

document.addEventListener('keydown', (e)=>{
  const t = e.target;
  if(t && (t.tagName==='INPUT' || t.tagName==='TEXTAREA' || t.tagName==='SELECT' || t.isContentEditable)) return;
  if(e.metaKey || e.ctrlKey || e.altKey) return;
  if(!$('#dialog-backdrop').hidden || !$('#settings-backdrop').hidden) return;
  if(e.key === 'ArrowLeft'){ e.preventDefault(); stepPly(-1); }
  else if(e.key === 'ArrowRight'){ e.preventDefault(); stepPly(1); }
  else if(e.key === 'Home'){ e.preventDefault(); stopAutoplay(); goToPly(0); }
  else if(e.key === 'End'){ e.preventDefault(); stopAutoplay(); goToPly(game.history().length); }
});

document.addEventListener('keydown', (e)=>{
  if(e.key !== 'Escape' || !$('#dialog-backdrop').hidden || !$('#settings-backdrop').hidden) return;
  if(state.premove || state.selected){ state.premove = null; state.selected = null; state.legalTargets = []; renderBoard(); }
});


/* ---------------------------------------------------------
   Review extras: evaluation graph, key moments, shortcuts
   --------------------------------------------------------- */
const KEY_CLS = {brilliant:1, great:1, mistake:1, blunder:1};
function evalWhiteWin(ev){
  if(!ev) return 50;
  if(ev.mate != null) return ev.mate > 0 ? 100 : 0;
  return winPct(ev.cp);
}
function renderEvalGraph(){
  const r = state.review, svg = $('#eval-graph'), card = $('#graph-card');
  if(!r || !r.evals || r.evals.length < 2){ card.hidden = true; return; }
  const n = r.evals.length - 1, W = 300, H = 80;
  const x = i => n ? i/n*W : 0, y = i => H - evalWhiteWin(r.evals[i])/100*H;
  let d = 'M0 '+H;
  for(let i=0;i<=n;i++) d += ' L'+x(i).toFixed(1)+' '+y(i).toFixed(1);
  d += ' L'+W+' '+H+' Z';
  const cur = currentPly();
  svg.innerHTML = '<path class="eg-white" d="'+d+'"/><line class="eg-mid" x1="0" x2="'+W+'" y1="'+H/2+'" y2="'+H/2+'"/>'+
    '<line class="eg-cur" x1="'+x(cur)+'" x2="'+x(cur)+'" y1="0" y2="'+H+'"/>';
  card.hidden = false;
  const idx = keyMoments();
  $('#key-prev').disabled = !idx.some(p=>p < cur);
  $('#key-next').disabled = !idx.some(p=>p > cur);
}
function keyMoments(){
  return state.review ? state.review.rows.filter(r=>KEY_CLS[r.cls]).map(r=>r.ply) : [];
}
function jumpKey(dir){
  const cur = currentPly(), list = keyMoments();
  const t = dir > 0 ? list.find(p=>p > cur) : list.slice().reverse().find(p=>p < cur);
  if(t == null){ notify(dir > 0 ? 'No later key moments.' : 'No earlier key moments.'); return; }
  stopAutoplay(); goToPly(t);
}
$('#eval-graph').addEventListener('click', e=>{
  if(!state.review) return;
  const rc = e.currentTarget.getBoundingClientRect(), n = state.review.evals.length - 1;
  stopAutoplay(); goToPly(Math.round((e.clientX - rc.left)/rc.width*n));
});
$('#key-prev').addEventListener('click', ()=>jumpKey(-1));
$('#key-next').addEventListener('click', ()=>jumpKey(1));

function showShortcuts(){
  const rows = [['← →','Step through moves'],['Home / End','First / latest move'],['F','Flip board'],['H','Hint'],['U','Take back'],['[ ]','Previous / next key moment'],['Esc','Cancel premove or selection'],['Right-click drag','Draw arrow (⌘ green, Ctrl red, Alt yellow)'],['?','This list']];
  const body = $('#dialog-body'); 
  dialog({title:'Keyboard shortcuts', body:'', actions:[{label:'Close', value:true, kind:'btn-primary'}]});
  body.innerHTML = '<dl class="shortcut-list">'+rows.map(r=>'<dt><kbd>'+escapeHTML(r[0])+'</kbd></dt><dd style="margin:0">'+escapeHTML(r[1])+'</dd>').join('')+'</dl>';
}
$('#btn-keys').addEventListener('click', showShortcuts);
document.addEventListener('keydown', (e)=>{
  const t = e.target;
  if(t && (t.tagName==='INPUT' || t.tagName==='TEXTAREA' || t.tagName==='SELECT' || t.isContentEditable)) return;
  if(e.metaKey || e.ctrlKey || e.altKey) return;
  if(!$('#dialog-backdrop').hidden || !$('#settings-backdrop').hidden) return;
  const k = e.key;
  if(k === '?'){ e.preventDefault(); showShortcuts(); }
  else if(k === 'f' || k === 'F'){ e.preventDefault(); $('#btn-flip').click(); }
  else if(k === 'h' || k === 'H'){ if(!$('#btn-hint').disabled){ e.preventDefault(); doHint(); } }
  else if(k === 'u' || k === 'U'){ if(!$('#btn-takeback').disabled){ e.preventDefault(); doTakeback(); } }
  else if(k === '['){ e.preventDefault(); jumpKey(-1); }
  else if(k === ']'){ e.preventDefault(); jumpKey(1); }
});

/* ---------------------------------------------------------
   18. New game & time controls
   --------------------------------------------------------- */
function readTimeControl(){
  const preset = $('#time-preset').value;
  if(preset==='bullet') return {minutes:1, inc:0};
  if(preset==='blitz')  return {minutes:3, inc:2};
  if(preset==='rapid')  return {minutes:10, inc:0};
  if(preset==='untimed') return {untimed:true, minutes:0, inc:0};
  const m = clamp(parseFloat($('#custom-minutes').value)||5, 0.5, 180);
  const i = clamp(parseFloat($('#custom-increment').value)||0, 0, 60);
  return {minutes:m, inc:i};
}
function selectedSide(){
  const b = $('#side-select .seg-btn.is-active'); return b ? b.dataset.side : 'w';
}

function newGame(opts){
  opts = opts || {};
  stopAutoplay(); stopClock(); setThinking(false);
  state.botToken++; engine.stop();
  state.evalSeq++;
  if(opts.fen){ game.load(opts.fen); } else { game.reset(); }
  state.mode = 'play';
  const tc = readTimeControl();
  state.untimed = !!tc.untimed;
  state.initialMs = Math.round((tc.minutes||0)*60000);
  state.incrementSec = tc.inc;
  state.clocks = {w: state.initialMs, b: state.initialMs};
  state.selected = null; state.legalTargets = []; state.premove = null; state.promoting = false;
  state.gameOver = false; state.result = null; state.viewPly = null; state.review = null;
  state.takebacksLeft = 3; state.hintsLeft = 3; state.assisted = false; clearShapes();
  const side = selectedSide();
  state.humanColor = side==='random' ? (Math.random()<0.5 ? 'w' : 'b') : side;
  state.flipped = state.humanColor === 'b';
  settings.level = state.skillLevel; settings.timePreset = $('#time-preset').value;
  settings.customMinutes = parseFloat($('#custom-minutes').value)||5;
  settings.customIncrement = parseFloat($('#custom-increment').value)||0;
  settings.side = side; persistSettings();
  engine.newGame(); applySkillLevel(state.skillLevel);
  buildBoardDOM(); renderBoard(); updateMoveList(); hideResult(); hideReviewResults();
  startClock(); renderEval({cp:0, mate:null}); syncStringBoxes();
  refreshControls(); updateTransportState(); updateBotCard();
  if(!opts.silent) Sound.gameStart();
  updateEvalBar();
  if(!humanToMove() && botMode()) setTimeout(triggerBotMove, 300);
}

function updateBotCard(){
  const L = state.skillLevel;
  $('#bot-name').textContent = state.mode==='analysis' ? 'Analysis board' : 'Cobra';
  $('#bot-elo').textContent = state.mode==='analysis' ? 'Both sides' : 'Level '+L+' · ~'+levelElo(L);
  $('#card-slider-wrap').hidden = state.mode==='analysis';
  const lv = $('#level-out'); if(lv) lv.textContent = L;
  const eo = $('#elo-out'); if(eo) eo.textContent = '~'+levelElo(L);
  const to = $('#tier-out'); if(to) to.textContent = levelTier(L);
  $('#skill-level').value = L; $('#card-level').value = L;
  const tb = $('#toggle-botoff'); if(tb) tb.checked = state.mode==='analysis';
  const lc = $('#live-card'); if(lc) lc.hidden = state.mode!=='analysis';
}

function refreshControls(){
  const playing = state.mode==='play' && !state.gameOver;
  const hist = game.history({verbose:true});
  const lastByBot = hist.length > 0 && botMode() && hist[hist.length-1].color !== state.humanColor;
  $('#btn-resign').disabled = !playing || hist.length < 1;
  $('#btn-draw').disabled = !playing || hist.length < 2;
  $('#btn-takeback').disabled = !playing || !botMode() || state.takebacksLeft <= 0 || !hist.length || (lastByBot && hist.length < 2);
  $('#btn-hint').disabled = !playing || !engine.available || !humanToMove() || state.hintsLeft <= 0;
  $('#takeback-left').textContent = state.takebacksLeft;
  $('#hint-left').textContent = state.hintsLeft;
  $('#btn-run-review').textContent = state.reviewing ? 'Cancel' : 'Analyse';
}

/* Takeback and hint (limited per game; using either leaves the rating unchanged). */
function doTakeback(){
  if(state.mode!=='play' || state.gameOver || !botMode()) return;
  if(state.takebacksLeft <= 0){ notify('No takebacks left this game.'); return; }
  const hist = game.history({verbose:true});
  if(!hist.length) return;
  const lastByBot = hist[hist.length-1].color !== state.humanColor;
  const n = lastByBot ? 2 : 1;
  if(hist.length < n){ notify('Nothing to take back yet.'); return; }
  state.botToken++; engine.stop(); setThinking(false);
  for(let i=0;i<n;i++) game.undo();
  state.takebacksLeft--; state.assisted = true;
  state.premove = null; state.review = null; state.viewPly = null; state.selected = null; state.legalTargets = [];
  clearShapes(); hideReviewResults();
  renderBoard(); updateMoveList(); renderClocks(); refreshControls(); updateTransportState(); syncStringBoxes(); updateEvalBar();
  Sound.swipe();
  if(!humanToMove() && botMode()) triggerBotMove();
}
async function doHint(){
  if(state.mode!=='play' || state.gameOver || !engine.available || !humanToMove()) return;
  if(state.hintsLeft <= 0){ notify('No hints left this game.'); return; }
  state.hintsLeft--; state.assisted = true; refreshControls();
  const mt = reviewEngine.kind === 'js' ? 900 : 500;
  for(let attempt=0; attempt<3; attempt++){
    const fen = game.fen();
    const res = await reviewEngine.go(fen, {movetime: mt});
    if(state.mode!=='play' || state.gameOver) return;
    if(game.fen() !== fen){ if(!humanToMove()) break; continue; }
    if(res && res.bestmove){
      state.hint = {uci:res.bestmove}; drawShapes();
      notify('Cobra suggests '+uciToSan(fen, res.bestmove)+'.');
      return;
    }
  }
  if(state.mode==='play' && !state.gameOver){ state.hintsLeft++; refreshControls(); notify('No hint available — try again.'); }
}
$('#btn-takeback').addEventListener('click', doTakeback);
$('#btn-hint').addEventListener('click', ()=>{ doHint(); });

/* ---------------------------------------------------------
   19. FEN / PGN, upload, download, share, saved games
   --------------------------------------------------------- */
function syncStringBoxes(){
  const fen = $('#fen-box'), pgn = $('#pgn-box');
  if(document.activeElement !== fen) fen.value = game.fen();
  if(document.activeElement !== pgn){
    if(state.mode==='play') ensureHeaders();
    pgn.value = game.history().length ? game.pgn() : '';
  }
}
const FEN_RE = /^\s*([rnbqkpRNBQKP1-8]+\/){7}[rnbqkpRNBQKP1-8]+\s+[wb]\s+/;

async function loadFenText(fen){
  fen = fen.trim().replace(/\s+/g,' ');
  let test;
  try{ test = new Chess(fen); }catch(e){ test = null; }
  if(!test){ notify('That FEN could not be read.', 'warn'); return; }
  const choice = await dialog({
    title:'Load position',
    body:'FEN contains a position, not a game. You can play this position against the bot; use PGN to analyse a game.',
    actions:[
      {label:'Cancel', value:null, kind:'btn-ghost'},
      {label:'Play vs bot', value:'play', kind:'btn-primary'}
    ]
  });
  if(!choice) return;
  openPanel('play'); newGame({fen:fen}); notify('Position loaded — good luck.');
}

function enterAnalysis(loader, keepView){
  stopAutoplay(); stopClock(); setThinking(false);
  state.botToken++; engine.stop(); state.evalSeq++;
  loader();
  state.mode = 'analysis'; state.untimed = true;
  state.humanColor = 'w'; state.flipped = false;
  state.selected = null; state.legalTargets = []; state.premove = null; state.promoting = false;
  state.review = null; state.result = null; state.viewPly = null; clearShapes();
  state.gameOver = game.isGameOver();
  hideResult(); hideReviewResults();
  buildBoardDOM(); renderBoard(); updateMoveList(); renderClocks();
  refreshControls(); updateTransportState(); updateBotCard(); syncStringBoxes();
  renderEval({cp:0, mate:null}); updateEvalBar();
  if(game.history().length && !keepView) goToPly(0, true);
  Sound.swipe();
}

function loadPgnText(text, opts){
  opts = opts || {};
  const pgn = text.trim().split(/\n\s*\n(?=\[Event )/)[0];
  const probe = new Chess();
  try{ probe.loadPgn(pgn); }catch(e){ notify('That PGN could not be read.', 'warn'); return false; }
  enterAnalysis(()=>game.loadPgn(pgn));
  const n = game.history().length;
  notify(n ? 'Game loaded — '+n+' moves. Use ← → to step through.' : 'PGN loaded (no moves).');
  if(opts.openReview){ openPanel('review'); }
  else { activateTab('history'); }
  return true;
}

function loadAnyText(text){
  if(FEN_RE.test(text) && !/\[Event|\n\s*1\./.test(text)) return loadFenText(text);
  return loadPgnText(text);
}

function exportPGN(){
  if(!game.history().length){ notify('Nothing to export yet — play a few moves.'); return null; }
  if(state.mode==='play') ensureHeaders();
  return game.pgn();
}
function stamp(){ const d = new Date(); const p = n=>String(n).padStart(2,'0'); return ''+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes()); }

$('#fen-copy').addEventListener('click', async ()=>{ const ok = await copyText(game.fen()); notify(ok ? 'FEN copied.' : 'Could not copy — select the text and copy manually.', ok?'':'warn'); Sound.tap(); });
$('#fen-share').addEventListener('click', ()=>shareText('Chess position (FEN)', game.fen()));
$('#fen-download').addEventListener('click', ()=>{ downloadText('cobra-position-'+stamp()+'.fen', game.fen()+'\n'); Sound.tap(); });
$('#btn-load-fen').addEventListener('click', ()=>{ const v = $('#fen-box').value.trim(); if(!v){ notify('Paste a FEN first.'); return; } loadFenText(v); });

$('#pgn-copy').addEventListener('click', async ()=>{ const p = exportPGN(); if(!p) return; const ok = await copyText(p); notify(ok ? 'PGN copied.' : 'Could not copy — select the text and copy manually.', ok?'':'warn'); Sound.tap(); });
$('#pgn-share').addEventListener('click', ()=>{ const p = exportPGN(); if(p) shareText('Chess game (PGN)', p); });
$('#pgn-download').addEventListener('click', ()=>{ const p = exportPGN(); if(!p) return; downloadText('cobra-game-'+stamp()+'.pgn', p+'\n', 'application/x-chess-pgn'); Sound.tap(); });
$('#btn-load-pgn').addEventListener('click', ()=>{ const v = $('#pgn-box').value.trim(); if(!v){ notify('Paste a PGN first.'); return; } loadAnyText(v); });
$('#pgn-upload').addEventListener('click', ()=>$('#file-input').click());
$('#file-input').addEventListener('change', (e)=>{
  const f = e.target.files && e.target.files[0]; if(!f) return;
  if(f.size > 2*1024*1024){ notify('That file is too large (2 MB max).', 'warn'); e.target.value=''; return; }
  const reader = new FileReader();
  reader.onload = ()=>{ loadAnyText(String(reader.result||'')); };
  reader.onerror = ()=>notify('Could not read that file.', 'warn');
  reader.readAsText(f);
  e.target.value = '';
});

/* Saved games */
function renderGamesList(){
  const ul = $('#games-list'); ul.innerHTML = '';
  $('#games-count').textContent = savedGames.length;
  $('#games-empty').hidden = savedGames.length > 0;
  $('#games-clear').disabled = savedGames.length === 0;
  savedGames.forEach(g=>{
    const li = document.createElement('li'); li.className = 'game-item';
    const humanWon = (g.result==='1-0' && g.human==='w') || (g.result==='0-1' && g.human==='b');
    const draw = g.result === '1/2-1/2';
    const tag = draw ? 'Draw' : (humanWon ? 'Win' : 'Loss');
    const d = new Date(g.date);
    const lvl = {name:'Cobra · L'+clamp(g.level||7,1,MAX_LEVEL)};
    li.innerHTML =
      '<button class="game-main" data-id="'+g.id+'" title="Open on the analysis board">'+
      '<span class="game-tag tag-'+tag.toLowerCase()+'">'+tag+'</span>'+
      '<span class="game-meta"><strong>vs '+escapeHTML(lvl.name)+'</strong><small>'+d.toLocaleDateString(undefined,{day:'numeric',month:'short'})+' · '+Math.ceil(g.plies/2)+' moves · '+escapeHTML(g.result)+'</small></span></button>'+
      '<button class="icon-btn" data-act="review" data-id="'+g.id+'" title="Review this game"><svg class="ico"><use href="#i-search"/></svg></button>'+
      '<button class="icon-btn danger" data-act="delete" data-id="'+g.id+'" title="Delete this game"><svg class="ico"><use href="#i-trash"/></svg></button>';
    ul.appendChild(li);
  });
}
$('#games-list').addEventListener('click', async (e)=>{
  const btn = e.target.closest('button'); if(!btn) return;
  const id = btn.dataset.id; const entry = savedGames.find(g=>g.id===id); if(!entry) return;
  const act = btn.dataset.act;
  if(act === 'delete'){
    if(await confirmDialog('Delete this game?', 'It will be removed from this device.', 'Delete', true)){
      savedGames = savedGames.filter(g=>g.id!==id); persistGames(); renderGamesList(); Sound.swipe();
    }
  } else if(act === 'review'){
    if(loadPgnText(entry.pgn, {openReview:true})) runReviewSafe();
  } else {
    loadPgnText(entry.pgn);
  }
});
$('#games-clear').addEventListener('click', async ()=>{
  if(!savedGames.length) return;
  if(await confirmDialog('Delete all saved games?', savedGames.length+' game'+(savedGames.length===1?'':'s')+" will be removed from this device. This can't be undone.", 'Delete all', true)){
    savedGames = []; persistGames(); renderGamesList(); Sound.swipe(); notify('Saved games cleared.');
  }
});

/* ---------------------------------------------------------
   20. Game Review
   --------------------------------------------------------- */
const PIECE_VALUE = {p:1,n:3,b:3,r:5,q:9,k:0};

function uciToSan(fen, uci){
  try{ const g = new Chess(fen); return g.move({from:uci.slice(0,2), to:uci.slice(2,4), promotion: uci[4]}).san; }
  catch(e){ return uci; }
}
function pvToSan(fen, pv, n){
  const g = new Chess(fen); const out = [];
  for(const u of (pv||[]).slice(0,n)){
    try{ out.push(g.move({from:u.slice(0,2), to:u.slice(2,4), promotion:u[4]}).san); }catch(e){ break; }
  }
  return out;
}

/* A move counts as a sacrifice when the moved piece can be taken and the
   exchange costs the mover at least two points of material. */
function isSacrifice(m){
  if(m.piece === 'k' || m.piece === 'p') return false;
  const g = new Chess(m.after);
  const caps = g.moves({verbose:true}).filter(x=>x.to===m.to && x.captured);
  if(!caps.length) return false;
  caps.sort((a,b)=>PIECE_VALUE[a.piece]-PIECE_VALUE[b.piece]);
  const att = caps[0];
  const gained = m.captured ? PIECE_VALUE[m.captured] : 0;
  g.move(att.san);
  const recapture = g.moves({verbose:true}).some(x=>x.to===m.to && x.captured);
  const net = PIECE_VALUE[m.piece] - (recapture ? PIECE_VALUE[att.piece] : 0) - gained;
  return net >= 2;
}

let reviewShort = false, ringTimer = null, ringPct = 0, ringResolve = null;
function paintRing(p){
  const arc = $('#review-ring-arc'); if(arc) arc.style.strokeDashoffset = String(213.6*(1-p/100));
  const t = $('#review-ring-pct'); if(t) t.textContent = p+'%';
}
function setReviewProgress(f){ $('#review-bar-fill').style.width = Math.round(f*100)+'%'; }
/* The ring deliberately counts 0 to 100 in 2.5 s, one percent at a time (25 ms each). */
function startRing(){
  clearInterval(ringTimer); ringPct = 0; paintRing(0);
  const done = new Promise(r=>{ ringResolve = r; });
  ringTimer = setInterval(()=>{
    ringPct++; paintRing(ringPct);
    if(ringPct >= 100){ clearInterval(ringTimer); ringTimer = null; if(ringResolve){ const r = ringResolve; ringResolve = null; r(); } }
  }, 25);
  return done;
}
function stopRing(){ clearInterval(ringTimer); ringTimer = null; if(ringResolve){ const r = ringResolve; ringResolve = null; r(); } }
let ringDone = null;
function setReviewUI(running, plies){
  if(running){
    reviewShort = Math.ceil((plies||0)/2) < 25;
    $('#review-ring').hidden = !reviewShort; $('#review-bar').hidden = reviewShort;
    setReviewProgress(0); ringDone = reviewShort ? startRing() : null;
  }
  $('#review-progress').hidden = !running;
  if(!running) stopRing();
  if(running) Sound.loopStart(); else Sound.loopStop();
  refreshControls();
}
function hideReviewResults(){
  $('#accuracy-row').hidden = true; $('#summary-table').hidden = true;
  $('#review-detail').hidden = true; $('#review-hint').hidden = false;
  $('#review-list').innerHTML = ''; $('#graph-card').hidden = true;
}

async function runReview(){
  if(state.reviewing){ state.reviewAbort = true; return; }
  const hint = $('#review-hint');
  if(engineBooting && engineInitPromise) await engineInitPromise;
  if(!reviewEngine.available){
    hint.hidden = false;
    hint.textContent = 'Analysis needs a chess engine, and none could start in this browser.';
    openPanel('review'); return;
  }
  const hist = game.history({verbose:true});
  if(hist.length < 1){ hint.hidden = false; hint.textContent = 'Game analysis requires a PGN with at least one move.'; return; }
  stopAutoplay();
  state.reviewing = true; state.reviewAbort = false; state.evalSeq++;
  state.review = null; hideReviewResults(); hint.hidden = true;
  setReviewUI(true, hist.length);
  reviewEngine.setOption('MultiPV', 2);
  const depth = reviewEngine.kind === 'js' ? 9 : 12;

  const fens = [hist[0].before].concat(hist.map(m=>m.after));
  const E = [], E2 = [], BEST = [], PV = [];
  let aborted = false;
  try{
    for(let i=0;i<fens.length;i++){
      if(state.reviewAbort){ aborted = true; break; }
      const fen = fens[i], g = new Chess(fen), turn = g.turn();
      let ev, ev2 = null, best = null, pv = [];
      if(g.isCheckmate()){ ev = {cp: turn==='w' ? -3000 : 3000, mate:null}; }
      else if(g.isGameOver()){ ev = {cp:0, mate:null}; }
      else {
        const res = await reviewEngine.go(fen, {depth:depth});
        if(!reviewEngine.available){ aborted = true; break; }
        ev = infoToEval(res.info, turn) || {cp:0, mate:null};
        const e2 = infoToEval(res.info2, turn); ev2 = e2 ? e2.cp : null;
        best = res.bestmove; pv = res.info ? res.info.pv : [];
      }
      E[i] = ev; E2[i] = ev2; BEST[i] = best; PV[i] = pv;
      setReviewProgress((i+1)/fens.length);
      $('#review-progress-label').textContent = 'Analyzing position '+(i+1)+' of '+fens.length+'…';
    }
  } finally {
    reviewEngine.setOption('MultiPV', 1);
    if(reviewShort && !state.reviewAbort && ringDone){ await ringDone; } else stopRing();
    state.reviewing = false; setReviewUI(false);
  }
  if(aborted){
    notify(state.reviewAbort ? 'Analysis cancelled.' : 'Analysis stopped — the engine is unavailable.', 'warn');
    hint.hidden = false; hint.textContent = 'Press Analyse to grade every move.';
    updateEvalBar(); return;
  }

  const standard = hist[0].before === DEFAULT_FEN;
  const book = standard ? buildBook() : null;
  const rows = []; const counts = {w:{}, b:{}};
  const accSum = {w:0, b:0}, accN = {w:0, b:0};
  hist.forEach((m, k)=>{
    const c = m.color;
    const v0 = c==='w' ? E[k].cp : -E[k].cp;
    const v1 = c==='w' ? E[k+1].cp : -E[k+1].cp;
    const w0 = winPct(v0), w1 = winPct(v1);
    const loss = Math.max(0, w0 - w1);
    const playedUci = m.from + m.to + (m.promotion || '');
    const isBest = !!BEST[k] && playedUci === BEST[k];
    let cls;
    if(book && book.has(epd(m.after))) cls = 'book';
    else if(isBest || loss <= 0.3){
      cls = 'best';
      if((isBest || loss <= 1) && isSacrifice(m) && w1 >= w0 - 3 && v1 > -100 && w0 < 92) cls = 'brilliant';
      else if(isBest && E2[k] != null){
        const v2 = c==='w' ? E2[k] : -E2[k];
        if(w0 - winPct(v2) >= 15 && w0 > 25) cls = 'great';
      }
    }
    else if(loss <= 2)  cls = 'excellent';
    else if(loss <= 5)  cls = 'good';
    else if(loss <= 10) cls = 'inaccuracy';
    else if(loss <= 20) cls = 'mistake';
    else cls = 'blunder';
    const acc = clamp(103.1668*Math.exp(-0.04354*loss) - 3.1669, 0, 100);
    accSum[c] += acc; accN[c]++;
    counts[c][cls] = (counts[c][cls]||0) + 1;
    const showBest = ['best','brilliant','great','book'].indexOf(cls) < 0 && !!BEST[k];
    rows.push({
      ply:k+1, san:m.san, color:c, cls:cls, loss:loss, acc:acc,
      bestUci: showBest ? BEST[k] : null,
      bestSan: showBest ? uciToSan(fens[k], BEST[k]) : null,
      line: showBest ? pvToSan(fens[k], PV[k], 5) : [],
      evalBefore: E[k], evalAfter: E[k+1]
    });
  });
  state.review = {
    rows:rows, evals:E, counts:counts,
    accW: accN.w ? Math.round(accSum.w/accN.w) : null,
    accB: accN.b ? Math.round(accSum.b/accN.b) : null
  };
  renderReviewResults(); renderEvalGraph();
  updateMoveList(); renderBoard(); updateReviewDetail();
  Sound.swipe();
  renderEvalForView();
}
function runReviewSafe(){
  runReview().catch(err=>{
    console.error(err); state.reviewing = false; setReviewUI(false); notify('Analysis failed.', 'warn');
  });
}

function renderReviewResults(){
  const r = state.review; if(!r) return;
  $('#acc-white').textContent = r.accW == null ? '—' : r.accW + '%';
  $('#acc-black').textContent = r.accB == null ? '—' : r.accB + '%';
  $('#accuracy-row').hidden = false;
  const body = $('#summary-body'); body.innerHTML = '';
  CLS_ORDER.forEach(cls=>{
    const w = r.counts.w[cls]||0, b = r.counts.b[cls]||0;
    const tr = document.createElement('tr'); if(!w && !b) tr.className = 'zero';
    tr.innerHTML = '<td><span class="badge-dot b-'+cls+'">'+clsImg(cls)+'</span>'+CLS[cls].label+'</td><td>'+w+'</td><td>'+b+'</td>';
    body.appendChild(tr);
  });
  $('#summary-table').hidden = false;
  $('#review-hint').hidden = true;
}

function fmtEval(ev){
  if(!ev) return '';
  if(ev.mate != null) return (ev.mate>0?'+M':'-M') + Math.abs(ev.mate);
  if(Math.abs(ev.cp) >= 2900) return ev.cp>0 ? '1-0' : '0-1';
  return (ev.cp>=0?'+':'') + (ev.cp/100).toFixed(1);
}

function updateReviewDetail(){
  const box = $('#review-detail');
  const ply = currentPly();
  if(!state.review || ply < 1){ box.hidden = true; return; }
  const row = state.review.rows[ply-1]; if(!row){ box.hidden = true; return; }
  const who = row.color==='w' ? 'White' : 'Black';
  let html = '<div class="rd-head"><span class="badge-dot big b-'+row.cls+'">'+clsImg(row.cls)+'</span><div><strong>'+escapeHTML(row.san)+'</strong> is '+CLS[row.cls].phrase+'<small>'+who+' · eval '+fmtEval(row.evalBefore)+' → '+fmtEval(row.evalAfter)+'</small></div></div>';
  if(row.bestSan){
    html += '<div class="rd-best">Best was <strong>'+escapeHTML(row.bestSan)+'</strong>'+
            (row.line.length ? '<small>Engine line: '+row.line.map(escapeHTML).join(' ')+'</small>' : '') + '</div>';
  }
  box.innerHTML = html; box.hidden = false;
}
$('#btn-run-review').addEventListener('click', runReviewSafe);

/* Analysis import: paste a PGN, or upload / drop a file */
function importAndAnalyze(text){
  text = (text||'').trim();
  if(!text){ notify('Paste a PGN first.'); return; }
  const looksFen = FEN_RE.test(text) && !/\[Event|\n\s*1\./.test(text) && !/\b1\.\s*[a-hNBRQKO]/.test(text);
  if(looksFen){ notify('Game analysis requires a PGN with at least one move.', 'warn'); return; }
  if(loadPgnText(text, {openReview:true})) runReviewSafe();
}
function readFileText(f, cb){
  if(!f) return;
  if(f.size > 2*1024*1024){ notify('That file is too large (2 MB max).', 'warn'); return; }
  const reader = new FileReader();
  reader.onload = ()=>cb(String(reader.result||''));
  reader.onerror = ()=>notify('Could not read that file.', 'warn');
  reader.readAsText(f);
}
$('#btn-review-paste').addEventListener('click', ()=>importAndAnalyze($('#review-pgn').value));
const dropEl = $('#review-drop');
dropEl.addEventListener('click', ()=>$('#review-file').click());
dropEl.addEventListener('keydown', e=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); $('#review-file').click(); } });
['dragenter','dragover'].forEach(ev=>dropEl.addEventListener(ev, e=>{ e.preventDefault(); dropEl.classList.add('is-over'); }));
['dragleave','drop'].forEach(ev=>dropEl.addEventListener(ev, e=>{ e.preventDefault(); dropEl.classList.remove('is-over'); }));
dropEl.addEventListener('drop', e=>{ const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; readFileText(f, importAndAnalyze); });
$('#review-file').addEventListener('change', e=>{ const f = e.target.files && e.target.files[0]; e.target.value=''; readFileText(f, importAndAnalyze); });

/* ---------------------------------------------------------
   21. Panels, tabs and dock navigation
   --------------------------------------------------------- */
function openPanel(name){
  $$('.dock-btn[data-panel]').forEach(b=>b.classList.toggle('is-active', b.dataset.panel===name));
  $$('.panel').forEach(p=>{ p.hidden = p.dataset.panel !== name; });
  if(settings.sidebarHidden){ settings.sidebarHidden = false; persistSettings(); applySidebar(); }
  if(window.matchMedia('(max-width: 980px)').matches) $('#dashboard').classList.add('is-open');
}
function activateTab(name){
  const scope = $('#panel-play');
  $$('.tab-btn', scope).forEach(b=>b.classList.toggle('is-active', b.dataset.tab===name));
  $$('.tab-body', scope).forEach(b=>b.classList.toggle('is-active', b.dataset.tabBody===name));
  openPanel('play');
}
$$('.dock-btn[data-panel]').forEach(btn=>{
  btn.addEventListener('click', ()=>{ openPanel(btn.dataset.panel); Sound.tap(); });
});
$$('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{ activateTab(btn.dataset.tab); Sound.tap(); });
});

/* ---------------------------------------------------------
   22. Play-panel controls
   --------------------------------------------------------- */
function setLevel(L){
  L = clamp(parseInt(L,10)||7, 1, MAX_LEVEL);
  state.skillLevel = L; settings.level = L; persistSettings();
  updateBotCard();
  if(engine.available) applySkillLevel(L);
}
$('#skill-level').addEventListener('input', e=>setLevel(e.target.value));
$('#card-level').addEventListener('input', e=>setLevel(e.target.value));
$('#time-preset').addEventListener('change', (e)=>{
  $('#custom-time').hidden = e.target.value !== 'custom'; Sound.tap();
});
$$('#side-select .seg-btn').forEach(b=>{
  b.addEventListener('click', ()=>{
    $$('#side-select .seg-btn').forEach(x=>x.classList.remove('is-active'));
    b.classList.add('is-active'); Sound.tap();
  });
});
$('#btn-new-game').addEventListener('click', async ()=>{
  const inProgress = state.mode==='play' && !state.gameOver && game.history().length >= 2;
  if(inProgress && !(await confirmDialog('Start a new game?', 'The game in progress will be abandoned.', 'New game', true))) return;
  openPanel('play'); newGame();
});
$('#btn-resign').addEventListener('click', async ()=>{
  if(state.gameOver || state.mode!=='play') return;
  if(await confirmDialog('Resign this game?', 'This counts as a loss.', 'Resign', true)){
    const loser = engine.available ? state.humanColor : game.turn();
    finishGame(other(loser), 'resignation');
  }
});
$('#btn-draw').addEventListener('click', async ()=>{
  if(state.gameOver || state.mode!=='play') return;
  if(!engine.available){
    if(await confirmDialog('Agree a draw?', 'Both players agree to a draw.', 'Draw')) finishGame(null, 'agreement');
    return;
  }
  if(!(await confirmDialog('Offer a draw?', botName()+' will consider your offer.', 'Offer draw'))) return;
  const botEval = state.humanColor==='w' ? -state.evalCp : state.evalCp;
  const accept = botEval <= 40 || (game.history().length >= 80 && botEval <= 150);
  await sleep(500);
  if(state.gameOver) return;
  if(accept){ finishGame(null, 'agreement'); }
  else { notify(botName()+' declines the draw.'); Sound.invalid(); }
});
$('#btn-flip').addEventListener('click', ()=>{
  state.flipped = !state.flipped;
  buildBoardDOM(); renderBoard(); Sound.swipe();
});

$('#result-rematch').addEventListener('click', ()=>{ hideResult(); openPanel('play'); newGame(); });
$('#result-review').addEventListener('click', ()=>{ hideResult(); openPanel('review'); runReviewSafe(); });
$('#result-close').addEventListener('click', ()=>{ hideResult(); Sound.tap(); });

$('#nav-first').addEventListener('click', ()=>{ stopAutoplay(); goToPly(0); });
$('#nav-prev').addEventListener('click', ()=>stepPly(-1));
$('#nav-next').addEventListener('click', ()=>stepPly(1));
$('#nav-last').addEventListener('click', ()=>{ stopAutoplay(); goToPly(game.history().length); });
$('#nav-play').addEventListener('click', toggleAutoplay);

/* ---------------------------------------------------------
   23. Customize panel
   --------------------------------------------------------- */
function applyBoardTheme(id){
  const t = BOARD_THEMES.find(x=>x.id===id) || BOARD_THEMES[0];
  document.documentElement.style.setProperty('--board-light', t.light);
  document.documentElement.style.setProperty('--board-dark', t.dark);
}
function buildThemeSwatches(){
  const boardWrap = $('#board-themes'); boardWrap.innerHTML = '';
  BOARD_THEMES.forEach(t=>{
    const el = document.createElement('button');
    el.className = 'swatch' + (settings.boardTheme===t.id ? ' is-active' : '');
    el.innerHTML = '<div class="swatch-preview" style="--sw-light:'+t.light+';--sw-dark:'+t.dark+'"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div><label>'+t.label+'</label>';
    el.addEventListener('click', ()=>{
      settings.boardTheme = t.id; persistSettings(); applyBoardTheme(t.id);
      $$('.swatch', boardWrap).forEach(s=>s.classList.remove('is-active')); el.classList.add('is-active');
      Sound.tap();
    });
    boardWrap.appendChild(el);
  });
  const pieceWrap = $('#piece-themes'); pieceWrap.innerHTML = '';
  PIECE_THEMES.forEach(t=>{
    const el = document.createElement('button');
    el.className = 'swatch' + (settings.pieceStyle===t.id ? ' is-active' : '');
    el.innerHTML = (t.nc ? '<span class="nc" title="Non-commercial licence (CC BY-NC-SA)">NC</span>' : '')+'<div class="swatch-preview pieces">'+pieceMarkup('n','b',t.id)+'</div><label>'+t.label+'</label>';
    el.addEventListener('click', ()=>{
      settings.pieceStyle = t.id; persistSettings(); renderBoard();
      $$('.swatch', pieceWrap).forEach(s=>s.classList.remove('is-active')); el.classList.add('is-active');
      Sound.tap();
    });
    pieceWrap.appendChild(el);
  });
}
$('#toggle-coords').addEventListener('change', (e)=>{
  settings.showCoords = e.target.checked; persistSettings(); buildBoardDOM(); renderBoard(); Sound.toggle(e.target.checked);
});
function applyEvalToggle(){ $('.arena').classList.toggle('no-eval', !settings.showEval); }
$('#toggle-botoff').addEventListener('change', async (e)=>{
  if(e.target.checked){
    if(state.mode !== 'analysis') enterAnalysis(()=>{}, true);
    notify('Bot off — move both sides; best moves appear in the panel.');
  } else if(state.mode === 'analysis'){
    const fen = game.fen();
    openPanel('play'); newGame({fen: fen, silent:true});
    notify('Cobra is back — playing from this position.');
  }
});
$('#toggle-eval').addEventListener('change', (e)=>{
  settings.showEval = e.target.checked; persistSettings(); applyEvalToggle(); Sound.toggle(e.target.checked);
});
$('#toggle-highlights').addEventListener('change', (e)=>{
  settings.showHighlights = e.target.checked; persistSettings(); renderBoard(); Sound.toggle(e.target.checked);
});

/* ---------------------------------------------------------
   24. Dock toggles: theme, sound, full screen, side panel
   --------------------------------------------------------- */
function applyUiTheme(){
  document.documentElement.dataset.theme = settings.uiTheme;
  const dark = settings.uiTheme === 'dark';
  setHidden($('#ico-moon'), !dark); setHidden($('#ico-sun'), dark);
  $('#btn-theme').title = dark ? 'Switch to light mode' : 'Switch to dark mode';
}
$('#btn-theme').addEventListener('click', ()=>{
  settings.uiTheme = settings.uiTheme==='dark' ? 'light' : 'dark';
  persistSettings(); applyUiTheme(); Sound.toggle(settings.uiTheme==='dark');
});
function applyMuteIcon(){
  setHidden($('#ico-vol'), !settings.sound); setHidden($('#ico-mute'), settings.sound);
  $('#btn-mute').title = settings.sound ? 'Mute sounds' : 'Unmute sounds';
  $('#settings-sound').checked = settings.sound;
}
$('#btn-mute').addEventListener('click', ()=>{
  settings.sound = !settings.sound; persistSettings(); applyMuteIcon();
  if(settings.sound) Sound.toggle(true);
});
$('#btn-fullscreen').addEventListener('click', async ()=>{
  try{
    if(document.fullscreenElement) await document.exitFullscreen();
    else if(document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else notify('Full screen is not supported in this browser.', 'warn');
  }catch(e){ notify('Full screen was blocked by the browser.', 'warn'); }
});
document.addEventListener('fullscreenchange', ()=>{
  const fs = !!document.fullscreenElement;
  setHidden($('#ico-max'), fs); setHidden($('#ico-min'), !fs);
  $('#btn-fullscreen').title = fs ? 'Exit full screen' : 'Full screen';
});
function applySidebar(){
  $('#app').classList.toggle('is-collapsed', !!settings.sidebarHidden);
}
$('#btn-sidebar').addEventListener('click', ()=>{
  if(window.matchMedia('(max-width: 980px)').matches){
    $('#dashboard').classList.toggle('is-open');
  } else {
    settings.sidebarHidden = !settings.sidebarHidden; persistSettings(); applySidebar();
  }
  Sound.swipe();
});

/* ---------------------------------------------------------
   25. Settings modal
   --------------------------------------------------------- */
function openSettings(){
  $('#settings-engine').value = settings.engine;
  $('#settings-backdrop').hidden = false;
  const c = $('#settings-close'); if(c) c.focus();
}
function closeSettings(){ $('#settings-backdrop').hidden = true; }
$('#btn-prefs').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);
$('#settings-backdrop').addEventListener('mousedown', (e)=>{ if(e.target.id === 'settings-backdrop') closeSettings(); });
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && !$('#settings-backdrop').hidden && $('#dialog-backdrop').hidden) closeSettings(); });
$('#settings-sound').addEventListener('change', e=>{ settings.sound = e.target.checked; persistSettings(); applyMuteIcon(); if(settings.sound) Sound.toggle(true); });
$('#settings-soundpack').addEventListener('change', e=>{ settings.soundPack = e.target.value; persistSettings(); Sound.preload(); Sound.moveSelf(); });
$('#settings-premove').addEventListener('change', e=>{ settings.premove = e.target.checked; persistSettings(); Sound.toggle(e.target.checked); });
$('#settings-autoqueen').addEventListener('change', e=>{ settings.autoQueen = e.target.checked; persistSettings(); Sound.toggle(e.target.checked); });
$('#settings-reset').addEventListener('click', async ()=>{
  if(await confirmDialog('Reset stats and rating?', 'Wins, losses, draws and your rating return to their starting values. Saved games are kept.', 'Reset', true)){
    stats.wins = 0; stats.losses = 0; stats.draws = 0; stats.rating = 1200;
    persistStats(); renderStats(); notify('Stats reset.');
  }
});
$('#settings-engine').addEventListener('change', async (e)=>{
  const choice = e.target.value;
  settings.engine = choice; persistSettings();
  if(state.reviewing) state.reviewAbort = true;
  state.botToken++; state.evalSeq++;
  setThinking(false);
  notify('Loading engine…');
  engineInitPromise = bootEngines(choice);
  const ok = await engineInitPromise;
  if(ok){
    notify(ENGINE_LABEL[engine.kind]+' is ready.');
    if(state.mode==='play' && !state.gameOver){
      if(!humanToMove()) triggerBotMove(); else updateEvalBar();
    } else updateEvalBar();
  } else {
    notify(choice === 'wasm' ? 'WebAssembly engine unavailable here — try "Automatic" or the JavaScript engine.' : 'No engine could start.', 'warn');
    renderClocks(); renderBoard();
  }
});

/* ---------------------------------------------------------
   Switches: tap, or press and drag the knob (it becomes a glass pill while held)
   --------------------------------------------------------- */
function initSwitches(){
  $$('.switch-row').forEach(row=>{
    const input = $('input', row), sw = $('.switch', row);
    if(!input || !sw) return;
    let drag = null;
    sw.addEventListener('pointerdown', (e)=>{
      if(e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try{ sw.setPointerCapture(e.pointerId); }catch(err){}
      drag = {x0:e.clientX, moved:false, startOn:input.checked, kx:input.checked ? 8 : 0};
      sw.classList.add('is-pressed');
    });
    sw.addEventListener('pointermove', (e)=>{
      if(!drag) return;
      const dx = e.clientX - drag.x0;
      if(Math.abs(dx) > 3){ drag.moved = true; sw.classList.add('is-dragging'); }
      if(drag.moved){
        drag.kx = clamp((drag.startOn ? 8 : 0) + dx, 0, 8);
        sw.style.setProperty('--kx', drag.kx+'px');
      }
    });
    const end = (e, cancel)=>{
      if(!drag) return;
      const d = drag; drag = null;
      sw.classList.remove('is-pressed','is-dragging'); sw.style.removeProperty('--kx');
      try{ sw.releasePointerCapture(e.pointerId); }catch(err){}
      if(cancel) return;
      const want = d.moved ? d.kx > 4 : !d.startOn;
      if(want !== input.checked){ input.checked = want; input.dispatchEvent(new Event('change', {bubbles:true})); }
    };
    sw.addEventListener('pointerup', e=>end(e,false));
    sw.addEventListener('pointercancel', e=>end(e,true));
    sw.addEventListener('click', e=>e.preventDefault());   // the pointer handlers already toggled
  });
}

/* ---------------------------------------------------------
   26. Banner, player name, and init
   --------------------------------------------------------- */
const bannerClose = $('#engine-banner-close');
if(bannerClose) bannerClose.addEventListener('click', ()=>{ $('#engine-banner').hidden = true; });

const userNameEl = $('#user-name');
userNameEl.textContent = loadJSON('cobra.username', 'You');
userNameEl.addEventListener('keydown', (e)=>{ if(e.key === 'Enter'){ e.preventDefault(); userNameEl.blur(); } e.stopPropagation(); });
userNameEl.addEventListener('blur', ()=>{
  const v = userNameEl.textContent.replace(/\s+/g,' ').trim().slice(0,18) || 'You';
  userNameEl.textContent = v; saveJSON('cobra.username', v);
});

function init(){
  applyUiTheme(); applyMuteIcon(); applySidebar();
  applyBoardTheme(settings.boardTheme);
  buildThemeSwatches();
  if(!PIECE_THEMES.some(t=>t.id===settings.pieceStyle)) settings.pieceStyle = 'cburnett';
  $('#toggle-eval').checked = settings.showEval; applyEvalToggle();
  $('#settings-soundpack').value = settings.soundPack; Sound.preload();
  $('#toggle-coords').checked = settings.showCoords;
  $('#toggle-highlights').checked = settings.showHighlights;
  $('#settings-sound').checked = settings.sound;
  $('#settings-premove').checked = settings.premove;
  $('#settings-autoqueen').checked = settings.autoQueen;
  $('#settings-engine').value = settings.engine;
  updateBotCard();
  $('#time-preset').value = settings.timePreset;
  if($('#time-preset').value !== settings.timePreset) $('#time-preset').value = 'blitz';
  $('#custom-minutes').value = settings.customMinutes; $('#custom-increment').value = settings.customIncrement;
  $('#custom-time').hidden = $('#time-preset').value !== 'custom';
  $$('#side-select .seg-btn').forEach(b=>b.classList.toggle('is-active', b.dataset.side === settings.side));
  if(!$('#side-select .seg-btn.is-active')) $('#side-select .seg-btn').classList.add('is-active');
  initSwitches();
  renderStats(); renderGamesList(); updateEngineChip();
  newGame({silent:true});
  engineInitPromise = bootEngines(settings.engine);
}
init();

})();
