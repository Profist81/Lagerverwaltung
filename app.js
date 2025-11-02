// 2. app.js
/* Lagerverwaltungs-App (PWA, offline, keine externen Abhängigkeiten)
   Features: IndexedDB, Kamera (mehrseitig), Zeichnungsstatus, Buchungsstatus,
   temporärer Lagerort mit Foto, CSV/PDF-Export (Print), Drag&Drop mit Teilmengen,
   Admin-PIN (SHA-256), Background-Sync, BroadcastChannel "live updates",
   optional WebSocket-URL (Settings) falls vorhanden. */

(() => {
  "use strict";

  /******************** Utilities ********************/
  const $ = (sel, ctx=document) => ctx.querySelector(sel);
  const $$ = (sel, ctx=document) => Array.from(ctx.querySelectorAll(sel));
  const sleep = (ms) => new Promise(r=>setTimeout(r, ms));
  const nowISO = () => new Date().toISOString();

  const toCSV = (rows) => {
    if (!rows.length) return '';
    const head = Object.keys(rows[0]);
    const esc = (v) => {
      const s = (v ?? '').toString().replaceAll('"','""');
      return /[",;\n]/.test(s) ? `"${s}"` : s;
    };
    const lines = [head.join(';')].concat(rows.map(r => head.map(k=>esc(r[k])).join(';')));
    return lines.join('\n');
  };

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  };

  const sha256Hex = async (text) => {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
  };

  const fmtTs = (iso) => {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  /******************** Broadcast (multi-tab live) & optional WS ********************/
  const bc = ('BroadcastChannel' in self) ? new BroadcastChannel('lagerapp') : null;
  const emitUpdate = (topic='*') => { try { bc?.postMessage({type:'update', topic, ts:nowISO()}); } catch {} };
  bc?.addEventListener('message', ev => {
    if (ev.data?.type === 'update') {
      refreshAll();
    }
  });

  let ws = null;
  const startWS = (url) => {
    try {
      if (!url) return;
      ws = new WebSocket(url);
      ws.onmessage = (e)=> { try{
        const msg = JSON.parse(e.data);
        if (msg.type === 'update') refreshAll();
      } catch {} };
      ws.onopen = ()=>console.log('WS connected');
      ws.onclose = ()=>console.log('WS closed');
    } catch (e) { console.warn('WS error', e); }
  };
  const wsNotify = () => { try { ws?.readyState===1 && ws.send(JSON.stringify({type:'update', ts:nowISO()})); } catch {} };

  /******************** IndexedDB ********************/
  const DB_NAME = 'lagerdb-v1';
  const openDB = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('settings', { keyPath: 'k' });
      const docs = db.createObjectStore('docs', { keyPath: 'id' }); // {id, createdAt, supplier, docNo, withDrawing, booked, tempLocation, tempLocPhotoId|null, items:[{id, articleNo, qty, leftQty}]}
      docs.createIndex('booked', 'booked');
      docs.createIndex('withDrawing', 'withDrawing');
      db.createObjectStore('docImages', { keyPath: 'key' }); // key = `${docId}:${seq}` -> {key, docId, seq, blob, kind:'doc'|'temp'}
      const loc = db.createObjectStore('locations', { keyPath: 'id' }); // {id, name}
      loc.createIndex('name', 'name', {unique:true});
      const mov = db.createObjectStore('movements', { keyPath: 'id' }); // {id, ts, articleNo, qty, from, to, user}
      mov.createIndex('ts', 'ts');
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });

  let DB;
  const tx = (stores, mode='readonly') => DB.transaction(stores, mode);
  const RID = () => Math.random().toString(36).slice(2)+Date.now().toString(36);

  const settings = {
    async get(k) { const v = await getOne('settings', k); return v?.v; },
    async set(k, v) { await put('settings', {k, v}); },
  };

  const getOne = (store, key) => new Promise((resolve,reject)=>{
    const r = tx([store]).objectStore(store).get(key);
    r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
  });
  const put = (store, val) => new Promise((resolve,reject)=>{
    const r = tx([store],'readwrite').objectStore(store).put(val);
    r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
  });
  const del = (store, key) => new Promise((resolve,reject)=>{
    const r = tx([store],'readwrite').objectStore(store).delete(key);
    r.onsuccess=()=>resolve(); r.onerror=()=>reject(r.error);
  });
  const all = (store) => new Promise((resolve,reject)=>{
    const r = tx([store]).objectStore(store).getAll();
    r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
  });
  const allIndexEq = (store, index, val) => new Promise((resolve,reject)=>{
    const os = tx([store]).objectStore(store).index(index);
    const r = os.getAll(val);
    r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
  });

  /******************** State & Auth ********************/
  let ADMIN = false;
  const requireAdmin = async () => {
    if (ADMIN) return true;
    const dlg = $('#dlg-login'); $('#pin-in').value='';
    dlg.showModal();
    const ok = await waitDialogOk(dlg);
    if (!ok) return false;
    const pin = $('#pin-in').value.trim();
    const saved = await settings.get('pinHash');
    if (!saved) { alert('Kein Admin-PIN gesetzt. In den Einstellungen festlegen.'); return false; }
    const h = await sha256Hex(pin);
    if (h === saved) { ADMIN = true; return true; }
    alert('Falsche PIN.');
    return false;
  };

  const waitDialogOk = (dlg) => new Promise(res=>{
    const onClose = ()=>{ dlg.removeEventListener('close', onClose); res(dlg.returnValue==='ok'); };
    dlg.addEventListener('close', onClose, {once:true});
  });

  /******************** Tabs ********************/
  $$('.tab').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      $$('.tab').forEach(b=>b.classList.remove('active'));
      $$('.panel').forEach(p=>p.classList.remove('active'));
      btn.classList.add('active');
      $(`#tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  /******************** Inbound Forms ********************/
  const addItemRow = (container) => {
    const id = RID();
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <input placeholder="57-90-12 ..." class="art" data-id="${id}" />
      <input type="number" min="1" step="1" value="1" class="qty" />
      <button type="button" class="btn ghost scan">📷 Scan</button>
      <button type="button" class="btn danger remove">✖</button>
    `;
    container.appendChild(row);

    row.querySelector('.remove').onclick = ()=> row.remove();
    row.querySelector('.scan').onclick = ()=> scanBarcodeInto(row.querySelector('.art'));
  };

  $('#oi-add').onclick = ()=> addItemRow($('#oi-body'));
  $('#mi-add').onclick = ()=> addItemRow($('#mi-body'));
  addItemRow($('#oi-body'));
  addItemRow($('#mi-body'));

  const camera = {
    el: $('#camera'),
    video: $('#cam-video'),
    canvas: $('#cam-canvas'),
    kind: null, docId: null,
    stream: null,
    async open(kind, title) {
      this.kind = kind;
      $('#camera-title').textContent = title;
      this.el.hidden = false;
      this.stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
      this.video.srcObject = this.stream;
    },
    async snap() {
      const v = this.video;
      const c = this.canvas;
      const w = v.videoWidth, h = v.videoHeight;
      if (!w || !h) return null;
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0, w, h);
      const blob = await new Promise(r=>c.toBlob(r, 'image/jpeg', 0.85));
      return blob;
    },
    async close() {
      this.video.pause();
      if (this.stream) this.stream.getTracks().forEach(t=>t.stop());
      this.el.hidden = true;
      this.kind = null;
    }
  };

  $('[data-photo="temp"]', $('#form-inbound-ohne')).onclick = ()=> openCamForForm('ohne','temp');
  $('[data-photo="doc"]',  $('#form-inbound-ohne')).onclick = ()=> openCamForForm('ohne','doc');
  $('[data-photo="temp"]', $('#form-inbound-mit')).onclick  = ()=> openCamForForm('mit','temp');
  $('[data-photo="doc"]',  $('#form-inbound-mit')).onclick  = ()=> openCamForForm('mit','doc');

  async function openCamForForm(kindTab, kind) {
    await camera.open(kind, kind==='temp' ? 'Foto: Lagerort' : 'Fotos: Lieferschein');
    camera.docId = kindTab; // temp marker; final save associates to real doc id
  }

  $('#camera-close').onclick = ()=> camera.close();
  $('#btn-snap').onclick = async ()=> {
    const blob = await camera.snap();
    if (!blob) return alert('Kamera bereit?');
    const tag = document.createElement('div');
    tag.className='chip';
    tag.textContent = camera.kind === 'temp' ? 'Lagerort-Foto • gespeichert' : 'Lieferschein-Seite • gespeichert';
    tag.dataset.blobUrl = URL.createObjectURL(blob);
    tag.style.cursor='zoom-in';
    tag.onclick = ()=> window.open(tag.dataset.blobUrl,'_blank');
    const host = camera.docId==='ohne' ? $('#form-inbound-ohne') : $('#form-inbound-mit');
    (camera.kind==='temp' ? host.querySelector('.row') : host.querySelector('.items')).appendChild(tag);
    // cache temporarily on window (before doc exists)
    (tempBlobs[camera.docId] ??= []).push({kind:camera.kind, blob});
  };
  $('#btn-finish-cam').onclick = ()=> camera.close();

  const tempBlobs = { ohne: [], mit: [] }; // store until doc saved

  $('#form-inbound-ohne').addEventListener('submit', (e)=>saveInbound(e, false));
  $('#form-inbound-mit').addEventListener('submit', (e)=>saveInbound(e, true));

  async function saveInbound(e, withDrawing) {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const supplier = (fd.get('supplier')||'').toString().trim();
    const docNo = (fd.get('docNo')||'').toString().trim();
    const tempLocation = (fd.get('tempLocation')||'').toString().trim();
    if (!supplier || !docNo) return alert('Lieferant und Lieferscheinnr. sind Pflicht.');

    const items = [];
    $$('.item-row', form).forEach(r=>{
      const articleNo = r.querySelector('.art')?.value.trim();
      const qty = parseInt(r.querySelector('.qty')?.value||'0',10);
      if (articleNo && qty>0) items.push({id: RID(), articleNo, qty, leftQty: qty});
    });
    if (!items.length) return alert('Mindestens eine Position angeben.');

    const id = RID();
    const doc = { id, createdAt: nowISO(), supplier, docNo, withDrawing, booked:false, tempLocation, tempLocPhotoId:null, items };

    await put('docs', doc);

    // persist any temp blobs captured for this tab
    const captured = tempBlobs[withDrawing ? 'mit' : 'ohne'] || [];
    let seq = 0;
    for (const entry of captured) {
      if (entry.kind === 'temp' && !doc.tempLocPhotoId) {
        const key = `${id}:temp`;
        await put('docImages', { key, docId:id, seq:-1, blob: entry.blob, kind:'temp' });
        doc.tempLocPhotoId = key;
        await put('docs', doc);
      } else {
        const key = `${id}:${seq++}`;
        await put('docImages', { key, docId:id, seq, blob: entry.blob, kind:'doc' });
      }
    }
    tempBlobs[withDrawing ? 'mit' : 'ohne'] = [];

    form.reset();
    $('.items-body', form).innerHTML='';
    addItemRow($('.items-body', form));

    emitUpdate('docs'); wsNotify(); await refreshLists();
  }

  /******************** Lists & Cards ********************/
  async function refreshLists() {
    const [allDocs] = await Promise.all([all('docs')]);
    const ohne = allDocs.filter(d=>!d.withDrawing && !d.booked);
    const mit  = allDocs.filter(d=> d.withDrawing && !d.booked);

    const makeCard = (d)=> {
      const el = document.createElement('article');
      el.className='card';
      el.innerHTML = `
        <header class="row between">
          <strong>${d.supplier}</strong>
          <span>${fmtTs(d.createdAt)}</span>
        </header>
        <div class="muted">LS: ${d.docNo} • ${d.withDrawing?'mit Zeichnung':'ohne Zeichnung'}</div>
        <div class="muted">Temp-Lagerort: ${d.tempLocation || '—'}</div>
        <div class="chips">${d.items.map(i=>`<span class="chip" title="verfügbar: ${i.leftQty}/${i.qty}">${i.articleNo} × ${i.qty}</span>`).join('')}</div>
        <footer class="row gap">
          <button class="btn small" data-view="${d.id}">Anzeigen</button>
          <button class="btn small success" data-book="${d.id}">EINBUCHEN</button>
          <button class="btn small danger" data-del="${d.id}">Löschen</button>
        </footer>
      `;
      el.querySelector('[data-book]')?.addEventListener('click', async ()=>{
        d.booked = true; await put('docs', d); emitUpdate('docs'); wsNotify(); refreshAll();
      });
      el.querySelector('[data-del]')?.addEventListener('click', async ()=>{
        if (!(await requireAdmin())) return;
        await del('docs', d.id);
        // delete images
        const imgs = await all('docImages');
        await Promise.all(imgs.filter(x=>x.docId===d.id).map(x=>del('docImages', x.key)));
        emitUpdate('docs'); wsNotify(); refreshAll();
      });
      el.querySelector('[data-view]')?.addEventListener('click', ()=> viewDoc(d));
      return el;
    };

    const L1 = $('#list-ohne'); L1.innerHTML=''; ohne.forEach(d=>L1.appendChild(makeCard(d)));
    const L2 = $('#list-mit');  L2.innerHTML=''; mit.forEach(d=>L2.appendChild(makeCard(d)));

    await refreshPoolAndLocations();
    await refreshMoves();
  }

  async function viewDoc(d) {
    const imgs = (await all('docImages')).filter(x=>x.docId===d.id).sort((a,b)=>a.seq-b.seq);
    const w = window.open('', '_blank');
    const imgHtml = imgs.map(m=>{
      const url = URL.createObjectURL(m.blob);
      return `<figure><img src="${url}" style="max-width:100%"><figcaption>${m.kind==='temp'?'Lagerort':'Lieferschein'}</figcaption></figure>`;
    }).join('');
    w.document.write(`<title>${d.supplier} – ${d.docNo}</title><body style="font-family:sans-serif">${imgHtml || '<p>(keine Bilder)</p>'}<hr><pre>${JSON.stringify(d,null,2)}</pre></body>`);
  }

  /******************** Drag & Drop: Pool & Locations ********************/
  $('#btn-add-location').onclick = async ()=>{
    const name = prompt('Neuer Lagerort-Name?'); if (!name) return;
    const id = RID(); await put('locations', {id, name});
    emitUpdate('locations'); wsNotify(); refreshPoolAndLocations();
  };

  async function refreshPoolAndLocations() {
    const docs = await all('docs');
    const openItems = [];
    for (const d of docs) {
      for (const it of d.items) {
        if (it.leftQty > 0 && !d.booked) {
          openItems.push({ docId:d.id, articleNo:it.articleNo, leftQty:it.leftQty });
        }
      }
    }
    const pool = $('#stock-pool'); pool.innerHTML='';
    for (const p of openItems) {
      const chip = document.createElement('div');
      chip.className = 'drag chip';
      chip.textContent = `${p.articleNo} • ${p.leftQty}`;
      chip.draggable = true;
      chip.dataset.docId = p.docId;
      chip.dataset.articleNo = p.articleNo;
      chip.dataset.leftQty = p.leftQty;
      chip.addEventListener('dragstart', ev=>{
        ev.dataTransfer.setData('text/plain', JSON.stringify(p));
      });
      pool.appendChild(chip);
    }

    const locs = await all('locations');
    const wrap = $('#locations'); wrap.innerHTML='';
    for (const loc of locs) {
      const col = document.createElement('div');
      col.className='location-col';
      col.innerHTML = `<header class="row between"><strong>${loc.name}</strong><button class="btn ghost small" data-del="${loc.id}">✖</button></header><div class="dropzone" data-loc="${loc.id}">Hierher ziehen…</div>`;
      col.querySelector('[data-del]')?.addEventListener('click', async ()=>{
        if (!(await requireAdmin())) return;
        await del('locations', loc.id); emitUpdate('locations'); wsNotify(); refreshPoolAndLocations();
      });
      const dz = col.querySelector('.dropzone');
      dz.addEventListener('dragover', e=>{ e.preventDefault(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', ()=> dz.classList.remove('over'));
      dz.addEventListener('drop', async (e)=>{
        e.preventDefault(); dz.classList.remove('over');
        const data = JSON.parse(e.dataTransfer.getData('text/plain')||'{}');
        const dlg = $('#dlg-qty');
        const inp = $('#move-qty'); inp.value = Math.min( Number(data.leftQty||1), 1 );
        dlg.showModal();
        const ok = await waitDialogOk(dlg);
        if (!ok) return;
        const qty = parseInt(inp.value,10);
        if (!qty || qty<1 || qty>Number(data.leftQty)) return alert('Ungültige Menge.');

        // apply movement
        await applyMovement(data.docId, data.articleNo, qty, loc.id);
        emitUpdate('moves'); wsNotify(); refreshAll();
      });
      wrap.appendChild(col);
    }
  }

  async function applyMovement(docId, articleNo, qty, toLocId) {
    // reduce leftQty in doc item
    const d = await getOne('docs', docId);
    const it = d.items.find(i=>i.articleNo===articleNo && i.leftQty>0);
    if (!it) return;
    it.leftQty -= qty;
    await put('docs', d);

    const loc = await getOne('locations', toLocId);
    const mv = { id: RID(), ts: nowISO(), articleNo, qty, from: d.tempLocation || '(Wareneingang)', to: loc?.name || toLocId, user: 'local' };
    await put('movements', mv);

    // background sync hint
    try {
      const reg = await navigator.serviceWorker?.ready;
      await reg?.sync?.register('lager-sync');
    } catch {}
  }

  /******************** Bewegungen ********************/
  async function refreshMoves() {
    const q = $('#filter-q').value.trim().toLowerCase();
    const rows = await all('movements');
    const tbody = $('#moves-table tbody'); tbody.innerHTML='';
    rows.sort((a,b)=>a.ts<b.ts?1:-1).forEach(r=>{
      const s = `${r.articleNo} ${r.from} ${r.to} ${r.user}`.toLowerCase();
      if (q && !s.includes(q)) return;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${fmtTs(r.ts)}</td><td>${r.articleNo}</td><td>${r.qty}</td><td>${r.from}</td><td>${r.to}</td><td>${r.user}</td>`;
      tbody.appendChild(tr);
    });
  }
  $('#filter-q').addEventListener('input', refreshMoves);
  $('#btn-clear-moves').addEventListener('click', async ()=>{
    if (!(await requireAdmin())) return;
    const allMv = await all('movements');
    await Promise.all(allMv.map(m=>del('movements', m.id)));
    emitUpdate('moves'); wsNotify(); refreshMoves();
  });
  $('#btn-refresh').onclick = refreshAll;

  /******************** Barcode Scanner ********************/
  async function scanBarcodeInto(inputEl) {
    // Prefer BarcodeDetector API
    if ('BarcodeDetector' in window) {
      try {
        const detector = new window.BarcodeDetector({formats:['code_128','code_39','ean_13','ean_8','qr_code','upc_a','upc_e']});
        await camera.open('scan','Barcode-Scan');
        await sleep(150);
        let found=null;
        for (let i=0;i<30 && !found;i++) {
          const blob = await camera.snap(); if (!blob) continue;
          const bmp = await createImageBitmap(blob);
          const det = await detector.detect(bmp).catch(()=>[]);
          if (det?.length) found = det[0].rawValue;
          bmp.close();
          await sleep(100);
        }
        await camera.close();
        if (found) { inputEl.value = found; return; }
        alert('Kein Barcode erkannt.');
        return;
      } catch (e) {
        console.warn('BarcodeDetector not available / failed', e);
      }
    }
    // Fallback: manual
    const v = prompt('Barcode/Art.-Nr. eingeben:');
    if (v) inputEl.value = v;
  }

  /******************** Export CSV + PDF(Print) ********************/
  $('#btn-export-csv').onclick = async ()=>{
    const docs = await all('docs');
    const rows = [];
    docs.forEach(d=>{
      d.items.forEach(i=>{
        rows.push({
          createdAt: d.createdAt,
          supplier: d.supplier,
          docNo: d.docNo,
          withDrawing: d.withDrawing ? 'ja' : 'nein',
          booked: d.booked ? 'eingebucht' : 'ungebucht',
          tempLocation: d.tempLocation || '',
          articleNo: i.articleNo,
          qty: i.qty,
          leftQty: i.leftQty
        });
      });
    });
    const csv = toCSV(rows);
    downloadBlob(new Blob([csv], {type:'text/csv;charset=utf-8'}), `wareneingaenge_${new Date().toISOString().slice(0,10)}.csv`);
  };

  $('#btn-export-pdf').onclick = ()=>{
    printReportHTML(document.body, 'Lagerverwaltungs-Export');
  };

  const printRoot = $('#print-root');
  const clearPrint = ()=> printRoot.innerHTML='';

  const buildTable = (title, rows) => {
    const sec = document.createElement('section');
    sec.className='print-section';
    sec.innerHTML = `<h1>${title}</h1>`;
    const tbl = document.createElement('table');
    tbl.className='table';
    const thead = document.createElement('thead');
    const keys = Object.keys(rows[0] || {Info:'Keine Daten'});
    thead.innerHTML = `<tr>${keys.map(k=>`<th>${k}</th>`).join('')}</tr>`;
    const tbody = document.createElement('tbody');
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = keys.map(k=>`<td>${(r[k]??'')}</td>`).join('');
      tbody.appendChild(tr);
    }
    tbl.appendChild(thead); tbl.appendChild(tbody);
    sec.appendChild(tbl);
    return sec;
  };

  const printReportHTML = (sourceEl, title='Report') => {
    const w = window.open('', '_blank');
    const css = document.querySelector('link[href="styles.css"]')?.outerHTML || '';
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>${css}<style>@media print {.topbar, .tabs, .actions, .modal, .camera{display:none !important;} body{padding:0}}</style></head><body>${printRoot.innerHTML}</body></html>`);
    w.document.close(); w.focus(); w.print();
  };

  $('#btn-report-inbound').onclick = async ()=>{
    clearPrint();
    const docs = await all('docs');
    const rows = [];
    docs.forEach(d=>{
      d.items.forEach(i=>{
        rows.push({Zeit:fmtTs(d.createdAt), Lieferant:d.supplier, LS:d.docNo, Zeichnung:d.withDrawing?'ja':'nein', Status:d.booked?'eingebucht':'ungebucht', Ort:d.tempLocation||'', Artikel:i.articleNo, Menge:i.qty, Offen:i.leftQty});
      });
    });
    printRoot.appendChild(buildTable('Wareneingänge', rows));
    printReportHTML(printRoot);
  };
  $('#btn-report-stock').onclick = async ()=>{
    clearPrint();
    const docs = await all('docs');
    const rows = [];
    docs.forEach(d=>{
      d.items.forEach(i=>{
        if (i.leftQty>0 && !d.booked) rows.push({Artikel:i.articleNo, Verfügbar:i.leftQty, Herkunft:`${d.supplier} / ${d.docNo}`, TempOrt:d.tempLocation||''});
      });
    });
    printRoot.appendChild(buildTable('Bestand (offen)', rows));
    printReportHTML(printRoot);
  };
  $('#btn-report-moves').onclick = async ()=>{
    clearPrint();
    const m = await all('movements');
    const rows = m.sort((a,b)=>a.ts<b.ts?1:-1).map(x=>({Zeit:fmtTs(x.ts), Artikel:x.articleNo, Menge:x.qty, Von:x.from, Nach:x.to, User:x.user}));
    printRoot.appendChild(buildTable('Bewegungen', rows));
    printReportHTML(printRoot);
  };

  /******************** Settings & Admin ********************/
  $('#btn-settings').onclick = async ()=>{
    const v = await settings.get('wsUrl'); $('#set-ws').value = v || '';
    $('#set-pin').value = '';
    $('#dlg-settings').showModal();
  };
  $('#save-settings').onclick = async (e)=>{
    e.preventDefault();
    const wsUrl = $('#set-ws').value.trim();
    if (wsUrl) await settings.set('wsUrl', wsUrl); else await settings.set('wsUrl', '');
    const pin = $('#set-pin').value.trim();
    if (pin) {
      if (!/^\d{4,8}$/.test(pin)) { alert('PIN 4–8 Ziffern.'); return; }
      const h = await sha256Hex(pin); await settings.set('pinHash', h); ADMIN=false;
      alert('PIN gespeichert.');
    }
    $('#dlg-settings').close();
    if (ws) try { ws.close(); } catch {}
    if (wsUrl) startWS(wsUrl);
  };

  $('#btn-admin').onclick = async ()=> { if (await requireAdmin()) alert('Admin aktiv.'); };

  /******************** Install Handlers & SW Sync helper ********************/
  async function maybeSync() {
    try {
      const reg = await navigator.serviceWorker?.ready;
      await reg?.sync?.register('lager-sync');
    } catch {}
  }

  /******************** Refresh All ********************/
  async function refreshAll() {
    await Promise.all([refreshLists()]);
  }

  $('#btn-export-csv').addEventListener('click', maybeSync);

  /******************** INIT ********************/
  (async function init() {
    DB = await openDB();
    const wsUrl = await settings.get('wsUrl');
    startWS(wsUrl);
    await refreshAll();
  })();

})();
