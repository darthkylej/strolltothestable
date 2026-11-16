// Admin waiver panel: one waiver covering one or more of a donor's nativities.
// The donor signs once on the admin's phone, or signs one printed copy.
//   openWaiverSheet({ donorId, donorName, items, checkIn, onDone })
//   items: [{ id, submission_number, description, piece_count, photo_key }]
//   checkIn: true also checks the nativities in; false records the waiver only.
(function () {
  const css = `
  .ws-back { position:fixed; inset:0; z-index:70; background:rgba(3,7,15,.86); display:flex; align-items:flex-end; justify-content:center; }
  .ws-body { width:100%; max-width:640px; max-height:96vh; overflow:auto; background:var(--navy-soft,#10213d); border:1px solid var(--border-strong); border-radius:22px 22px 0 0; padding:18px; }
  .ws-head { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:12px; }
  .ws-head h2 { margin:0; font-size:1.2rem; }
  .ws-x { width:40px; height:40px; margin:0; padding:0; border-radius:50%; font-size:1.3rem; }
  .ws-list { display:grid; gap:6px; margin-bottom:14px; }
  .ws-item { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--border); border-radius:12px; background:rgba(8,16,31,.6); }
  .ws-item img, .ws-item .ws-ph { width:40px; height:40px; border-radius:8px; object-fit:cover; border:1px solid var(--border); flex-shrink:0; background:#0b1528; }
  .ws-item b { color:var(--gold-bright); display:block; }
  .ws-item span { color:var(--muted); font-size:13px; }
  .ws-seg { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:14px; }
  .ws-seg button { margin:0; }
  .ws-seg button.on { background:var(--gold); color:#10172a; border-color:var(--gold); }
  .ws-agree { max-height:34vh; overflow:auto; padding:12px 14px; border-radius:12px; background:#fffdf7; color:#1f2733; font-size:14px; line-height:1.5; margin-bottom:12px; }
  .ws-agree h3 { font-size:15px; margin:12px 0 4px; color:#1f2733; }
  .ws-agree h3:first-child { margin-top:0; }
  .ws-agree p { color:#1f2733; margin:0 0 8px; }
  .ws-agree .release-box { border:2px solid #9a7b2f; border-radius:8px; padding:8px 10px; margin:10px 0; }
  .ws-check { display:flex; gap:10px; align-items:flex-start; margin:0 0 10px; font-size:15px; line-height:1.4; }
  .ws-check input { width:22px; height:22px; margin:2px 0 0; flex-shrink:0; }
  .ws-sig { width:100%; height:170px; background:#fff; border-radius:12px; touch-action:none; display:block; }
  .ws-sigrow { display:flex; justify-content:space-between; align-items:center; margin:6px 0 12px; color:var(--muted); font-size:14px; }
  .ws-link { background:none; border:0; color:var(--gold-bright); text-decoration:underline; padding:4px; margin:0; width:auto; font:inherit; cursor:pointer; }
  .ws-big { font-size:1.1rem; padding:15px; margin:0; }
  .ws-hide { display:none !important; }`;
  let styled = false;
  let agreementCache = null;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' })[c]);

  window.openWaiverSheet = function ({ donorId, donorName, items, checkIn = false, onDone }) {
    if (!items || !items.length) return;
    if (!styled) { const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st); styled = true; }
    const ids = items.map((n) => n.id);
    const back = document.createElement('div');
    back.className = 'ws-back';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    const action = checkIn ? ' & Check In' : '';
    back.innerHTML = `<div class="ws-body">
      <div class="ws-head"><h2>${items.length === 1 ? 'Waiver · ' + esc(items[0].submission_number) : 'One waiver for ' + items.length + ' nativities'}</h2>
        <button type="button" class="btn btn-outline ws-x" data-close aria-label="Close">×</button></div>
      <div class="ws-list">${items.map((n) => `<div class="ws-item">
        ${n.photo_key ? `<img src="/photos/${esc(n.photo_key)}" alt="">` : '<span class="ws-ph"></span>'}
        <div><b>${esc(n.submission_number)}</b><span>${esc(n.description || '')}${n.piece_count ? ' · ' + esc(n.piece_count) + ' pcs' : ''}</span></div></div>`).join('')}</div>
      <div class="ws-seg"><button type="button" class="btn btn-outline on" data-mode="device">Sign on this phone</button><button type="button" class="btn btn-outline" data-mode="paper">Paper copy</button></div>
      <div data-pane="device">
        <div class="ws-agree" data-agree>Loading…</div>
        <label class="ws-check"><input type="checkbox" data-ack1><span data-ack1t></span></label>
        <label class="ws-check"><input type="checkbox" data-ack2><span data-ack2t></span></label>
        <canvas class="ws-sig" aria-label="Signature box"></canvas>
        <div class="ws-sigrow"><span>Signer: ${esc(donorName)}</span><button type="button" class="ws-link" data-clear>Clear</button></div>
        <button type="button" class="btn btn-primary ws-big" data-sign>Sign${action}</button>
      </div>
      <div data-pane="paper" class="ws-hide">
        <button type="button" class="btn btn-outline" data-print style="margin:0 0 12px">Print waiver</button>
        <button type="button" class="btn btn-primary ws-big" data-paper>Paper Signed${action}</button>
      </div></div>`;
    document.body.appendChild(back);
    document.body.style.overflow = 'hidden';
    const q = (sel) => back.querySelector(sel);
    const close = () => { back.remove(); document.body.style.overflow = ''; };
    q('[data-close]').addEventListener('click', close);

    // Signature pad
    const canvas = q('canvas'), ctx = canvas.getContext('2d');
    let hasSig = false, drawing = false, lastPt = null, lastMid = null;
    function size() {
      const r = canvas.getBoundingClientRect(); if (!r.width) return;
      canvas.width = Math.round(r.width * devicePixelRatio); canvas.height = Math.round(r.height * devicePixelRatio);
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, r.width, r.height);
      ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
      hasSig = false;
    }
    const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x:e.clientX - r.left, y:e.clientY - r.top }; };
    const drawTo = (p) => { const m = { x:(lastPt.x + p.x) / 2, y:(lastPt.y + p.y) / 2 }; ctx.beginPath(); ctx.moveTo(lastMid.x, lastMid.y); ctx.quadraticCurveTo(lastPt.x, lastPt.y, m.x, m.y); ctx.stroke(); lastMid = m; lastPt = p; };
    canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); drawing = true; hasSig = true; const p = pt(e); lastPt = p; lastMid = p; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + .1, p.y + .1); ctx.stroke(); });
    canvas.addEventListener('pointermove', (e) => { if (!drawing) return; e.preventDefault(); const s = (e.getCoalescedEvents && e.getCoalescedEvents()) || []; for (const ev of (s.length ? s : [e])) drawTo(pt(ev)); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(ev, () => { drawing = false; lastPt = lastMid = null; });
    q('[data-clear]').addEventListener('click', size);
    requestAnimationFrame(size);

    back.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      back.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
      q('[data-pane="device"]').classList.toggle('ws-hide', b.dataset.mode !== 'device');
      q('[data-pane="paper"]').classList.toggle('ws-hide', b.dataset.mode !== 'paper');
      if (b.dataset.mode === 'device') requestAnimationFrame(size);
    }));

    // Agreement text (same for every nativity in the event)
    (agreementCache ? Promise.resolve(agreementCache) : api(`/api/admin/nativities/${ids[0]}/waiver-record`).then((d) => (agreementCache = d.agreement)))
      .then((a) => {
        q('[data-agree]').innerHTML = a.sections.map((s) => s.release
          ? `<div class="release-box"><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></div>`
          : `<h3>${esc(s.title)}</h3><p>${esc(s.text)}</p>`).join('');
        q('[data-ack1t]').textContent = a.releaseAck;
        q('[data-ack2t]').textContent = a.consentText;
      })
      .catch((e) => { q('[data-agree]').textContent = 'Could not load the waiver text. ' + e.message; });

    q('[data-print]').addEventListener('click', () => {
      window.open(`/api/admin/donors/${encodeURIComponent(donorId)}/batch-waiver-pdf?ids=${ids.join(',')}`, '_blank');
    });

    async function submit(body, btn) {
      const label = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const r = await api(`/api/admin/donors/${encodeURIComponent(donorId)}/desk-checkin`, { method:'POST', body:{ ...body, ids, checkIn } });
        close();
        if (onDone) onDone(r);
      } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = label; }
    }
    q('[data-sign]').addEventListener('click', (e) => {
      if (!q('[data-ack1]').checked || !q('[data-ack2]').checked) { alert('The donor needs to check both boxes.'); return; }
      if (!hasSig) { alert('Have the donor sign in the white box.'); return; }
      submit({ method:'device', releaseAccepted:true, electronicSignatureConsent:true, signatureImage: canvas.toDataURL('image/png') }, e.currentTarget);
    });
    q('[data-paper]').addEventListener('click', (e) => {
      if (!confirm(`Confirm ${donorName} signed the printed waiver${items.length > 1 ? ' covering all ' + items.length + ' nativities' : ''}.`)) return;
      submit({ method:'paper' }, e.currentTarget);
    });
  };
})();
